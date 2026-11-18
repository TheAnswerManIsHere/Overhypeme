/**
 * The event-reported alert sources (launch Phase 16, increment 2): each
 * failure is injected and the report asserted; a report that itself fails
 * neither throws into nor changes the work it reports on.
 *
 *  - job_failed: the job core's finalize, a terminal failure and retries exhausted
 *  - job_interrupted: the reclaim of a job whose holder stopped
 *  - payment_webhook_failed: the Stripe webhook route's catch, and not for a
 *    delivery rejected before verification (a stranger could otherwise ring
 *    the phone)
 *  - unrecorded_spend: comparison settlement after a paid render
 *
 * No database write is on the report path: the reporter only calls Sentry's
 * capture (lib/operationalAlerts.ts), which every test here replaces.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { __setAlertCaptureForTest } from "../lib/operationalAlerts.js";
import {
  __resetHandlersForTest,
  asyncJobsTick,
  enqueueJob,
  recoverStuckProcessing,
  registerJobHandler,
  terminalFailure,
  RESUMES_FROM_CHECKPOINTS,
} from "../lib/asyncJobs.js";
import { WebhookHandlers, markRejectedBeforeVerification } from "../lib/webhookHandlers.js";
import { __setSettlementWriteForTest, settleAtBound } from "../lib/comparison/runs.js";
import { createApp } from "../app.js";

type Captured = { message: string; tags: Record<string, unknown>; extra: Record<string, unknown> };
let captured: Captured[] = [];
function capturing() {
  __setAlertCaptureForTest((message, context) => {
    const c = (context ?? {}) as { tags?: Record<string, unknown>; extra?: Record<string, unknown> };
    captured.push({ message, tags: c.tags ?? {}, extra: c.extra ?? {} });
  });
}
function failingCapture() {
  __setAlertCaptureForTest(() => { throw new Error("Sentry is down"); });
}
const of = (source: string) => captured.filter((c) => c.tags.alert_source === source);

// One outer block, so these hooks stay inside this file: under the sharded
// runner every file in a shard shares one process and one root test, and a
// top-level hook would replace the capture for other files' tests too.
describe("operational alert sources", () => {
  beforeEach(() => { captured = []; capturing(); });
  after(() => __setAlertCaptureForTest(null));

  describe("job_failed", () => {
    const Q = `oh-alert-fail-${randomUUID().slice(0, 8)}`;
    let mode: "terminal" | "retryable" = "terminal";
    before(() => {
      registerJobHandler(Q, {
        run: async () => (mode === "terminal" ? terminalFailure("bad_input", "cannot do this") : { ok: false, error: "vendor down" }),
      });
    });
    after(async () => {
      await db.delete(asyncJobsTable).where(eq(asyncJobsTable.queue, Q));
      __resetHandlersForTest();
    });

    async function runOne(maxAttempts?: number): Promise<number> {
      const { jobId } = await enqueueJob({ queue: Q, payload: {}, ...(maxAttempts ? { maxAttempts } : {}) });
      await asyncJobsTick(db, new Date(), { queues: [Q] });
      return jobId;
    }

    it("a terminal failure is reported, with the queue and job", async () => {
      mode = "terminal";
      const jobId = await runOne();
      const reports = of("job_failed");
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.extra.queue, Q);
      assert.equal(reports[0]!.extra.jobId, jobId);
    });

    it("retries exhausted is reported; a failure that will be retried is not", async () => {
      mode = "retryable";
      await runOne(2);
      assert.equal(of("job_failed").length, 0, "a first failure with a retry left is not a failure for good");
      const jobId = await runOne(1);
      assert.deepEqual(of("job_failed").map((r) => [r.extra.jobId, r.extra.how]), [[jobId, "retries_exhausted"]]);
    });

    it("a report that fails changes nothing about the job", async () => {
      mode = "terminal";
      failingCapture();
      const jobId = await runOne();
      const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, jobId));
      assert.equal(row!.status, "failed");
    });
  });

  describe("job_interrupted", () => {
    const Q = `oh-alert-int-${randomUUID().slice(0, 8)}`;
    before(() => registerJobHandler(Q, { run: async () => ({ ok: true }) }, RESUMES_FROM_CHECKPOINTS));
    after(async () => {
      await db.delete(asyncJobsTable).where(eq(asyncJobsTable.queue, Q));
      __resetHandlersForTest();
    });

    async function strand(): Promise<number> {
      const [row] = await db.insert(asyncJobsTable).values({
        queue: Q, payload: {}, status: "processing", leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000), claimedAt: new Date(Date.now() - 60_000),
      }).returning({ id: asyncJobsTable.id });
      return row!.id;
    }

    it("a job taken back from a stopped holder is reported, at warning level by its source", async () => {
      const id = await strand();
      await recoverStuckProcessing(db);
      const reports = of("job_interrupted").filter((r) => r.extra.queue === Q);
      assert.deepEqual(reports.map((r) => r.extra.jobId), [id]);
    });

    it("a report that fails does not stop the reclaim", async () => {
      failingCapture();
      const id = await strand();
      await recoverStuckProcessing(db);
      const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id));
      assert.equal(row!.status, "recovering");
    });
  });

  describe("payment_webhook_failed", () => {
    const original = WebhookHandlers.processWebhook;
    after(() => { WebhookHandlers.processWebhook = original; });
    const post = () =>
      request(createApp()).post("/api/stripe/webhook").set("stripe-signature", "t=1,v1=x").set("content-type", "application/json").send("{}");

    it("a processing failure is reported, and the answer is still 400 for Stripe to retry", async () => {
      WebhookHandlers.processWebhook = async () => { throw new Error("Webhook domain handler error"); };
      const res = await post();
      assert.equal(res.status, 400);
      assert.equal(of("payment_webhook_failed").length, 1);
    });

    it("a delivery rejected before it was verified as Stripe's is not reported", async () => {
      WebhookHandlers.processWebhook = async () => {
        const err = new Error("No signatures found matching the expected signature");
        markRejectedBeforeVerification(err);
        throw err;
      };
      const res = await post();
      assert.equal(res.status, 400);
      assert.equal(of("payment_webhook_failed").length, 0);
    });

    it("a report that fails does not change the answer", async () => {
      WebhookHandlers.processWebhook = async () => { throw new Error("boom"); };
      failingCapture();
      assert.equal((await post()).status, 400);
    });
  });

  describe("unrecorded_spend", () => {
    after(() => __setSettlementWriteForTest(null));

    it("a settlement write that fails after the paid call is reported and still thrown", async () => {
      __setSettlementWriteForTest(async () => { throw new Error("could not write"); });
      await assert.rejects(settleAtBound(4242), /could not write/);
      assert.deepEqual(of("unrecorded_spend").map((r) => r.extra), [{ what: "comparison_settlement", reservationId: 4242 }]);
    });

    it("a report that fails leaves the original error as the one thrown", async () => {
      __setSettlementWriteForTest(async () => { throw new Error("could not write"); });
      failingCapture();
      await assert.rejects(settleAtBound(1), /could not write/);
    });

    it("a settlement that succeeds reports nothing", async () => {
      __setSettlementWriteForTest(async () => {});
      await settleAtBound(1);
      assert.equal(of("unrecorded_spend").length, 0);
    });
  });
});
