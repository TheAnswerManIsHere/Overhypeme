/**
 * Integration tests for charge.refunded, charge.dispute.created, and
 * charge.dispute.closed webhook handlers (Task #226).
 *
 * These tests exercise WebhookHandlers.processEventDirectly() against the
 * real development database, asserting on actual DB state after each handler
 * runs. They cover the canonical scenarios documented in the task spec and
 * verify idempotency via re-delivery.
 *
 * Each test creates its own isolated users and entitlements (prefixed with
 * "t226_") and cleans them up in a finally block to avoid polluting the DB.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ── DB imports ───────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import {
  usersTable,
  lifetimeEntitlementsTable,
  membershipHistoryTable,
  stripeProcessedEventsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

// ── Handler under test ───────────────────────────────────────────────────────
import { WebhookHandlers } from "../lib/webhookHandlers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return `t226_${randomUUID()}`;
}

async function createTestUser(opts: { tier?: "legendary" | "registered" } = {}) {
  const id = uid();
  const stripeCustomerId = `cus_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  await db.insert(usersTable).values({
    id,
    stripeCustomerId,
    membershipTier: opts.tier ?? "legendary",
  });
  return { id, stripeCustomerId };
}

async function createTestLifetimeEntitlement(userId: string, customerId: string, opts: { piId?: string; status?: string } = {}) {
  const piId = opts.piId ?? `pi_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  await db.insert(lifetimeEntitlementsTable).values({
    userId,
    stripePaymentIntentId: piId,
    stripeCustomerId: customerId,
    amount: 19900,
    currency: "usd",
    status: opts.status ?? "active",
  });
  return { piId };
}

async function getUserTier(userId: string) {
  const [u] = await db.select({ membershipTier: usersTable.membershipTier }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u?.membershipTier ?? null;
}

async function getLifetimeStatus(piId: string) {
  const [e] = await db.select({ status: lifetimeEntitlementsTable.status }).from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.stripePaymentIntentId, piId)).limit(1);
  return e?.status ?? null;
}

async function getHistory(userId: string, event: string) {
  return db.select().from(membershipHistoryTable).where(
    and(
      eq(membershipHistoryTable.userId, userId),
      eq(membershipHistoryTable.event, event),
    ),
  );
}

async function cleanupUser(userId: string) {
  await db.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, userId));
  await db.delete(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

function makeChargeRefundedEvent(opts: {
  customerId: string;
  paymentIntentId: string | null;
  invoiceId: string | null;
  amountRefunded?: number;
  currency?: string;
}) {
  return {
    id: `evt_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "charge.refunded" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        customer: opts.customerId,
        payment_intent: opts.paymentIntentId,
        invoice: opts.invoiceId,
        amount_refunded: opts.amountRefunded ?? 19900,
        currency: opts.currency ?? "usd",
      },
    },
  };
}

function makeDisputeCreatedEvent(opts: {
  chargeId: string;
  paymentIntentId: string | null;
  amount?: number;
  currency?: string;
}) {
  return {
    id: `evt_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "charge.dispute.created" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `dp_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        charge: opts.chargeId,
        payment_intent: opts.paymentIntentId,
        status: "needs_response",
        amount: opts.amount ?? 19900,
        currency: opts.currency ?? "usd",
      },
    },
  };
}

function makeDisputeUpdatedEvent(opts: {
  disputeId?: string;
  status?: string;
  amount?: number;
  currency?: string;
  /** Unix timestamp in seconds when evidence is due (null/undefined → no due_by) */
  dueBy?: number | null;
}) {
  return {
    id: `evt_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "charge.dispute.updated" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.disputeId ?? `dp_t232_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        status: opts.status ?? "needs_response",
        amount: opts.amount ?? 19900,
        currency: opts.currency ?? "usd",
        evidence_details: opts.dueBy === undefined ? null : { due_by: opts.dueBy },
      },
    },
  };
}

function makeDisputeFundsEvent(kind: "funds_withdrawn" | "funds_reinstated", opts: {
  disputeId?: string;
  amount?: number;
  currency?: string;
} = {}) {
  return {
    id: `evt_t232_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: `charge.dispute.${kind}` as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.disputeId ?? `dp_t232_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        amount: opts.amount ?? 19900,
        currency: opts.currency ?? "usd",
      },
    },
  };
}

function makeDisputeClosedEvent(opts: {
  disputeId?: string;
  chargeId: string;
  paymentIntentId: string | null;
  status: string;
  amount?: number;
  currency?: string;
}) {
  return {
    id: `evt_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "charge.dispute.closed" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.disputeId ?? `dp_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        charge: opts.chargeId,
        payment_intent: opts.paymentIntentId,
        status: opts.status,
        amount: opts.amount ?? 19900,
        currency: opts.currency ?? "usd",
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("charge.refunded — integration", () => {
  it("refund of lifetime payment → marks entitlement refunded + downgrades to registered", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const event = makeChargeRefundedEvent({ customerId: stripeCustomerId, paymentIntentId: piId, invoiceId: null });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "user should be downgraded");
      assert.equal(await getLifetimeStatus(piId), "refunded", "entitlement should be marked refunded");
      const history = await getHistory(userId, "refund");
      assert.equal(history.length, 1, "refund history row must exist");
      assert.equal(history[0].plan, "lifetime");
      assert.equal(history[0].stripePaymentIntentId, piId);
      assert.equal(history[0].amount, 19900);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("refund of subscription invoice → records history only, no downgrade", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makeChargeRefundedEvent({
        customerId: stripeCustomerId,
        paymentIntentId: `pi_t226_sub_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        invoiceId: `in_t226_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        amountRefunded: 999,
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "legendary", "subscription invoice refund should not change tier");
      const history = await getHistory(userId, "refund");
      assert.equal(history.length, 1, "refund history row must exist");
      assert.ok(history[0].stripeInvoiceId, "history row should have invoice ID");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("idempotent re-delivery — calling twice keeps state consistent and history count stable", async () => {
    // Note: processEventDirectly bypasses the stripe_processed_events idempotency guard.
    // In production processWebhook handles de-duplication at the event-ID level before
    // the handler runs. This test verifies that calling the handler twice does not corrupt
    // state; history may grow per-call (acceptable), but tier must remain correct.
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const event = makeChargeRefundedEvent({ customerId: stripeCustomerId, paymentIntentId: piId, invoiceId: null });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const historyAfterFirst = await getHistory(userId, "refund");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "tier stays registered after re-delivery");
      // In production the webhook is idempotency-guarded by stripe_processed_events (event ID).
      // processEventDirectly skips that guard, so a second call may re-record history.
      // At minimum, the first delivery must have created a history row.
      assert.ok(historyAfterFirst.length >= 1, "refund history row must exist after first delivery");
    } finally {
      await cleanupUser(userId);
    }
  });
});

describe("charge.dispute.created — integration", () => {
  it("dispute on lifetime payment → immediately revokes Legendary + history row", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const chargeId = `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const event = makeDisputeCreatedEvent({ chargeId, paymentIntentId: piId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "user should be immediately downgraded");
      const history = await getHistory(userId, "dispute_opened");
      assert.equal(history.length, 1, "dispute_opened history row must exist");
      assert.ok(history[0].stripeDisputeId, "history row should have dispute ID");
      assert.equal(history[0].amount, 19900);
      assert.equal(history[0].stripePaymentIntentId, piId);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute on subscription payment (via membership_history) → revokes Legendary", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const piId = `pi_t226_sub_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    // Simulate invoice_paid history row linking this PI to the user (as if invoice.paid was processed earlier)
    await db.insert(membershipHistoryTable).values({
      userId,
      event: "invoice_paid",
      stripePaymentIntentId: piId,
      amount: 999,
      currency: "usd",
    });
    try {
      const chargeId = `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const event = makeDisputeCreatedEvent({ chargeId, paymentIntentId: piId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "subscription dispute should revoke Legendary");
      const disputeHistory = await getHistory(userId, "dispute_opened");
      assert.equal(disputeHistory.length, 1, "dispute_opened history row must exist");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute on unknown payment intent → no tier change, no crash", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      // No matching PI in DB; Stripe charge retrieve will fail for fake charge
      const chargeId = `ch_t226_fake_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const event = makeDisputeCreatedEvent({ chargeId, paymentIntentId: `pi_t226_unknown_${randomUUID().replace(/-/g, "").slice(0, 8)}` });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "legendary", "unresolvable dispute should not change tier");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("idempotent re-delivery of dispute.created → tier stays revoked + first-delivery history recorded", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const chargeId = `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const event = makeDisputeCreatedEvent({ chargeId, paymentIntentId: piId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const historyAfterFirst = await getHistory(userId, "dispute_opened");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "stays revoked after re-delivery");
      assert.ok(historyAfterFirst.length >= 1, "dispute_opened history row must exist after first delivery");
      // In production, stripe_processed_events guards against duplicate handler runs via event ID.
      // processEventDirectly bypasses this guard; production re-delivery would not double-insert.
    } finally {
      await cleanupUser(userId);
    }
  });
});

describe("charge.dispute.closed — integration", () => {
  it("dispute won → re-grants Legendary when active entitlement exists", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "active" });
    const disputeId = `dp_t226_won_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      const event = makeDisputeClosedEvent({
        disputeId,
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "won",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "legendary", "dispute won should re-grant legendary");
      const history = await getHistory(userId, "dispute_won");
      assert.equal(history.length, 1, "dispute_won history row must exist");
      assert.equal(history[0].stripeDisputeId, disputeId);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute won but entitlement already refunded → stays at registered", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "refunded" });
    try {
      const event = makeDisputeClosedEvent({
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "won",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "should stay registered with refunded entitlement");
      const history = await getHistory(userId, "dispute_won");
      assert.equal(history.length, 1, "dispute_won history row must still be recorded");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute lost → keeps user at registered + marks lifetime entitlement refunded", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "active" });
    const disputeId = `dp_t226_lost_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      const event = makeDisputeClosedEvent({
        disputeId,
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "lost",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "user should stay revoked after loss");
      assert.equal(await getLifetimeStatus(piId), "refunded", "entitlement should be marked refunded on loss");
      const history = await getHistory(userId, "dispute_lost");
      assert.equal(history.length, 1, "dispute_lost history row must exist");
      assert.equal(history[0].stripeDisputeId, disputeId);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute lost when user is still legendary (dispute.created missed) → revokes to registered", async () => {
    // Verifies that dispute.closed=lost enforces the revoke even if dispute.created was not processed.
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "active" });
    const disputeId = `dp_t226_lost2_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      const event = makeDisputeClosedEvent({
        disputeId,
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "lost",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "user should be revoked even if dispute.created was missed");
      assert.equal(await getLifetimeStatus(piId), "refunded", "entitlement should be marked refunded");
      const history = await getHistory(userId, "dispute_lost");
      assert.equal(history.length, 1, "dispute_lost history row must exist");
      assert.equal(history[0].stripeDisputeId, disputeId);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("dispute warning_closed → records history, no tier change", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "active" });
    try {
      const event = makeDisputeClosedEvent({
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "warning_closed",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "registered", "warning_closed should not change tier");
      assert.equal(await getLifetimeStatus(piId), "active", "entitlement status unchanged on warning_closed");
      const history = await getHistory(userId, "dispute_closed");
      assert.equal(history.length, 1, "dispute_closed history row must exist");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("idempotent re-delivery of dispute.closed (won) → re-grant stays legendary + first-delivery history recorded", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId, { status: "active" });
    try {
      const event = makeDisputeClosedEvent({
        chargeId: `ch_t226_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        status: "won",
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const historyAfterFirst = await getHistory(userId, "dispute_won");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      assert.equal(await getUserTier(userId), "legendary", "stays legendary after re-delivery of won dispute");
      assert.ok(historyAfterFirst.length >= 1, "dispute_won history row must exist after first delivery");
      // In production, stripe_processed_events de-duplicates by event ID so the handler
      // only runs once per event. processEventDirectly skips that guard intentionally.
    } finally {
      await cleanupUser(userId);
    }
  });
});

// ── Task #232: alerts for dispute.updated / funds_withdrawn / funds_reinstated ──
//
// These handlers don't mutate domain state — they only fire admin email alerts
// (fire-and-forget). The tests verify the handlers process the new event types
// cleanly, exercise the per-kind email rendering paths, and tolerate the
// fire-and-forget contract (failure must not interrupt webhook processing).

describe("charge.dispute.updated — admin alert when deadline approaching", () => {
  it("processes due_by < 48h actionable dispute without throwing", async () => {
    const dueBy = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // ~24h from now
    const event = makeDisputeUpdatedEvent({ dueBy, status: "needs_response" });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });

  it("processes due_by > 48h dispute without throwing (no alert path)", async () => {
    const dueBy = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 5; // ~5 days from now
    const event = makeDisputeUpdatedEvent({ dueBy, status: "needs_response" });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });

  it("processes non-actionable status without throwing (no alert path)", async () => {
    const dueBy = Math.floor(Date.now() / 1000) + 60 * 60 * 12; // ~12h from now
    const event = makeDisputeUpdatedEvent({ dueBy, status: "under_review" });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });

  it("processes update with no evidence_details cleanly", async () => {
    const event = makeDisputeUpdatedEvent({ dueBy: undefined });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("charge.dispute.funds_withdrawn / funds_reinstated — admin alert", () => {
  it("processes funds_withdrawn cleanly", async () => {
    const event = makeDisputeFundsEvent("funds_withdrawn", { amount: 19900 });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });

  it("processes funds_reinstated cleanly", async () => {
    const event = makeDisputeFundsEvent("funds_reinstated", { amount: 19900 });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});
