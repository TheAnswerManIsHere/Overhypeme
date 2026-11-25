/**
 * Replaying a missed Stripe event (Issue #1244, PLAN_REPLAY_MISSED_STRIPE_EVENT.md).
 *
 * Runs the real replay and the real shared processing (`processAuthenticEvent`)
 * against the test database. Only Stripe is stubbed: the verified client's
 * `events.retrieve` (and, where a case needs it, `subscriptions.retrieve`) and
 * the sync instance's mirror. The webhook calls the same `processAuthenticEvent`
 * after its signature check, so "the same effect as a delivery" is asserted by
 * running one event through each entry with the same source of truth.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { StripeSync, runMigrations } from "stripe-replit-sync";
import { adaptStripeSync } from "../lib/stripeSyncAdaptations.js";
import { db, adminActionsTable } from "@workspace/db";
import { usersTable, membershipHistoryTable, stripeProcessedEventsTable, stripeWebhookAuditTable } from "@workspace/db/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { replayStripeEvent, type ReplayDeps } from "../lib/stripeEventReplay.js";
import { processAuthenticEvent } from "../lib/webhookHandlers.js";
import type { StripeApi, StripeSyncApi } from "../lib/stripeApi.js";
import { logger } from "../lib/logger.js";
import express from "express";
import request from "supertest";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";

const P = `evt_rpl${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const USER = `trpl-${randomUUID()}`;
const ADMIN = `trpl-admin-${randomUUID()}`;
const CUSTOMER = `cus_rpl${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SUPPORTED = ["invoice.upcoming", "payment_intent.succeeded", "customer.subscription.updated"];

let seq = 0;
const nextId = () => `${P}${++seq}`;

function upcoming(id: string, livemode = false): Stripe.Event {
  return {
    id, object: "event", type: "invoice.upcoming", livemode, created: 1795387757,
    data: { object: { object: "invoice", customer: CUSTOMER, amount_due: 399, currency: "usd", next_payment_attempt: 1795996110 } },
  } as unknown as Stripe.Event;
}
function noop(id: string): Stripe.Event {
  return { id, object: "event", type: "payment_intent.succeeded", livemode: false, created: 1795387757, data: { object: { id: "pi_x" } } } as unknown as Stripe.Event;
}
function subscriptionUpdated(id: string): Stripe.Event {
  return {
    id, object: "event", type: "customer.subscription.updated", livemode: false, created: 1795387757,
    data: { object: { id: "sub_rpl_x", object: "subscription", customer: CUSTOMER, status: "active" } },
  } as unknown as Stripe.Event;
}

const missing = (id: string) => Object.assign(new Error(`No such event: '${id}'`), { code: "resource_missing", statusCode: 404 });

interface Harness {
  deps: Partial<ReplayDeps>;
  retrieved: string[];
  mirrored: string[];
  subscriptionRetrieves: number;
}

function harness(events: Stripe.Event[], opts: { liveMode?: boolean; syncMode?: boolean | null; failSubscriptionRetrieve?: boolean } = {}): Harness {
  const liveMode = opts.liveMode ?? false;
  const h: Harness = { deps: {}, retrieved: [], mirrored: [], subscriptionRetrieves: 0 };
  const client = {
    events: {
      retrieve: async (id: string) => {
        h.retrieved.push(id);
        const e = events.find((x) => x.id === id);
        if (!e) throw missing(id);
        return e;
      },
    },
    subscriptions: {
      retrieve: async () => {
        h.subscriptionRetrieves++;
        throw new Error("Stripe is unreachable (test)");
      },
    },
  } as unknown as StripeApi;
  const sync = {
    getSupportedEventTypes: () => SUPPORTED,
    processEvent: async (e: Stripe.Event) => { h.mirrored.push(e.id); },
  } as unknown as StripeSyncApi;
  h.deps = {
    verifiedClient: async () => ({ client, liveMode }),
    sync: async () => sync,
    syncMode: () => (opts.syncMode === undefined ? liveMode : opts.syncMode),
  };
  return h;
}

const claims = async (id: string) =>
  (await db.select().from(stripeProcessedEventsTable).where(eq(stripeProcessedEventsTable.eventId, id))).length;
const reminders = async () =>
  (await db.select().from(membershipHistoryTable).where(and(eq(membershipHistoryTable.userId, USER), eq(membershipHistoryTable.event, "renewal_reminder")))).length;
const audits = async (id: string) =>
  db.select().from(stripeWebhookAuditTable).where(eq(stripeWebhookAuditTable.eventId, id));
const adminRows = async (id: string) =>
  (await db.select().from(adminActionsTable).where(and(eq(adminActionsTable.actorId, ADMIN), sql`${adminActionsTable.detail}->>'eventId' = ${id}`)))
    .map((r) => (r.detail as { phase: string }).phase);

before(async () => {
  await db.insert(usersTable).values([
    { id: USER, email: `${USER}@test.local`, stripeCustomerId: CUSTOMER },
    { id: ADMIN, email: `${ADMIN}@test.local`, isAdmin: true },
  ]);
});

after(async () => {
  await db.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, USER));
  await db.delete(stripeProcessedEventsTable).where(like(stripeProcessedEventsTable.eventId, `${P}%`));
  await db.delete(stripeWebhookAuditTable).where(like(stripeWebhookAuditTable.eventId, `${P}%`));
  await db.delete(adminActionsTable).where(eq(adminActionsTable.actorId, ADMIN));
  await db.delete(usersTable).where(inArray(usersTable.id, [USER, ADMIN]));
});

describe("replaying a missed Stripe event", () => {
  it("has the same effect as a delivery: claim, audit, and the event's own domain write", async () => {
    const viaWebhook = upcoming(nextId());
    const viaReplay = upcoming(nextId());
    const h = harness([viaReplay]);
    const before = await reminders();

    const { client } = await h.deps.verifiedClient!();
    assert.equal(await processAuthenticEvent(client, viaWebhook, "webhook"), "processed");
    const r = await replayStripeEvent(viaReplay.id, ADMIN, h.deps);
    assert.equal(r.outcome, "processed");

    assert.equal(await reminders(), before + 2, "one renewal_reminder per event, through either entry");
    assert.equal(await claims(viaWebhook.id), 1);
    assert.equal(await claims(viaReplay.id), 1);
    assert.deepEqual((await audits(viaWebhook.id)).map((a) => [a.state, a.detail]), [["received", null], ["processed", null]]);
    assert.deepEqual((await audits(viaReplay.id)).map((a) => [a.state, a.detail]), [["received", "admin replay"], ["processed", "admin replay"]]);
    assert.deepEqual(h.mirrored, [viaReplay.id], "the replay mirrors, as the library does for a delivery");
    assert.deepEqual(await adminRows(viaReplay.id), ["attempt", "outcome"]);
  });

  it("an id-less renewal reminder goes all the way through with the real, adapted mirror (plan increment 1's end-to-end case)", async () => {
    // The library's own mirror, adapted as at construction (stripeClient.ts),
    // against the real `stripe` schema: no stub for the step that used to fail.
    await runMigrations({ databaseUrl: process.env.DATABASE_URL! });
    const real = new StripeSync({
      poolConfig: { connectionString: process.env.DATABASE_URL!, max: 1 },
      stripeSecretKey: "sk_test_replay_never_sent",
    });
    (real as unknown as { cachedAccount: { id: string } }).cachedAccount = { id: "acct_replay_test" };
    assert.equal(adaptStripeSync(real), true);
    try {
      const e = upcoming(nextId());
      assert.equal("id" in (e.data.object as object), false, "the preview invoice carries no id, as Stripe sends it");
      const h = harness([e]);
      h.deps.sync = async () => real as unknown as StripeSyncApi;
      const start = await reminders();
      const r = await replayStripeEvent(e.id, ADMIN, h.deps);
      assert.equal(r.outcome, "processed");
      assert.equal(await claims(e.id), 1);
      assert.deepEqual((await audits(e.id)).map((a) => a.state), ["received", "processed"]);
      assert.equal(await reminders(), start + 1, "the renewal reminder is recorded against the member");
    } finally {
      await (real as unknown as { postgresClient: { pool: { end: () => Promise<void> } } }).postgresClient.pool.end();
    }
  });

  it("an event with no domain effect is still claimed once", async () => {
    const e = noop(nextId());
    const r = await replayStripeEvent(e.id, ADMIN, harness([e]).deps);
    assert.equal(r.outcome, "processed");
    assert.equal(await claims(e.id), 1);
  });

  it("a repeat replay reports already processed and changes nothing but its audit rows", async () => {
    const e = upcoming(nextId());
    const h = harness([e]);
    await replayStripeEvent(e.id, ADMIN, h.deps);
    const after1 = await reminders();
    const r = await replayStripeEvent(e.id, ADMIN, h.deps);
    assert.equal(r.outcome, "already_processed");
    assert.equal(await reminders(), after1);
    assert.equal(await claims(e.id), 1);
    assert.deepEqual(h.mirrored, [e.id], "the second replay did not mirror");
    assert.deepEqual(await adminRows(e.id), ["attempt", "outcome", "attempt", "outcome"]);
  });

  it("an already-processed event whose downstream retrieval would fail is still reported as processed, without retrieving or mirroring", async () => {
    const e = subscriptionUpdated(nextId());
    await db.insert(stripeProcessedEventsTable).values({ eventId: e.id });
    const h = harness([e]);
    const r = await replayStripeEvent(e.id, ADMIN, h.deps);
    assert.equal(r.outcome, "already_processed");
    assert.equal(h.subscriptionRetrieves, 0);
    assert.deepEqual(h.mirrored, []);
  });

  it("delivered then replayed, replayed then delivered, and both at once: each processes once", async () => {
    const a = upcoming(nextId());
    const b = upcoming(nextId());
    const c = upcoming(nextId());
    const h = harness([a, b, c]);
    const { client } = await h.deps.verifiedClient!();
    const start = await reminders();

    await processAuthenticEvent(client, a, "webhook");
    assert.equal((await replayStripeEvent(a.id, ADMIN, h.deps)).outcome, "already_processed");

    await replayStripeEvent(b.id, ADMIN, h.deps);
    assert.equal(await processAuthenticEvent(client, b, "webhook"), "already_processed");

    const both = await Promise.allSettled([processAuthenticEvent(client, c, "webhook"), replayStripeEvent(c.id, ADMIN, h.deps)]);
    assert.ok(both.every((x) => x.status === "fulfilled"), "neither entry fails on the race");

    assert.equal(await reminders(), start + 3, "three events, three reminders");
    for (const e of [a, b, c]) assert.equal(await claims(e.id), 1);
  });

  it("a processing failure leaves the event unclaimed, with a failed audit row, so it can be replayed again", async () => {
    const e = subscriptionUpdated(nextId());
    const r = await replayStripeEvent(e.id, ADMIN, harness([e]).deps);
    assert.equal(r.outcome, "failed");
    assert.equal(await claims(e.id), 0);
    const rows = await audits(e.id);
    assert.ok(rows.some((a) => a.state === "failed" && a.detail?.startsWith("admin replay:")));
  });

  describe("refusals", () => {
    it("a malformed id never reaches Stripe or the audit log", async () => {
      const h = harness([]);
      let asked = false;
      h.deps.verifiedClient = async () => { asked = true; throw new Error("unreachable"); };
      for (const id of ["", "pi_123", "evt_", "evt_a/b", `evt_${"x".repeat(251)}`]) {
        assert.deepEqual(await replayStripeEvent(id, ADMIN, h.deps), { outcome: "refused", reason: "malformed_id", eventId: id });
      }
      assert.equal(asked, false);
    });

    it("an id Stripe does not hold for this account and mode is not found", async () => {
      const r = await replayStripeEvent(`${P}nope`, ADMIN, harness([]).deps);
      assert.equal(r.outcome === "refused" && r.reason, "not_found");
    });

    it("an event of the other mode is refused, and nothing is claimed", async () => {
      const e = upcoming(nextId(), true);
      const r = await replayStripeEvent(e.id, ADMIN, harness([e], { liveMode: false }).deps);
      assert.equal(r.outcome === "refused" && r.reason, "wrong_mode");
      assert.equal(await claims(e.id), 0);
    });

    it("a sync built for another mode is refused before it can mirror", async () => {
      const e = upcoming(nextId());
      const h = harness([e], { syncMode: null });
      const r = await replayStripeEvent(e.id, ADMIN, h.deps);
      assert.equal(r.outcome === "refused" && r.reason, "mode_changed");
      assert.deepEqual(h.mirrored, []);
    });

    it("a type the webhook is not subscribed to is refused", async () => {
      const e = { ...noop(nextId()), type: "topup.succeeded" } as unknown as Stripe.Event;
      const r = await replayStripeEvent(e.id, ADMIN, harness([e]).deps);
      assert.equal(r.outcome === "refused" && r.reason, "unsupported_type");
      assert.equal(await claims(e.id), 0);
    });
  });

  describe("the admin record", () => {
    it("is written before processing: if the attempt cannot be recorded, nothing is processed", async () => {
      const e = upcoming(nextId());
      const h = harness([e]);
      h.deps.record = async () => { throw new Error("audit table unavailable"); };
      const r = await replayStripeEvent(e.id, ADMIN, h.deps);
      assert.equal(r.outcome === "refused" && r.reason, "audit_unavailable");
      assert.deepEqual(h.retrieved, []);
      assert.equal(await claims(e.id), 0);
    });

    it("still names the admin when the outcome cannot be recorded after a committed replay", async () => {
      const e = upcoming(nextId());
      const h = harness([e]);
      h.deps.record = async (actorId, detail) => {
        if (detail.phase === "outcome") throw new Error("audit table unavailable");
        await db.insert(adminActionsTable).values({ actorId, action: "stripe_event_replayed", detail });
      };
      const r = await replayStripeEvent(e.id, ADMIN, h.deps);
      assert.equal(r.outcome, "processed");
      assert.equal(await claims(e.id), 1);
      assert.deepEqual(await adminRows(e.id), ["attempt"]);
    });
  });

  describe("notifications", () => {
    async function remindersSent(run: () => Promise<unknown>): Promise<number> {
      const original = logger.info.bind(logger);
      let sent = 0;
      (logger as unknown as { info: (...a: unknown[]) => void }).info = (...a: unknown[]) => {
        if (a.some((x) => x === "Sent renewal reminder email")) sent++;
        return (original as (...b: unknown[]) => void)(...a);
      };
      try { await run(); } finally { (logger as unknown as { info: unknown }).info = original; }
      return sent;
    }

    it("a live-mode reminder sends its email through either entry, once, and a test-mode one sends none", async () => {
      const live1 = upcoming(nextId(), true);
      const live2 = upcoming(nextId(), true);
      const test = upcoming(nextId(), false);
      const live = harness([live1, live2], { liveMode: true });
      const { client } = await live.deps.verifiedClient!();
      assert.equal(await remindersSent(() => processAuthenticEvent(client, live1, "webhook")), 1);
      assert.equal(await remindersSent(() => replayStripeEvent(live2.id, ADMIN, live.deps)), 1);
      assert.equal(await remindersSent(() => replayStripeEvent(live2.id, ADMIN, live.deps)), 0, "a repeat sends nothing");
      assert.equal(await remindersSent(() => replayStripeEvent(test.id, ADMIN, harness([test]).deps)), 0);
    });
  });
});

describe("the admin routes", () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(adminRouter);
  let adminSid: string;
  let memberSid: string;

  before(async () => {
    const session = (id: string, isAdmin: boolean) =>
      createSession({ user: { id } as unknown as SessionData["user"], access_token: "test-token", isAdmin }, id);
    adminSid = await session(ADMIN, true);
    memberSid = await session(USER, false);
  });

  const bearer = (sid: string) => `Bearer ${sid}`;

  it("both routes refuse a signed-out caller and a member who is not an admin", async () => {
    for (const r of [
      () => request(app).get("/admin/stripe/missed-events"),
      () => request(app).post(`/admin/stripe/missed-events/${P}x/replay`),
    ]) {
      assert.equal((await r()).status, 401);
      assert.equal((await r().set("authorization", bearer(memberSid))).status, 403);
    }
  });

  it("the list answers an admin, and a comparison that cannot run says so rather than listing nothing", async () => {
    const res = await request(app).get("/admin/stripe/missed-events").set("authorization", bearer(adminSid));
    assert.equal(res.status, 200);
    // No Stripe credentials in the test environment: unjudgeable, never an empty "ok".
    assert.equal(res.body.status, "unjudgeable");
    assert.equal(typeof res.body.reason, "string");
  });

  it("a malformed id is a 400 with its reason, before Stripe is asked", async () => {
    const res = await request(app).post("/admin/stripe/missed-events/not-an-event/replay").set("authorization", bearer(adminSid));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { outcome: "refused", reason: "malformed_id", eventId: "not-an-event" });
  });
});
