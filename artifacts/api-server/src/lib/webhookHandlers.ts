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
import { eq, desc } from "drizzle-orm";
import { logger } from "./logger";

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
    .where(eq(lifetimeEntitlementsTable.userId, userId))
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

  const existing = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.stripeSubscriptionId, sub.id))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(subscriptionsTable)
      .set({
        status: sub.status,
        plan,
        currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      })
      .where(eq(subscriptionsTable.stripeSubscriptionId, sub.id));
  } else {
    await db.insert(subscriptionsTable).values({
      userId,
      stripeSubscriptionId: sub.id,
      stripeCustomerId,
      plan,
      status: sub.status,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    });
  }
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
  const interval = priceItem?.price?.recurring?.interval;
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

  const plan = interval === "year" ? "annual" : "monthly";
  await upsertSubscription(user.id, customerId, sub, plan);
  await setMembershipTier(user.id, "legendary");
  await recordHistory(user.id, "subscription_activated", {
    plan,
    stripeSubscriptionId: sub.id,
  });
  logger.info({ userId: user.id, plan }, "User upgraded to legendary");
}

async function handleSubscriptionCancelled(customerId: string, sub: Stripe.Subscription) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Update app-level subscription record
  await upsertSubscription(user.id, customerId, sub, "cancelled");

  // NEVER downgrade a user with a lifetime entitlement (legendary tier)
  const hasLifetime = await userHasLifetimeEntitlement(user.id);
  if (hasLifetime) {
    logger.info({ userId: user.id }, "Subscription cancelled but user has lifetime — keeping legendary");
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
  await recordHistory(user.id, "invoice_paid", {
    amount,
    currency,
    stripeInvoiceId: invoiceId,
    stripeSubscriptionId: subscriptionId,
    stripePaymentIntentId: paymentIntentId,
  });
}

async function handleOneTimePayment(
  stripe: Stripe,
  customerId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
  metadata: Record<string, string>,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Validate: must be tagged as membership purchase (fail-closed)
  // Checkout sessions tag PI with metadata: { membership: "true", plan: "lifetime" }
  const isTaggedMembership =
    metadata?.membership === "true" || metadata?.plan === "lifetime";

  if (!isTaggedMembership) {
    logger.warn({ paymentIntentId, userId: user.id }, "One-time payment not tagged as membership — skipping lifetime grant");
    return;
  }

  // Check idempotency: skip if already recorded
  const existing = await db
    .select({ id: lifetimeEntitlementsTable.id })
    .from(lifetimeEntitlementsTable)
    .where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  if (existing.length > 0) {
    logger.info({ paymentIntentId }, "Lifetime entitlement already recorded — skipping");
    return;
  }

  // Record durable lifetime entitlement
  await db.insert(lifetimeEntitlementsTable).values({
    userId: user.id,
    stripePaymentIntentId: paymentIntentId,
    stripeCustomerId: customerId,
    amount,
    currency,
  });

  await setMembershipTier(user.id, "legendary");
  await recordHistory(user.id, "lifetime_purchase", {
    plan: "lifetime",
    amount,
    currency,
    stripePaymentIntentId: paymentIntentId,
  });
  logger.info({ userId: user.id }, "User granted legendary lifetime tier");
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

    // First, pass to stripe-replit-sync for data sync
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // Parse the event ourselves for domain logic
    let event: Stripe.Event;
    let stripe: Stripe;
    try {
      stripe = await getUncachableStripeClient();
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (webhookSecret) {
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      } else {
        event = JSON.parse(payload.toString()) as Stripe.Event;
      }
    } catch {
      try {
        event = JSON.parse(payload.toString()) as Stripe.Event;
        stripe = await getUncachableStripeClient();
      } catch (err) {
        logger.error({ err }, "Failed to parse webhook event");
        return;
      }
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
    try {
      await processDomainSwitch(stripe, event);
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Webhook domain handler error");
    }
  }
}
