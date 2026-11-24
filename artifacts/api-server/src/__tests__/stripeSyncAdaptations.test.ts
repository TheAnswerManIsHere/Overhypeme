/**
 * The preview-invoice mirror adaptation (Issue #1244, increment 1; Q40: 1).
 *
 * Stripe's `invoice.upcoming` carries an invoice with no id. The library's
 * mirror upserts it into `stripe.invoices`, whose primary key is generated from
 * `_raw_data->>'id'`, so the insert fails — and since the library mirrors inside
 * `processWebhook`, every live renewal reminder was rejected. These tests run
 * the real library against the test database: the unadapted instance fails on
 * the real table (the bug), the adapted one skips only that shape, the
 * signature check is untouched, and other handlers keep their mirror.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";
import { adaptStripeSync, isIdlessUpcomingInvoice } from "../lib/stripeSyncAdaptations.js";

const WEBHOOK_SECRET = "whsec_adaptation_test";
const ACCOUNT = "acct_adaptation_test";
const built: StripeSync[] = [];

function newSync(): StripeSync {
  const sync = new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL!, max: 1 },
    stripeSecretKey: "sk_test_adaptation_never_sent",
    stripeWebhookSecret: WEBHOOK_SECRET,
  });
  // The account the mirror writes under, without an API round-trip.
  (sync as unknown as { cachedAccount: { id: string } }).cachedAccount = { id: ACCOUNT };
  built.push(sync);
  return sync;
}

after(async () => {
  for (const s of built) {
    await (s as unknown as { postgresClient: { pool: { end: () => Promise<void> } } }).postgresClient.pool.end();
  }
});

/** The shape of the stuck production event (evt_1UejZR…): the invoice object has no `id`. */
function upcomingEvent(invoiceId?: string): Stripe.Event {
  return {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    object: "event",
    type: "invoice.upcoming",
    livemode: false,
    created: 1795387757,
    api_version: "2026-03-25.dahlia",
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        object: "invoice",
        ...(invoiceId ? { id: invoiceId } : {}),
        billing_reason: "upcoming",
        customer: "cus_adaptation_test",
        amount_due: 399,
        currency: "usd",
        status: "draft",
        lines: { object: "list", data: [], has_more: false, total_count: 0, url: "/v1/invoices/upcoming/lines" },
      },
    },
  } as unknown as Stripe.Event;
}

function signed(event: Stripe.Event, secret = WEBHOOK_SECRET): { payload: Buffer; signature: string } {
  const payload = JSON.stringify(event);
  const signature = new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret });
  return { payload: Buffer.from(payload), signature };
}

describe("preview-invoice mirror adaptation", () => {
  it("recognises only an invoice.upcoming whose invoice has no id", () => {
    assert.equal(isIdlessUpcomingInvoice(upcomingEvent()), true);
    assert.equal(isIdlessUpcomingInvoice(upcomingEvent("in_123")), false);
    assert.equal(isIdlessUpcomingInvoice({ type: "invoice.paid", data: { object: { object: "invoice" } } }), false);
    assert.equal(isIdlessUpcomingInvoice(null), false);
  });

  it("without the adaptation the library cannot mirror the event (the bug, on the real table)", async () => {
    const sync = newSync();
    // Measured: `null value in column "id" of relation "invoices" violates not-null constraint`.
    await assert.rejects(sync.processEvent(upcomingEvent()), (err: unknown) => (err as { code?: string }).code === "23502");
  });

  it("with the adaptation the id-less preview is skipped, and no invoice row is written", async () => {
    const sync = newSync();
    assert.equal(adaptStripeSync(sync), true);
    const upsertInvoices = sync.upsertInvoices.bind(sync);
    let upserts = 0;
    (sync as unknown as { upsertInvoices: typeof upsertInvoices }).upsertInvoices = async (...args) => {
      upserts++;
      return upsertInvoices(...args);
    };
    await sync.processEvent(upcomingEvent());
    assert.equal(upserts, 0);
  });

  it("an invoice.upcoming that does carry an id still reaches the library's invoice mirror", async () => {
    const sync = newSync();
    adaptStripeSync(sync);
    const seen: unknown[] = [];
    (sync as unknown as { upsertInvoices: (inv: unknown[]) => Promise<unknown[]> }).upsertInvoices = async (inv) => {
      seen.push(...inv);
      return [];
    };
    await sync.processEvent(upcomingEvent("in_has_an_id"));
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as { id: string }).id, "in_has_an_id");
  });

  it("an entitlement summary (no top-level id) still reaches its mirror handler", async () => {
    const sync = newSync();
    adaptStripeSync(sync);
    const calls: string[] = [];
    const s = sync as unknown as Record<string, unknown>;
    s.deleteRemovedActiveEntitlements = async () => { calls.push("delete"); };
    s.upsertActiveEntitlements = async () => { calls.push("upsert"); return []; };
    await sync.processEvent({
      id: "evt_test_entitlements",
      object: "event",
      type: "entitlements.active_entitlement_summary.updated",
      livemode: false,
      created: 1795387757,
      data: {
        object: {
          object: "entitlements.active_entitlement_summary",
          customer: "cus_adaptation_test",
          livemode: false,
          entitlements: { object: "list", data: [{ id: "ent_1", object: "entitlements.active_entitlement" }], has_more: false, url: "" },
        },
      },
    } as unknown as Stripe.Event);
    assert.deepEqual(calls, ["delete", "upsert"]);
  });

  it("a correctly signed delivery of the id-less preview is accepted by processWebhook", async () => {
    const sync = newSync();
    adaptStripeSync(sync);
    const { payload, signature } = signed(upcomingEvent());
    await sync.processWebhook(payload, signature);
  });

  it("a forged signature on the same payload is still refused before any handler runs", async () => {
    const sync = newSync();
    adaptStripeSync(sync);
    let reached = false;
    const handlers = (sync as unknown as { eventHandlers: Record<string, unknown> }).eventHandlers;
    const wrapped = handlers["invoice.upcoming"] as (...a: unknown[]) => Promise<void>;
    handlers["invoice.upcoming"] = async (...a: unknown[]) => { reached = true; return wrapped(...a); };
    const { payload, signature } = signed(upcomingEvent(), "whsec_somebody_else");
    await assert.rejects(sync.processWebhook(payload, signature), /signature/i);
    assert.equal(reached, false);
  });
});
