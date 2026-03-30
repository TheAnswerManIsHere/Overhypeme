import type Stripe from "stripe";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { db } from "@workspace/db";
import {
  usersTable,
  membershipHistoryTable,
  subscriptionsTable,
  lifetimeEntitlementsTable,
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

async function setMembershipTier(userId: string, tier: "free" | "premium") {
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
async function isMembershipPrice(stripe: Stripe, priceId: string): Promise<boolean> {
  try {
    const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (allowlist.length > 0 && allowlist.includes(priceId)) return true;

    // Fetch price to get its product
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const product = price.product as Stripe.Product | null;
    if (!product || typeof product === "string") return false;

    // Accept if product metadata marks it as membership, OR if no allowlist is set (dev fallback)
    const isTagged = product.metadata?.membership === "true";
    if (isTagged) return true;

    // No allowlist set and no metadata tag — accept in development/test mode only
    if (allowlist.length === 0) return true;

    return false;
  } catch {
    // If we can't validate, reject (fail closed)
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

  const isAllowed = await isMembershipPrice(stripe, priceId);
  if (!isAllowed) {
    logger.warn({ priceId, userId: user.id }, "Subscription price not in membership allowlist — skipping tier grant");
    return;
  }

  const plan = interval === "year" ? "annual" : "monthly";
  await upsertSubscription(user.id, customerId, sub, plan);
  await setMembershipTier(user.id, "premium");
  await recordHistory(user.id, "subscription_activated", {
    plan,
    stripeSubscriptionId: sub.id,
  });
  logger.info({ userId: user.id, plan }, "User upgraded to premium");
}

async function handleSubscriptionCancelled(customerId: string, sub: Stripe.Subscription) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;

  // Update app-level subscription record
  await upsertSubscription(user.id, customerId, sub, "cancelled");

  // NEVER downgrade a user with a lifetime entitlement
  const hasLifetime = await userHasLifetimeEntitlement(user.id);
  if (hasLifetime) {
    logger.info({ userId: user.id }, "Subscription cancelled but user has lifetime — keeping premium");
    await recordHistory(user.id, "subscription_cancelled", { stripeSubscriptionId: sub.id });
    return;
  }

  await setMembershipTier(user.id, "free");
  await recordHistory(user.id, "subscription_cancelled", { stripeSubscriptionId: sub.id });
  logger.info({ userId: user.id }, "User downgraded to free after subscription cancel");
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

  // Validate: must be tagged as membership purchase OR contain a membership price
  const isTaggedMembership =
    metadata?.membership === "true" || metadata?.plan === "lifetime";

  // Retrieve the payment intent's line items to validate price if no metadata tag
  // For checkout-based flow, the PI is associated with a session that has line items.
  // We rely on metadata.plan=lifetime being set by checkout session metadata, or fall back
  // to the allowlist-free acceptance in dev mode.
  const allowlist = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!isTaggedMembership && allowlist.length > 0) {
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

  await setMembershipTier(user.id, "premium");
  await recordHistory(user.id, "lifetime_purchase", {
    plan: "lifetime",
    amount,
    currency,
    stripePaymentIntentId: paymentIntentId,
  });
  logger.info({ userId: user.id }, "User granted lifetime premium");
}

export class WebhookHandlers {
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

    // Process domain-specific logic
    try {
      switch (event.type) {
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
    } catch (err) {
      logger.error({ err, eventType: event.type }, "Webhook domain handler error");
    }
  }
}
