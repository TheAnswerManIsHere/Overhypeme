/**
 * Shared membership-grant helpers used by both the synchronous checkout/confirm
 * endpoint (Profile.tsx redirect flow) and the Stripe webhook handlers.
 *
 * All public functions accept explicit dependency objects so the business logic
 * can be exercised in unit tests without module mocking — callers pass fake
 * deps, production callers use `makeGrantDeps()`.
 */

import type Stripe from "stripe";
import { db } from "@workspace/db";
import {
  usersTable,
  subscriptionsTable,
  lifetimeEntitlementsTable,
  membershipHistoryTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

// ── Dependency interface ─────────────────────────────────────────────────────

export interface GrantDeps {
  /** Returns any existing subscription row for the given Stripe subscription ID. */
  getSubscriptionBySubId(subId: string): Promise<{ id: number } | null>;

  upsertSubscriptionRow(
    userId: string,
    customerId: string,
    subId: string,
    status: string,
    plan: string,
    currentPeriodEnd: Date | null,
    cancelAtPeriodEnd: boolean,
  ): Promise<void>;

  getLifetimeByPaymentIntentId(piId: string): Promise<{ id: number } | null>;

  insertLifetimeEntitlementRow(
    userId: string,
    customerId: string,
    piId: string,
    amount: number,
    currency: string,
  ): Promise<void>;

  setMembershipTierToLegendary(userId: string): Promise<void>;

  recordMembershipHistory(
    userId: string,
    event: string,
    opts?: {
      plan?: string;
      amount?: number;
      currency?: string;
      stripePaymentIntentId?: string;
      stripeSubscriptionId?: string;
      stripeInvoiceId?: string;
    },
  ): Promise<void>;
}

// ── Minimal Stripe retriever interface (injectable for tests) ────────────────

export type CheckoutSession = Stripe.Checkout.Session & {
  subscription?: (Stripe.Subscription & { current_period_end?: number }) | null;
  payment_intent?: Stripe.PaymentIntent | null;
};

/**
 * Minimal retriever interface — returns `Promise<unknown>` so that both the
 * real `Stripe` SDK client AND test fakes (which return `Promise<CheckoutSession>`)
 * satisfy this interface without extra casts in the caller.
 */
export interface CheckoutSessionRetriever {
  checkout: {
    sessions: {
      retrieve(id: string, params?: { expand?: string[] }): Promise<unknown>;
    };
  };
}

// ── Real dependencies (production) ──────────────────────────────────────────

export function makeGrantDeps(): GrantDeps {
  return {
    async getSubscriptionBySubId(subId) {
      const [row] = await db
        .select({ id: subscriptionsTable.id })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.stripeSubscriptionId, subId))
        .limit(1);
      return row ?? null;
    },

    async upsertSubscriptionRow(userId, customerId, subId, status, plan, currentPeriodEnd, cancelAtPeriodEnd) {
      await db
        .insert(subscriptionsTable)
        .values({
          userId,
          stripeSubscriptionId: subId,
          stripeCustomerId: customerId,
          plan,
          status,
          currentPeriodEnd,
          cancelAtPeriodEnd,
        })
        .onConflictDoUpdate({
          target: subscriptionsTable.stripeSubscriptionId,
          set: {
            status,
            plan,
            currentPeriodEnd,
            cancelAtPeriodEnd,
            updatedAt: new Date(),
          },
        });
    },

    async getLifetimeByPaymentIntentId(piId) {
      const [row] = await db
        .select({ id: lifetimeEntitlementsTable.id })
        .from(lifetimeEntitlementsTable)
        .where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, piId))
        .limit(1);
      return row ?? null;
    },

    async insertLifetimeEntitlementRow(userId, customerId, piId, amount, currency) {
      await db.insert(lifetimeEntitlementsTable).values({
        userId,
        stripePaymentIntentId: piId,
        stripeCustomerId: customerId,
        amount,
        currency,
      });
    },

    async setMembershipTierToLegendary(userId) {
      await db.update(usersTable).set({ membershipTier: "legendary" }).where(eq(usersTable.id, userId));
    },

    async recordMembershipHistory(userId, event, opts = {}) {
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
    },
  };
}

// ── Subscription grant ───────────────────────────────────────────────────────

/**
 * Grant legendary tier via a verified Stripe subscription.
 *
 * Idempotent: if a subscription row for `sub.id` already exists, the upsert is
 * a no-op (via `onConflictDoUpdate`), the tier update is a no-op (already legendary),
 * and the history entry is skipped (to avoid duplicate rows when both the sync
 * confirm endpoint AND the webhook both call this for the same subscription).
 *
 * @returns "granted" on fresh grant, "already_recorded" when row pre-exists.
 * Throws with `httpStatus: 400` on invalid subscription state.
 */
export async function grantLegendaryViaSubscription(
  userId: string,
  customerId: string,
  sub: Stripe.Subscription & { current_period_end?: number },
  deps: GrantDeps,
): Promise<"granted" | "already_recorded"> {
  if (!sub || !["active", "trialing"].includes(sub.status)) {
    throw Object.assign(new Error("Subscription is not active"), { httpStatus: 400 });
  }

  const interval = (sub.items?.data?.[0]?.price as Stripe.Price | undefined)?.recurring?.interval;
  const plan = interval === "year" ? "annual" : "monthly";
  const currentPeriodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  // Check BEFORE upsert: if row already exists, this is an idempotent re-call
  // (e.g. webhook fires after the sync confirm endpoint already ran).
  const existingRow = await deps.getSubscriptionBySubId(sub.id);

  await deps.upsertSubscriptionRow(
    userId,
    customerId,
    sub.id,
    sub.status,
    plan,
    currentPeriodEnd,
    sub.cancel_at_period_end ?? false,
  );

  await deps.setMembershipTierToLegendary(userId);

  if (existingRow) {
    // Row already existed: tier update above is a no-op. Skip history to avoid
    // duplicate "subscription_activated" entries when confirm + webhook both fire.
    return "already_recorded";
  }

  await deps.recordMembershipHistory(userId, "subscription_activated", {
    plan,
    stripeSubscriptionId: sub.id,
  });

  return "granted";
}

// ── Lifetime (one-time) payment grant ────────────────────────────────────────

/**
 * Grant legendary tier via a verified Stripe one-time payment.
 *
 * Idempotent: if the payment intent row already exists, skips the insert and
 * history write but still applies `setMembershipTierToLegendary` (in case the
 * user's tier was reverted by a bug and they're re-confirming).
 *
 * @returns "granted" on fresh grant, "already_recorded" when row pre-exists.
 * Throws with `httpStatus: 400` when `pi.status !== "succeeded"`.
 */
export async function grantLegendaryViaOneTimePayment(
  userId: string,
  customerId: string,
  pi: Pick<Stripe.PaymentIntent, "id" | "status" | "amount" | "currency">,
  deps: GrantDeps,
): Promise<"granted" | "already_recorded"> {
  if (pi.status !== "succeeded") {
    throw Object.assign(new Error("Payment not succeeded"), { httpStatus: 400 });
  }

  const existing = await deps.getLifetimeByPaymentIntentId(pi.id);
  if (existing) {
    await deps.setMembershipTierToLegendary(userId);
    return "already_recorded";
  }

  await deps.insertLifetimeEntitlementRow(userId, customerId, pi.id, pi.amount, pi.currency);
  await deps.setMembershipTierToLegendary(userId);
  await deps.recordMembershipHistory(userId, "lifetime_purchase", {
    plan: "lifetime",
    amount: pi.amount,
    currency: pi.currency,
    stripePaymentIntentId: pi.id,
  });

  return "granted";
}

// ── Confirm endpoint logic (pure, injectable, fully testable) ────────────────

export type ConfirmSuccess = { tier: "legendary"; source: "confirm"; result: "granted" | "already_recorded" };
export type ConfirmError = { httpStatus: number; error: string };
export type ConfirmResult = ConfirmSuccess | ConfirmError;

/**
 * Core logic for POST /stripe/checkout/confirm.
 *
 * Accepts injectable Stripe retriever and GrantDeps so the full request flow
 * (session retrieval → ownership check → grant) can be unit-tested without
 * any module mocking.
 */
export async function handleConfirmRequest(opts: {
  userId: string;
  userStripeCustomerId: string | null;
  sessionId: string;
  stripe: CheckoutSessionRetriever;
  deps: GrantDeps;
  linkCustomerId: (userId: string, customerId: string) => Promise<void>;
}): Promise<ConfirmResult> {
  const { userId, userStripeCustomerId, sessionId, stripe, deps, linkCustomerId } = opts;

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription", "payment_intent"],
  }) as CheckoutSession;

  const sessionUserId = session.metadata?.userId;
  const sessionCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer as Stripe.Customer | null)?.id ?? null;

  const ownershipOk =
    (sessionUserId != null && sessionUserId === userId) ||
    (sessionCustomerId != null && userStripeCustomerId != null && sessionCustomerId === userStripeCustomerId);

  if (!ownershipOk) {
    return { httpStatus: 403, error: "Session does not belong to this user" };
  }

  // Link Stripe customer to user if not already linked (safety net, same as webhook).
  if (!userStripeCustomerId && sessionCustomerId) {
    await linkCustomerId(userId, sessionCustomerId);
  }
  const customerId = userStripeCustomerId ?? sessionCustomerId ?? "";

  try {
    if (session.mode === "subscription") {
      const sub = session.subscription as (Stripe.Subscription & { current_period_end?: number }) | null;
      if (!sub) return { httpStatus: 400, error: "Subscription not found on session" };
      const result = await grantLegendaryViaSubscription(userId, customerId, sub, deps);
      return { tier: "legendary", source: "confirm", result };

    } else if (session.mode === "payment") {
      if (session.payment_status !== "paid") {
        return { httpStatus: 400, error: "Payment not completed" };
      }
      const pi = session.payment_intent as Stripe.PaymentIntent | null;
      if (!pi) return { httpStatus: 400, error: "Payment intent not found" };
      const result = await grantLegendaryViaOneTimePayment(userId, customerId, pi, deps);
      return { tier: "legendary", source: "confirm", result };

    } else {
      return { httpStatus: 400, error: "Unsupported checkout mode" };
    }
  } catch (err) {
    const httpStatus = (err as Record<string, unknown>).httpStatus;
    if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500) {
      return { httpStatus, error: (err as Error).message };
    }
    throw err; // re-throw unexpected errors for the route handler to catch
  }
}
