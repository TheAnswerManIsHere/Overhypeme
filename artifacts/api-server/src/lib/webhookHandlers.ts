import type Stripe from "stripe";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { db } from "@workspace/db";
import {
  usersTable,
  membershipHistoryTable,
  subscriptionsTable,
  lifetimeEntitlementsTable,
  stripeProcessedEventsTable,
} from "@workspace/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "./logger";
import { makeGrantDeps, grantLegendaryViaSubscription, grantLegendaryViaOneTimePayment } from "./membershipGrant";
import { notifyAdminsOfDispute } from "./adminNotify";

async function findUserByStripeCustomerId(customerId: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.stripeCustomerId, customerId))
    .limit(1);
  return user ?? null;
}

async function findUserById(userId: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return user ?? null;
}

async function setMembershipTier(userId: string, tier: "unregistered" | "registered" | "legendary") {
  await db.update(usersTable).set({ membershipTier: tier }).where(eq(usersTable.id, userId));
}

async function userHasLifetimeEntitlement(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: lifetimeEntitlementsTable.id })
    .from(lifetimeEntitlementsTable)
    .where(and(
      eq(lifetimeEntitlementsTable.userId, userId),
      eq(lifetimeEntitlementsTable.status, "active"),
    ))
    .limit(1);
  return rows.length > 0;
}

async function userHasActiveSubscription(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(and(
      eq(subscriptionsTable.userId, userId),
      eq(subscriptionsTable.status, "active"),
    ))
    .limit(1);
  return rows.length > 0;
}

async function recordHistory(
  userId: string,
  event: string,
  opts: {
    plan?: string;
    amount?: number;
    currency?: string;
    stripePaymentIntentId?: string;
    stripeSubscriptionId?: string;
    stripeInvoiceId?: string;
    stripeDisputeId?: string;
  } = {},
) {
  await db.insert(membershipHistoryTable).values({
    userId,
    event,
    plan: opts.plan,
    amount: opts.amount,
    currency: opts.currency,
    stripePaymentIntentId: opts.stripePaymentIntentId,
    stripeSubscriptionId: opts.stripeSubscriptionId,
    stripeInvoiceId: opts.stripeInvoiceId,
    stripeDisputeId: opts.stripeDisputeId,
  });
}

// Returns true if the product/price is a recognized membership product.
// Validates via product metadata (membership: "true") OR env allowlist.
// ALWAYS fails closed: if neither allowlist nor metadata tag is present, membership is NOT granted.
async function isMembershipPrice(
  stripe: Stripe,
  priceId: string,
  expandedProduct?: Stripe.Product | null,
): Promise<boolean> {
  try {
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (allowlist.length > 0 && allowlist.includes(priceId)) return true;

    // If an already-expanded product was provided (e.g. embedded in a test event),
    // use it directly to avoid an unnecessary Stripe API call.
    const product = expandedProduct ?? (async () => {
      const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
      return price.product as Stripe.Product | null;
    })();
    const resolvedProduct = product instanceof Promise ? await product : product;

    if (!resolvedProduct || typeof resolvedProduct === "string") return false;

    // Accept ONLY if product metadata explicitly marks it as membership
    const isTagged = resolvedProduct.metadata?.membership === "true";
    if (isTagged) return true;

    // Fail closed: no allowlist entry and no metadata tag → deny
    logger.warn({ priceId }, "Price not in membership allowlist and product has no membership=true metadata — skipping tier grant");
    return false;
  } catch (err) {
    // Fail closed on error
    logger.error({ err, priceId }, "Could not validate membership price — denying");
    return false;
  }
}

async function upsertSubscription(
  userId: string,
  stripeCustomerId: string,
  sub: Stripe.Subscription,
  plan: string,
) {
  // current_period_end exists at runtime even if not in all TS type versions
  const rawSub = sub as unknown as { current_period_end?: number };
  const currentPeriodEnd = rawSub.current_period_end
    ? new Date(rawSub.current_period_end * 1000)
    : null;

  await db
    .insert(subscriptionsTable)
    .values({
      userId,
      stripeSubscriptionId: sub.id,
      stripeCustomerId,
      plan,
      status: sub.status,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    })
    .onConflictDoUpdate({
      target: subscriptionsTable.stripeSubscriptionId,
      set: {
        status: sub.status,
        plan,
        currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      },
    });
}

async function handleSubscriptionActivated(
  stripe: Stripe,
  customerId: string,
  sub: Stripe.Subscription,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) { logger.warn({ customerId }, "No user found for Stripe customer"); return; }

  const priceItem = sub.items?.data?.[0];
  const priceId = priceItem?.price?.id ?? "";
  // Pass the already-expanded product when present to avoid an extra Stripe API call
  // (e.g. when the subscription was embedded in a checkout.session.completed event)
  const expandedProduct = priceItem?.price?.product != null && typeof priceItem.price.product === "object"
    ? (priceItem.price.product as Stripe.Product)
    : null;

  const isAllowed = await isMembershipPrice(stripe, priceId, expandedProduct);
  if (!isAllowed) {
    logger.warn({ priceId, userId: user.id }, "Subscription price not in membership allowlist — skipping tier grant");
    return;
  }

  // Delegate grant + DB writes + history to shared helper (same code path as checkout/confirm).
  await grantLegendaryViaSubscription(
    user.id,
    customerId,
    sub as Stripe.Subscription & { current_period_end?: number },
    makeGrantDeps(),
  );
  logger.info({ userId: user.id }, "User upgraded to legendary via webhook");
}

async function handleSubscriptionCancelled(customerId: string, sub: Stripe.Subscription) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Update app-level subscription record
  await upsertSubscription(user.id, customerId, sub, "cancelled");

  // NEVER downgrade a user with a lifetime entitlement (legendary tier)
  const hasLifetime = await userHasLifetimeEntitlement(user.id);
  if (hasLifetime) {
    logger.info({ userId: user.id }, "Subscription cancelled but user has Legendary for Life — keeping legendary");
    await recordHistory(user.id, "subscription_cancelled", { stripeSubscriptionId: sub.id });
    return;
  }

  await setMembershipTier(user.id, "registered");
  await recordHistory(user.id, "subscription_cancelled", { stripeSubscriptionId: sub.id });
  logger.info({ userId: user.id }, "User reverted to registered (free) after subscription cancel");
}

async function handleInvoicePaid(
  customerId: string,
  invoiceId: string,
  amount: number,
  currency: string,
  subscriptionId?: string,
  paymentIntentId?: string,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Look up plan from our subscriptions table so the history entry has a label
  let plan: string | undefined;
  if (subscriptionId) {
    const [appSub] = await db
      .select({ plan: subscriptionsTable.plan })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.stripeSubscriptionId, subscriptionId))
      .limit(1);
    plan = appSub?.plan ?? undefined;
  }

  await recordHistory(user.id, "invoice_paid", {
    plan,
    amount,
    currency,
    stripeInvoiceId: invoiceId,
    stripeSubscriptionId: subscriptionId,
    stripePaymentIntentId: paymentIntentId,
  });
}

async function handleOneTimePayment(
  _stripe: Stripe,
  customerId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
  metadata: Record<string, string>,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Validate: must be tagged as membership purchase (fail-closed).
  // Checkout sessions tag PI with metadata: { membership: "true", plan: "lifetime" }
  const isTaggedMembership =
    metadata?.membership === "true" || metadata?.plan === "lifetime";

  if (!isTaggedMembership) {
    logger.warn({ paymentIntentId, userId: user.id }, "One-time payment not tagged as membership — skipping Legendary for Life grant");
    return;
  }

  // Delegate grant + idempotency + DB writes + history to shared helper (same code path as checkout/confirm).
  const result = await grantLegendaryViaOneTimePayment(
    user.id,
    customerId,
    { id: paymentIntentId, status: "succeeded", amount, currency },
    makeGrantDeps(),
  );

  if (result === "already_recorded") {
    logger.info({ paymentIntentId }, "Legendary for Life entitlement already recorded — skipping");
  } else {
    logger.info({ userId: user.id }, "User granted Legendary for Life tier via webhook");
  }
}

/**
 * Handle charge.refunded:
 * - If the refunded charge's payment intent matches a lifetime entitlement, mark it refunded
 *   and downgrade the user unless they have another active entitlement.
 * - If the charge is from a subscription invoice, record history only (the subscription
 *   cancellation flow handles downgrades separately).
 */
async function handleChargeRefunded(
  charge: {
    id: string;
    customer: string | { id: string } | null;
    payment_intent: string | { id: string } | null;
    invoice: string | { id: string } | null;
    amount_refunded: number;
    currency: string;
  },
): Promise<void> {
  const customerId = charge.customer
    ? (typeof charge.customer === "string" ? charge.customer : charge.customer.id)
    : null;
  if (!customerId) {
    logger.warn({ chargeId: charge.id }, "charge.refunded has no customer — skipping");
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    logger.warn({ customerId }, "charge.refunded: no user found for Stripe customer");
    return;
  }

  const paymentIntentId = charge.payment_intent
    ? (typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id)
    : null;

  const isSubscriptionInvoice = charge.invoice !== null && charge.invoice !== undefined;

  if (paymentIntentId && !isSubscriptionInvoice) {
    // Check if this is a lifetime purchase payment intent
    const [entitlement] = await db
      .select()
      .from(lifetimeEntitlementsTable)
      .where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (entitlement) {
      // Mark the lifetime entitlement as refunded
      await db
        .update(lifetimeEntitlementsTable)
        .set({ status: "refunded" })
        .where(eq(lifetimeEntitlementsTable.id, entitlement.id));

      // Downgrade only if the user has no other active entitlement
      const hasOtherLifetime = await userHasLifetimeEntitlement(user.id);
      const hasActiveSub = await userHasActiveSubscription(user.id);
      if (!hasOtherLifetime && !hasActiveSub) {
        await setMembershipTier(user.id, "registered");
        logger.info({ userId: user.id, paymentIntentId }, "Lifetime entitlement refunded — user downgraded to registered");
      } else {
        logger.info({ userId: user.id, paymentIntentId }, "Lifetime entitlement refunded but user has other active entitlement — keeping legendary");
      }

      await recordHistory(user.id, "refund", {
        plan: "lifetime",
        amount: charge.amount_refunded,
        currency: charge.currency,
        stripePaymentIntentId: paymentIntentId,
      });
      return;
    }
  }

  // Subscription invoice refund or unrecognized charge — record audit trail only
  const invoiceId = charge.invoice
    ? (typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id)
    : undefined;
  await recordHistory(user.id, "refund", {
    amount: charge.amount_refunded,
    currency: charge.currency,
    stripePaymentIntentId: paymentIntentId ?? undefined,
    stripeInvoiceId: invoiceId,
  });
  logger.info({ userId: user.id, chargeId: charge.id, isSubscriptionInvoice }, "charge.refunded: recorded history (no tier change)");
}

/**
 * Resolve the user for a disputed charge by trying three escalating lookups:
 *   1. payment_intent → lifetime_entitlements (covers lifetime purchases)
 *   2. payment_intent → membership_history (covers subscription invoice PIs recorded at invoice.paid)
 *   3. Stripe API: retrieve charge → customer ID → usersTable (covers any remaining case)
 * Returns null if the user cannot be resolved.
 */
async function resolveUserForDispute(
  stripe: Stripe,
  paymentIntentId: string | null,
  chargeId: string,
): Promise<{ user: Awaited<ReturnType<typeof findUserByStripeCustomerId>>; } | null> {
  // 1. Lifetime entitlement lookup
  if (paymentIntentId) {
    const [entitlement] = await db
      .select({ userId: lifetimeEntitlementsTable.userId })
      .from(lifetimeEntitlementsTable)
      .where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (entitlement) {
      const user = await findUserById(entitlement.userId);
      if (user) return { user };
    }
  }

  // 2. Membership history lookup (covers subscription invoice payment intents recorded at invoice.paid)
  if (paymentIntentId) {
    const [historyRow] = await db
      .select({ userId: membershipHistoryTable.userId })
      .from(membershipHistoryTable)
      .where(eq(membershipHistoryTable.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (historyRow) {
      const user = await findUserById(historyRow.userId);
      if (user) return { user };
    }
  }

  // 3. Stripe API: retrieve charge to get the customer, then look up user
  try {
    const charge = await stripe.charges.retrieve(chargeId);
    const customerId = charge.customer
      ? (typeof charge.customer === "string" ? charge.customer : charge.customer.id)
      : null;
    if (customerId) {
      const user = await findUserByStripeCustomerId(customerId);
      if (user) return { user };
    }
  } catch (err) {
    logger.warn({ err, chargeId }, "dispute: could not retrieve charge from Stripe for customer lookup");
  }

  return null;
}

/**
 * Handle charge.dispute.created:
 * Immediately revoke Legendary for the user associated with the disputed charge.
 * Disputes can take weeks to resolve; we don't give paid features to users actively
 * chargebacking us.
 */
async function handleDisputeCreated(
  stripe: Stripe,
  dispute: {
    id: string;
    charge: string | { id: string };
    payment_intent: string | { id: string } | null;
    amount: number;
    currency: string;
    livemode?: boolean;
  },
): Promise<void> {
  const paymentIntentId = dispute.payment_intent
    ? (typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent.id)
    : null;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

  // Fire-and-forget admin alert. We send this regardless of whether we can resolve
  // the user — Stripe's response window is short and the operator needs to know
  // immediately so they can gather evidence and respond in the dashboard.
  void notifyAdminsOfDispute({
    kind: "created",
    disputeId: dispute.id,
    amount: dispute.amount,
    currency: dispute.currency,
    livemode: dispute.livemode === true,
  });

  const resolved = await resolveUserForDispute(stripe, paymentIntentId, chargeId);
  if (!resolved) {
    logger.warn({ disputeId: dispute.id, chargeId }, "dispute.created: could not resolve user — skipping tier change");
    return;
  }

  const { user } = resolved;
  await setMembershipTier(user.id, "registered");
  await recordHistory(user.id, "dispute_opened", {
    amount: dispute.amount,
    currency: dispute.currency,
    stripePaymentIntentId: paymentIntentId ?? undefined,
    stripeDisputeId: dispute.id,
  });
  logger.info({ userId: user.id, disputeId: dispute.id }, "Dispute opened — user immediately revoked from legendary");
}

/**
 * Handle charge.dispute.closed:
 * - won: re-grant Legendary if the user still has an active entitlement.
 * - lost: keep at registered, also mark any related lifetime entitlement as refunded.
 * - warning_closed / other: record history, no tier change.
 */
async function handleDisputeClosed(
  stripe: Stripe,
  dispute: {
    id: string;
    charge: string | { id: string };
    payment_intent: string | { id: string } | null;
    status: string;
    amount: number;
    currency: string;
  },
): Promise<void> {
  const paymentIntentId = dispute.payment_intent
    ? (typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent.id)
    : null;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

  // Resolve user via the same three-level lookup used in handleDisputeCreated
  const resolved = await resolveUserForDispute(stripe, paymentIntentId, chargeId);
  if (!resolved) {
    logger.info({ disputeId: dispute.id, status: dispute.status }, "dispute.closed: could not resolve user — skipping tier change");
    return;
  }
  const { user } = resolved;

  // Also check if there's a lifetime entitlement for this PI (for marking as refunded on loss)
  let entitlementId: number | null = null;
  if (paymentIntentId) {
    const [entitlement] = await db
      .select({ id: lifetimeEntitlementsTable.id })
      .from(lifetimeEntitlementsTable)
      .where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (entitlement) entitlementId = entitlement.id;
  }

  if (dispute.status === "won") {
    // Re-grant legendary if the user still has an active entitlement
    const hasLifetime = await userHasLifetimeEntitlement(user.id);
    const hasActiveSub = await userHasActiveSubscription(user.id);
    if (hasLifetime || hasActiveSub) {
      await setMembershipTier(user.id, "legendary");
      logger.info({ userId: user.id, disputeId: dispute.id }, "Dispute won — user re-granted legendary");
    } else {
      logger.info({ userId: user.id, disputeId: dispute.id }, "Dispute won but no active entitlement found — not re-granting legendary");
    }
    await recordHistory(user.id, "dispute_won", {
      amount: dispute.amount,
      currency: dispute.currency,
      stripePaymentIntentId: paymentIntentId ?? undefined,
      stripeDisputeId: dispute.id,
    });
  } else if (dispute.status === "lost") {
    // Explicitly revoke Legendary — idempotent if dispute.created already fired,
    // but also handles the case where dispute.created was missed/failed.
    await setMembershipTier(user.id, "registered");
    // Also mark lifetime entitlement as refunded if applicable
    if (entitlementId !== null) {
      await db
        .update(lifetimeEntitlementsTable)
        .set({ status: "refunded" })
        .where(eq(lifetimeEntitlementsTable.id, entitlementId));
    }
    await recordHistory(user.id, "dispute_lost", {
      amount: dispute.amount,
      currency: dispute.currency,
      stripePaymentIntentId: paymentIntentId ?? undefined,
      stripeDisputeId: dispute.id,
    });
    logger.info({ userId: user.id, disputeId: dispute.id }, "Dispute lost — user revoked to registered, entitlement marked refunded");
  } else {
    // warning_closed or other terminal non-won/non-lost statuses — record only
    await recordHistory(user.id, "dispute_closed", {
      amount: dispute.amount,
      currency: dispute.currency,
      stripePaymentIntentId: paymentIntentId ?? undefined,
      stripeDisputeId: dispute.id,
    });
    logger.info({ userId: user.id, disputeId: dispute.id, status: dispute.status }, "Dispute closed with non-win/non-loss status — no tier change");
  }
}

/** Shared domain-logic event processor used by both processWebhook and processEventDirectly */
async function processDomainSwitch(stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      // When a checkout completes with a subscription, the embedded subscription object
      // carries the membership grant. We process it as a subscription activation.
      const session = event.data.object as unknown as {
        customer: string | null;
        mode?: string;
        subscription?: string | { id: string; status?: string; items?: Stripe.Subscription["items"]; cancel_at_period_end?: boolean } | null;
        payment_intent?: string | null;
        amount_total?: number | null;
        currency?: string | null;
        metadata?: Record<string, string>;
      };
      const customerId = session.customer;
      const metadataUserId = session.metadata?.userId;

      // Safety net: if the Stripe customer isn't yet linked to a user in our DB,
      // use metadata.userId (set during checkout session creation) to link them.
      if (customerId && metadataUserId) {
        const existingUser = await findUserByStripeCustomerId(customerId);
        if (!existingUser) {
          const userById = await findUserById(metadataUserId);
          if (userById) {
            await db.update(usersTable)
              .set({ stripeCustomerId: customerId })
              .where(eq(usersTable.id, metadataUserId));
            logger.info({ customerId, userId: metadataUserId }, "Linked Stripe customer to user via metadata.userId");
          }
        }
      }

      if (!customerId) break;

      if (session.mode === "subscription" && session.subscription) {
        // Subscription checkout — load or use embedded sub object
        let sub: Stripe.Subscription;
        if (typeof session.subscription === "string") {
          sub = await stripe.subscriptions.retrieve(session.subscription, { expand: ["items.data.price.product"] });
        } else {
          sub = session.subscription as unknown as Stripe.Subscription;
        }
        if (sub.status === "active" || sub.status === "trialing") {
          await handleSubscriptionActivated(stripe, customerId, sub);
        }
      } else if (session.mode === "payment" && session.payment_intent) {
        // One-time payment checkout (lifetime)
        const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent;
        const pi = await stripe.paymentIntents.retrieve(piId as string);
        await handleOneTimePayment(stripe, customerId, pi.id, pi.amount, pi.currency, pi.metadata ?? {});
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      if (sub.status === "active" || sub.status === "trialing") {
        await handleSubscriptionActivated(stripe, customerId, sub);
      } else if (sub.status === "canceled") {
        await handleSubscriptionCancelled(customerId, sub);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      await handleSubscriptionCancelled(customerId, sub);
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as unknown as {
        id: string; customer: string | { id: string }; amount_paid: number; currency: string;
        subscription?: string | { id: string } | null;
        payment_intent?: string | { id: string } | null;
      };
      await handleInvoicePaid(
        typeof inv.customer === "string" ? inv.customer : inv.customer.id,
        inv.id,
        inv.amount_paid,
        inv.currency,
        inv.subscription ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id) : undefined,
        inv.payment_intent ? (typeof inv.payment_intent === "string" ? inv.payment_intent : inv.payment_intent.id) : undefined,
      );
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as unknown as {
        id: string; customer: string | { id: string };
        subscription?: string | { id: string } | null;
        amount_due?: number; currency?: string;
      };
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer.id;
      const user = await findUserByStripeCustomerId(customerId);
      if (user) {
        const subscriptionId = inv.subscription
          ? (typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id)
          : undefined;
        await recordHistory(user.id, "payment_failed", {
          amount: inv.amount_due,
          currency: inv.currency,
          stripeInvoiceId: inv.id,
          stripeSubscriptionId: subscriptionId,
        });
        if (subscriptionId) {
          await db
            .update(subscriptionsTable)
            .set({ status: "past_due" })
            .where(eq(subscriptionsTable.stripeSubscriptionId, subscriptionId));
        }
        logger.warn({ userId: user.id, invoiceId: inv.id }, "Payment failed — subscription marked past_due");
      }
      break;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as unknown as {
        id: string; customer: string | { id: string } | null; amount: number; currency: string;
        invoice?: string | null; metadata?: Record<string, string>;
      };
      if (pi.customer && !pi.invoice) {
        const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer.id;
        await handleOneTimePayment(stripe, customerId, pi.id, pi.amount, pi.currency, pi.metadata ?? {});
      }
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as unknown as {
        id: string;
        customer: string | { id: string } | null;
        payment_intent: string | { id: string } | null;
        invoice: string | { id: string } | null;
        amount_refunded: number;
        currency: string;
      };
      await handleChargeRefunded(charge);
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as unknown as {
        id: string;
        charge: string | { id: string };
        payment_intent: string | { id: string } | null;
        status: string;
        amount: number;
        currency: string;
        livemode?: boolean;
      };
      // Fall back to the event-level livemode flag if the dispute object omits it
      // (e.g. minimal test fixtures), so the admin alert links to the correct dashboard.
      await handleDisputeCreated(stripe, { ...dispute, livemode: dispute.livemode ?? event.livemode });
      break;
    }
    case "charge.dispute.closed": {
      const dispute = event.data.object as unknown as {
        id: string;
        charge: string | { id: string };
        payment_intent: string | { id: string } | null;
        status: string;
        amount: number;
        currency: string;
      };
      await handleDisputeClosed(stripe, dispute);
      break;
    }
    case "charge.dispute.updated": {
      // Only fire admin alert when the evidence deadline is approaching (< 48h)
      // AND the dispute is still in an actionable state. Stripe sends this event
      // for many reasons (evidence updates, status transitions, etc) so the
      // narrow predicate avoids spamming admins for every change.
      const dispute = event.data.object as unknown as {
        id: string;
        status: string;
        amount: number;
        currency: string;
        livemode?: boolean;
        evidence_details?: { due_by?: number | null } | null;
      };
      const dueBy = dispute.evidence_details?.due_by ?? null;
      const isActionable = dispute.status === "needs_response" || dispute.status === "warning_needs_response";
      if (dueBy != null && isActionable) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secondsUntilDue = dueBy - nowSec;
        const hoursUntilDue = secondsUntilDue / 3600;
        if (hoursUntilDue > 0 && hoursUntilDue < 48) {
          // Round up so a deadline 30 minutes out reads as "1 hour" rather than
          // "0 hours" — operators need a non-zero urgency cue in the subject line.
          const ceiledHours = Math.max(1, Math.ceil(hoursUntilDue));
          void notifyAdminsOfDispute({
            kind: "deadline_approaching",
            disputeId: dispute.id,
            amount: dispute.amount,
            currency: dispute.currency,
            livemode: dispute.livemode ?? event.livemode,
            hoursUntilDue: ceiledHours,
          });
        }
      }
      break;
    }
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const dispute = event.data.object as unknown as {
        id: string;
        amount: number;
        currency: string;
        livemode?: boolean;
      };
      void notifyAdminsOfDispute({
        kind: event.type === "charge.dispute.funds_withdrawn" ? "funds_withdrawn" : "funds_reinstated",
        disputeId: dispute.id,
        amount: dispute.amount,
        currency: dispute.currency,
        livemode: dispute.livemode ?? event.livemode,
      });
      break;
    }
    default:
      break;
  }
}

export class WebhookHandlers {
  /**
   * Process a pre-constructed Stripe event object directly through the domain event switch,
   * skipping Stripe sync and signature verification. For use in test mode QA only.
   * The caller is responsible for ensuring the event is well-formed and only used in test mode.
   */
  static async processEventDirectly(event: Stripe.Event): Promise<void> {
    const stripe = await getUncachableStripeClient();
    try {
      await processDomainSwitch(stripe, event);
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Test domain event handler error");
      throw err;
    }
  }

  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    // Phase 1: Pass to stripe-replit-sync for data sync AND signature verification.
    // sync.processWebhook verifies the signature using the integration's managed signing
    // secret and throws on any invalid/forged event. After this line succeeds, the event
    // is guaranteed authentic — no second verification pass is needed or correct (the
    // integration manages its own signing secret, separate from STRIPE_WEBHOOK_SECRET).
    const sync = await getStripeSync();
    try {
      await sync.processWebhook(payload, signature);
    } catch (sigErr) {
      // Best-effort: pull the event id out of the (untrusted) payload so the
      // log line is correlatable with Stripe's dashboard even though we
      // rejected the event. Falls back to undefined if the body isn't JSON.
      let eventIdGuess: string | undefined;
      try {
        const parsed = JSON.parse(payload.toString()) as { id?: unknown };
        if (typeof parsed?.id === "string") eventIdGuess = parsed.id;
      } catch { /* non-JSON payload — skip */ }
      const message = sigErr instanceof Error ? sigErr.message : String(sigErr);
      let reason = "unknown error during signature verification";
      if (/signature/i.test(message)) {
        reason = "Stripe signature verification failed (signing secret mismatch or tampered payload)";
      } else if (/secret/i.test(message)) {
        reason = "Stripe webhook signing secret is missing or unreadable";
      } else if (/timestamp/i.test(message)) {
        reason = "Stripe webhook timestamp outside tolerance window";
      }
      logger.warn(
        { err: sigErr, eventId: eventIdGuess, reason },
        "Stripe webhook rejected before domain processing",
      );
      throw sigErr;
    }

    // Phase 2: Acquire the Stripe client for domain processing.
    // If credentials are unavailable, skip domain logic — the sync already persisted
    // the event data to stripe.* tables so nothing is lost.
    let stripe: Stripe | null = null;
    try {
      stripe = await getUncachableStripeClient();
    } catch (credErr) {
      logger.warn({ err: credErr }, "Stripe credentials unavailable — skipping domain event processing");
      return;
    }

    // Phase 3: Parse the verified payload as a typed Stripe event.
    // The payload is authentic (verified by the sync above); parse it for domain logic.
    let event: Stripe.Event;
    try {
      event = JSON.parse(payload.toString()) as Stripe.Event;
    } catch (parseErr) {
      logger.error({ err: parseErr }, "Failed to parse webhook event payload");
      return;
    }

    // Idempotency guard: skip events already processed (handles Stripe retries)
    try {
      await db.insert(stripeProcessedEventsTable).values({ eventId: event.id });
    } catch (err) {
      const isUniqueViolation = err instanceof Error &&
        ((err as unknown as { code?: string }).code === "23505" || err.message.toLowerCase().includes("unique"));
      if (isUniqueViolation) {
        logger.info({ eventId: event.id, eventType: event.type }, "Webhook event already processed — skipping (idempotency)");
        return;
      }
      // On other DB errors, log but continue so Stripe doesn't retry endlessly
      logger.warn({ err, eventId: event.id }, "Idempotency insert failed — proceeding with event processing");
    }

    // Process domain-specific logic via shared switch
    // At this point stripe is guaranteed non-null: either we successfully acquired it
    // in phase 1, or we returned early in the degraded-mode branch above.
    try {
      await processDomainSwitch(stripe!, event);
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Webhook domain handler error");
    }
  }
}
