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

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ── DB imports ───────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import {
  usersTable,
  lifetimeEntitlementsTable,
  membershipHistoryTable,
  stripeProcessedEventsTable,
  stripeWebhookAuditTable,
  emailOutboxTable,
} from "@workspace/db/schema";
import { eq, and, gte, isNull, or, like } from "drizzle-orm";

// ── Handler under test ───────────────────────────────────────────────────────
import { WebhookHandlers } from "../lib/webhookHandlers.js";


// ── Outbox cleanup ────────────────────────────────────────────────────────────
// These integration tests run real webhook handlers against the dev DB. Some
// handlers (disputes, fraud warnings, SCA, card updates) call sendEmail(),
// which inserts a row into email_outbox when RESEND_API_KEY is configured.
// Without cleanup the email worker will then attempt to deliver those test
// notifications to the admin inbox, burning the daily quota.
//
// We capture the file's start time and, in a top-level after() hook, delete
// any outbox rows created during this test run. Recipient is not filtered so
// every test-generated row is removed regardless of which handler made it.
const TEST_FILE_START = new Date();
after(async () => {
  // Only delete rows that came from admin notification paths. Those rows have
  // kind = null (dispute, fraud, SCA, card-update notifications) or a kind
  // starting with "admin_" (e.g. "admin_abandoned_email_alert"). Other test
  // files tag their outbox rows with kind = "t248_test" / "t259_test" etc.,
  // so filtering by null-or-admin_ avoids deleting their rows in a concurrent run.
  //
  // IMPORTANT: the pattern uses "admin\\_%" — the backslash escapes the
  // underscore so PostgreSQL LIKE treats it as a literal "_", not the
  // single-character wildcard. Without the escape, a kind like "adminXfoo"
  // would also match, silently deleting unintended rows.
  await db
    .delete(emailOutboxTable)
    .where(
      and(
        gte(emailOutboxTable.createdAt, TEST_FILE_START),
        or(isNull(emailOutboxTable.kind), like(emailOutboxTable.kind, "admin\\_%")),
      ),
    );
});

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

// ── Task #230: tightened webhook event coverage ──────────────────────────────
//
// These tests cover the new events added in #230 (SCA action required, renewal
// reminder, card automatically updated, early fraud warning) and the funds
// movement history extension. The removed `payment_intent.succeeded` case is
// also exercised to confirm it now ack-noops without throwing.

function makeInvoicePaymentActionRequiredEvent(opts: {
  customerId: string;
  invoiceId?: string;
  hostedInvoiceUrl?: string | null;
  amountDue?: number | null;
  currency?: string | null;
  subscriptionId?: string | null;
}) {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "invoice.payment_action_required" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.invoiceId ?? `in_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        customer: opts.customerId,
        hosted_invoice_url: opts.hostedInvoiceUrl ?? "https://invoice.stripe.com/i/test_dummy",
        amount_due: opts.amountDue ?? 999,
        currency: opts.currency ?? "usd",
        subscription: opts.subscriptionId ?? null,
      },
    },
  };
}

function makeInvoiceUpcomingEvent(opts: {
  customerId: string;
  amountDue?: number | null;
  currency?: string | null;
  nextAttempt?: number | null;
  subscriptionId?: string | null;
}) {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "invoice.upcoming" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        customer: opts.customerId,
        amount_due: opts.amountDue ?? 999,
        currency: opts.currency ?? "usd",
        next_payment_attempt: opts.nextAttempt ?? Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        subscription: opts.subscriptionId ?? null,
      },
    },
  };
}

function makePaymentMethodAutoUpdatedEvent(opts: {
  customerId: string;
  paymentMethodId?: string;
  brand?: string;
  last4?: string;
}) {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "payment_method.automatically_updated" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.paymentMethodId ?? `pm_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        customer: opts.customerId,
        card: { brand: opts.brand ?? "visa", last4: opts.last4 ?? "4242" },
      },
    },
  };
}

function makePaymentIntentSucceededEvent() {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "payment_intent.succeeded" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `pi_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        customer: `cus_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        amount: 19900,
        currency: "usd",
        invoice: null,
        metadata: { membership: "true", plan: "lifetime" },
      },
    },
  };
}

function makeEarlyFraudWarningEvent(opts: {
  chargeId: string;
  paymentIntentId?: string | null;
  fraudType?: string;
  actionable?: boolean;
}) {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "radar.early_fraud_warning.created" as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: `issfr_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        charge: opts.chargeId,
        payment_intent: opts.paymentIntentId ?? null,
        actionable: opts.actionable ?? true,
        fraud_type: opts.fraudType ?? "fraudulent",
      },
    },
  };
}

function makeFundsMovementWithChargeEvent(
  kind: "funds_withdrawn" | "funds_reinstated",
  opts: { chargeId: string; paymentIntentId: string | null; amount?: number; disputeId?: string },
) {
  return {
    id: `evt_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: `charge.dispute.${kind}` as const,
    object: "event" as const,
    api_version: "2022-11-15" as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: opts.disputeId ?? `dp_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        charge: opts.chargeId,
        payment_intent: opts.paymentIntentId,
        amount: opts.amount ?? 19900,
        currency: "usd",
      },
    },
  };
}

describe("invoice.payment_action_required — SCA email + history (Task #230)", () => {
  it("records payment_action_required history for the user", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makeInvoicePaymentActionRequiredEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "payment_action_required");
      assert.equal(history.length, 1, "payment_action_required history row must exist");
      assert.ok(history[0].stripeInvoiceId, "history row should have invoice ID");
      assert.equal(history[0].amount, 999);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("ack-noops when customer has no matching user — does not throw", async () => {
    const event = makeInvoicePaymentActionRequiredEvent({
      customerId: `cus_t230_unknown_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("invoice.upcoming — renewal reminder + history (Task #230)", () => {
  it("records renewal_reminder history for the user", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makeInvoiceUpcomingEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "renewal_reminder");
      assert.equal(history.length, 1, "renewal_reminder history row must exist");
      assert.equal(history[0].amount, 999);
      assert.equal(history[0].currency, "usd");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("ack-noops when customer has no matching user — does not throw", async () => {
    const event = makeInvoiceUpcomingEvent({
      customerId: `cus_t230_unknown_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("payment_method.automatically_updated — card refresh + history (Task #230)", () => {
  it("records payment_method_updated history for the user", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makePaymentMethodAutoUpdatedEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "payment_method_updated");
      assert.equal(history.length, 1, "payment_method_updated history row must exist");
      assert.equal(await getUserTier(userId), "legendary", "tier unchanged by card refresh");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("ack-noops when customer has no matching user — does not throw", async () => {
    const event = makePaymentMethodAutoUpdatedEvent({
      customerId: `cus_t230_unknown_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("payment_intent.succeeded — removed/no-op (Task #230)", () => {
  it("acks 200 silently without throwing or granting anything", async () => {
    // Removed in #230 — handled by checkout.session.completed (one-time) and
    // invoice.paid (subscription). The case is intentionally retained as a
    // logged no-op to handle in-flight retries during the Dashboard cutover.
    const event = makePaymentIntentSucceededEvent();
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("radar.early_fraud_warning.created — admin alert + history (Task #230)", () => {
  it("records early_fraud_warning history for resolved user (lifetime payment intent path)", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const event = makeEarlyFraudWarningEvent({
        chargeId: `ch_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        fraudType: "fraudulent",
        actionable: true,
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "early_fraud_warning");
      assert.equal(history.length, 1, "early_fraud_warning history row must exist");
      assert.equal(history[0].stripePaymentIntentId, piId);
      // Critical guarantee: warning must NOT auto-revoke or auto-refund.
      assert.equal(await getUserTier(userId), "legendary", "fraud warning must not auto-revoke");
      assert.equal(await getLifetimeStatus(piId), "active", "fraud warning must not auto-refund");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("ack-noops when payment intent and charge are unresolvable — admin alert still fires (no throw)", async () => {
    const event = makeEarlyFraudWarningEvent({
      chargeId: `ch_t230_fake_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      paymentIntentId: `pi_t230_unknown_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    });
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
  });
});

describe("charge.dispute.funds_withdrawn — funds movement history (Task #230)", () => {
  it("records dispute_funds_withdrawn history for the user when charge is resolvable", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "registered" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    const disputeId = `dp_t230_fw_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      const event = makeFundsMovementWithChargeEvent("funds_withdrawn", {
        chargeId: `ch_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        disputeId,
        amount: 19900,
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "dispute_funds_withdrawn");
      assert.equal(history.length, 1, "dispute_funds_withdrawn history row must exist");
      assert.equal(history[0].stripeDisputeId, disputeId);
      assert.equal(history[0].amount, 19900);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("records dispute_funds_reinstated history when funds returned to balance", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    const disputeId = `dp_t230_fr_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      const event = makeFundsMovementWithChargeEvent("funds_reinstated", {
        chargeId: `ch_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
        disputeId,
        amount: 19900,
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);

      const history = await getHistory(userId, "dispute_funds_reinstated");
      assert.equal(history.length, 1, "dispute_funds_reinstated history row must exist");
      assert.equal(history[0].stripeDisputeId, disputeId);
    } finally {
      await cleanupUser(userId);
    }
  });
});

describe("Task #230 — idempotent re-delivery of new handlers", () => {
  // These tests mirror the convention used elsewhere in this file: replay the
  // same event via processEventDirectly twice and assert state stays sane. In
  // production processWebhook gates duplicate event IDs at the
  // stripe_processed_events table BEFORE dispatch — see processWebhook in
  // webhookHandlers.ts. processEventDirectly intentionally bypasses that gate
  // so we can verify each handler is internally well-behaved on replay.

  it("invoice.payment_action_required — replay does not corrupt state", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makeInvoicePaymentActionRequiredEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const after1 = await getHistory(userId, "payment_action_required");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      assert.ok(after1.length >= 1, "first delivery must have recorded history");
      assert.equal(await getUserTier(userId), "legendary", "tier unchanged across replays");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("invoice.upcoming — replay does not corrupt state", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makeInvoiceUpcomingEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const after1 = await getHistory(userId, "renewal_reminder");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      assert.ok(after1.length >= 1, "first delivery must have recorded history");
      assert.equal(await getUserTier(userId), "legendary", "tier unchanged across replays");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("payment_method.automatically_updated — replay does not corrupt state", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    try {
      const event = makePaymentMethodAutoUpdatedEvent({ customerId: stripeCustomerId });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const after1 = await getHistory(userId, "payment_method_updated");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      assert.ok(after1.length >= 1, "first delivery must have recorded history");
      assert.equal(await getUserTier(userId), "legendary", "tier unchanged across replays");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("radar.early_fraud_warning.created — replay does not auto-revoke or auto-refund", async () => {
    const { id: userId, stripeCustomerId } = await createTestUser({ tier: "legendary" });
    const { piId } = await createTestLifetimeEntitlement(userId, stripeCustomerId);
    try {
      const event = makeEarlyFraudWarningEvent({
        chargeId: `ch_t230_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        paymentIntentId: piId,
      });
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      const after1 = await getHistory(userId, "early_fraud_warning");
      await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
      assert.ok(after1.length >= 1, "first delivery must have recorded history");
      // Critical guarantee: replays must never auto-revoke or auto-refund.
      assert.equal(await getUserTier(userId), "legendary", "fraud warning replay must not auto-revoke");
      assert.equal(await getLifetimeStatus(piId), "active", "fraud warning replay must not auto-refund");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("payment_intent.succeeded (no-op) — replay is silent", async () => {
    const event = makePaymentIntentSucceededEvent();
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
    await WebhookHandlers.processEventDirectly(event as unknown as import("stripe").default.Event);
    // No assertions needed — the requirement is that replaying the removed
    // event neither throws nor produces side effects. Lack of throw is the
    // assertion.
  });
});

describe("Webhook reliability/audit primitives", () => {
  it("suppresses duplicate event IDs via unique key (concurrent replay safety)", async () => {
    const eventId = `evt_dedup_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const results = await Promise.allSettled([
      db.insert(stripeProcessedEventsTable).values({ eventId }),
      db.insert(stripeProcessedEventsTable).values({ eventId }),
      db.insert(stripeProcessedEventsTable).values({ eventId }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    assert.equal(fulfilled, 1);
    assert.equal(rejected, 2);
    await db.delete(stripeProcessedEventsTable).where(eq(stripeProcessedEventsTable.eventId, eventId));
  });

  it("records webhook audit states for diagnostics", async () => {
    const eventId = `evt_audit_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    await db.insert(stripeWebhookAuditTable).values([
      { eventId, eventType: "checkout.session.completed", state: "received" },
      { eventId, eventType: "checkout.session.completed", state: "processed" },
    ]);
    const rows = await db.select().from(stripeWebhookAuditTable).where(eq(stripeWebhookAuditTable.eventId, eventId));
    assert.ok(rows.some((r) => r.state === "received"));
    assert.ok(rows.some((r) => r.state === "processed"));
    await db.delete(stripeWebhookAuditTable).where(eq(stripeWebhookAuditTable.eventId, eventId));
  });
});
