import type Stripe from "stripe";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { db } from "@workspace/db";
import { usersTable, membershipHistoryTable } from "@workspace/db/schema";
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

async function handleSubscriptionActivated(
  customerId: string,
  subscriptionId: string,
  interval?: string,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) { logger.warn({ customerId }, "No user found for Stripe customer"); return; }
  await setMembershipTier(user.id, "premium");
  await recordHistory(user.id, "subscription_activated", {
    plan: interval ?? "monthly",
    stripeSubscriptionId: subscriptionId,
  });
  logger.info({ userId: user.id }, "User upgraded to premium");
}

async function handleSubscriptionCancelled(customerId: string, subscriptionId: string) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;
  await setMembershipTier(user.id, "free");
  await recordHistory(user.id, "subscription_cancelled", { stripeSubscriptionId: subscriptionId });
  logger.info({ userId: user.id }, "User downgraded to free");
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
  customerId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
) {
  const user = await findUserByStripeCustomerId(customerId);
  if (!user) return;
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
    try {
      const stripe = await getUncachableStripeClient();
      // Get the webhook secret from sync or fall back to env
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (webhookSecret) {
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      } else {
        // Parse without verification (sync already verified it)
        event = JSON.parse(payload.toString()) as Stripe.Event;
      }
    } catch (err) {
      // If we can't parse the event, just parse it raw
      try {
        event = JSON.parse(payload.toString()) as Stripe.Event;
      } catch {
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
          if (sub.status === "active" || sub.status === "trialing") {
            const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
            await handleSubscriptionActivated(
              typeof sub.customer === "string" ? sub.customer : sub.customer.id,
              sub.id,
              interval,
            );
          } else if (sub.status === "canceled") {
            await handleSubscriptionCancelled(
              typeof sub.customer === "string" ? sub.customer : sub.customer.id,
              sub.id,
            );
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          await handleSubscriptionCancelled(
            typeof sub.customer === "string" ? sub.customer : sub.customer.id,
            sub.id,
          );
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
            invoice?: string | null;
          };
          if (pi.customer && !pi.invoice) {
            const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer.id;
            await handleOneTimePayment(customerId, pi.id, pi.amount, pi.currency);
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
