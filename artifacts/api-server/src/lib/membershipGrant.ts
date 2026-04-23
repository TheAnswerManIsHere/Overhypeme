/**
 * Shared membership-grant helpers used by both the synchronous checkout/confirm
 * endpoint (Profile.tsx redirect flow) and the Stripe webhook handlers.
 *
 * Functions accept an explicit `GrantDeps` object so the business logic can be
 * exercised in unit tests without module mocking — callers pass fake deps,
 * production callers use `makeGrantDeps()`.
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

// ── Real dependencies (production) ──────────────────────────────────────────

export function makeGrantDeps(): GrantDeps {
  return {
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
 * @returns "granted" on fresh grant, "already_recorded" if durable row + tier already match.
 * Throws on invalid subscription state (caller should return 400).
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
 * @returns "granted" on fresh grant, "already_recorded" if the payment intent
 *          was already processed (idempotent).
 * Throws on invalid payment state (caller should return 400).
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
    // Row already present — tier set below is a no-op if already legendary.
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
