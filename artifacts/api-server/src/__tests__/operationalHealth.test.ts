/**
 * The combined alert address and its parts (launch Phase 16, increment 2;
 * lib/operationalHealth.ts, routes/health.ts `/health/alerts`).
 *
 * For each polled source: the address answers 503 on the failing state, 200
 * on the quiet one, and 503 when the part cannot be judged. The payments
 * comparison is tested on the plan's four cases — an overdue expected event,
 * an unrelated event, a first-purchase event with no local record, and an
 * incomplete comparison — through the Stripe contract's fake client.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { db } from "@workspace/db";
import { asyncJobsTable, stripeProcessedEventsTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import healthRouter from "../routes/health.js";
import {
  __setOperationalHealthDepsForTest,
  compareStripeEvents,
  stuckJobs,
  STRIPE_MAX_PAGES,
  UNCLAIMED_ALERT_MS,
  type OperationalHealthDeps,
} from "../lib/operationalHealth.js";
import { registerJobHandler, __resetHandlersForTest } from "../lib/asyncJobs.js";
import { OPERATIONS_DRILL_QUEUE, registerOperationsDrillHandler } from "../lib/operationsDrill.js";
import { fakeStripeDriver, FAKE_SECRET_KEY, __setFakeStripeEventsForTests } from "../lib/stripeFakeDriver.js";

function app() {
  const a = express();
  a.use("/api", healthRouter);
  return a;
}

const quiet: OperationalHealthDeps = {
  lanes: async () => [],
  tasks: async () => [],
  jobs: async () => ({ unclaimedQueues: [], held: [] }),
  payments: async () => ({ status: "ok", expected: 0, unprocessed: 0, oldestUnprocessedAt: null }),
};

describe("/api/health/alerts", () => {
  after(() => __setOperationalHealthDepsForTest(null));

  it("answers 200 when every part is quiet", async () => {
    __setOperationalHealthDepsForTest(quiet);
    const res = await request(app()).get("/api/health/alerts");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  const failing: Array<[string, Partial<OperationalHealthDeps>]> = [
    ["a stalled lane", { lanes: async () => [{ lane: "bulk", stalled: true } as never] }],
    ["an overdue recurring task", { tasks: async () => [{ id: "content_purge", overdue: true } as never] }],
    ["a due job nobody claims", { jobs: async () => ({ unclaimedQueues: ["email"], held: [] }) }],
    ["a claim held far too long", { jobs: async () => ({ unclaimedQueues: [], held: [{ id: 1, queue: "email", heldForMs: 1 }] }) }],
    ["an unprocessed Stripe event", { payments: async () => ({ status: "ok", expected: 1, unprocessed: 1, oldestUnprocessedAt: new Date() }) }],
    ["an incomplete Stripe comparison", { payments: async () => ({ status: "unjudgeable", reason: "incomplete" }) }],
    ["lanes that cannot be read", { lanes: async () => { throw new Error("db down"); } }],
    ["tasks that cannot be read", { tasks: async () => { throw new Error("db down"); } }],
    ["jobs that cannot be read", { jobs: async () => { throw new Error("db down"); } }],
    ["a payments check that throws", { payments: async () => { throw new Error("boom"); } }],
  ];
  for (const [what, part] of failing) {
    it(`answers 503 on ${what}`, async () => {
      __setOperationalHealthDepsForTest({ ...quiet, ...part });
      const res = await request(app()).get("/api/health/alerts");
      assert.equal(res.status, 503);
      assert.equal(res.body.ok, false);
    });
  }

  it("says only states and counts: no queue names, ids or error text", async () => {
    __setOperationalHealthDepsForTest({
      ...quiet,
      jobs: async () => ({ unclaimedQueues: ["secret_queue_name"], held: [{ id: 424242, queue: "secret_queue_name", heldForMs: 9 }] }),
      lanes: async () => { throw new Error("password=hunter2"); },
    });
    const res = await request(app()).get("/api/health/alerts");
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("secret_queue_name") && !text.includes("424242") && !text.includes("hunter2"), text);
    assert.equal(res.body.jobs.held, 1);
    assert.equal(res.body.lanes.state, "unjudgeable");
  });
});

describe("stuck jobs", () => {
  const Q = `oh-test-stuck-${randomUUID().slice(0, 8)}`;
  before(() => {
    registerJobHandler(Q, { run: async () => ({ ok: true }) }, { executionLimitMs: 60_000 });
    registerOperationsDrillHandler();
  });
  after(async () => {
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.queue, [Q, OPERATIONS_DRILL_QUEUE]));
    __resetHandlersForTest();
  });
  beforeEach(async () => {
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.queue, [Q, OPERATIONS_DRILL_QUEUE]));
  });
  const ago = (ms: number) => new Date(Date.now() - ms);

  it("a due job waiting past the window with no claim in its queue is unclaimed", async () => {
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "pending", nextAttemptAt: ago(UNCLAIMED_ALERT_MS + 60_000) });
    assert.deepEqual((await stuckJobs()).unclaimedQueues, [Q]);
  });

  it("a queue draining a backlog (a recent claim) is not", async () => {
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "pending", nextAttemptAt: ago(UNCLAIMED_ALERT_MS + 60_000) });
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "done", claimedAt: ago(60_000) });
    assert.deepEqual((await stuckJobs()).unclaimedQueues, []);
  });

  it("a recent due job is not", async () => {
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "pending", nextAttemptAt: ago(60_000) });
    assert.deepEqual((await stuckJobs()).unclaimedQueues, []);
  });

  it("a claim held past its queue's limit plus the margin is held; a younger one is not", async () => {
    const leaseToken = randomUUID();
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "processing", leaseToken, claimedAt: ago(60_000 + 16 * 60_000) });
    await db.insert(asyncJobsTable).values({ queue: Q, payload: {}, status: "processing", leaseToken: randomUUID(), claimedAt: ago(60_000) });
    const held = (await stuckJobs()).held.filter((h) => h.queue === Q);
    assert.equal(held.length, 1);
  });

  it("the drill reads as held after two minutes, long before it ends", async () => {
    await db.insert(asyncJobsTable).values({ queue: OPERATIONS_DRILL_QUEUE, payload: {}, status: "processing", leaseToken: randomUUID(), claimedAt: ago(2 * 60_000 + 5_000) });
    assert.equal((await stuckJobs()).held.filter((h) => h.queue === OPERATIONS_DRILL_QUEUE).length, 1);
  });
});

describe("the Stripe comparison", () => {
  const NOW = new Date("2026-11-25T12:00:00Z");
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  const minutesAgo = (m: number) => sec(new Date(NOW.getTime() - m * 60_000));
  const TYPES = ["checkout.session.completed", "invoice.paid", "customer.subscription.updated"];
  const prefix = `evt_ohtest_${randomUUID().slice(0, 8)}_`;
  const ev = (n: string, type: string, created: number) =>
    ({ id: `${prefix}${n}`, object: "event", type, created, data: { object: {} } }) as unknown as Stripe.Event;
  const viaFake = (types = TYPES) => ({
    stripe: async () => fakeStripeDriver.createClient(FAKE_SECRET_KEY),
    supportedTypes: async () => types,
    db,
    now: NOW,
  });

  after(async () => {
    __setFakeStripeEventsForTests([]);
    await db.delete(stripeProcessedEventsTable).where(like(stripeProcessedEventsTable.eventId, `${prefix}%`));
  });

  it("an expected event older than the threshold and not processed is unprocessed; a processed one is not", async () => {
    __setFakeStripeEventsForTests([ev("a", "invoice.paid", minutesAgo(60)), ev("b", "invoice.paid", minutesAgo(90))]);
    await db.insert(stripeProcessedEventsTable).values({ eventId: `${prefix}b` });
    const r = await compareStripeEvents(viaFake());
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.expected, 2);
    assert.equal(r.status === "ok" && r.unprocessed, 1);
  });

  it("an event of a type the endpoint is not registered for is not expected", async () => {
    __setFakeStripeEventsForTests([ev("c", "topup.succeeded", minutesAgo(60))]);
    const r = await compareStripeEvents(viaFake());
    assert.deepEqual(r.status === "ok" && [r.expected, r.unprocessed], [0, 0]);
  });

  it("a first purchase whose webhook never arrived counts, with no local customer at all", async () => {
    __setFakeStripeEventsForTests([ev("d", "checkout.session.completed", minutesAgo(30))]);
    const r = await compareStripeEvents(viaFake());
    assert.equal(r.status === "ok" && r.unprocessed, 1);
  });

  it("an event still inside normal delivery is not yet expected", async () => {
    __setFakeStripeEventsForTests([ev("e", "invoice.paid", minutesAgo(5))]);
    const r = await compareStripeEvents(viaFake());
    assert.equal(r.status === "ok" && r.expected, 0);
  });

  it("a comparison that cannot read every page is unjudgeable, never healthy", async () => {
    const many = Array.from({ length: STRIPE_MAX_PAGES * 100 + 1 }, (_, i) => ev(`m${i}`, "invoice.paid", minutesAgo(60 + i / 100)));
    __setFakeStripeEventsForTests(many);
    const r = await compareStripeEvents(viaFake());
    assert.deepEqual(r, { status: "unjudgeable", reason: "incomplete" });
  });

  it("Stripe being unreachable is unjudgeable", async () => {
    const r = await compareStripeEvents({ ...viaFake(), stripe: async () => { throw new Error("Stripe credentials not configured"); } });
    assert.deepEqual(r, { status: "unjudgeable", reason: "stripe_unavailable" });
  });
});
