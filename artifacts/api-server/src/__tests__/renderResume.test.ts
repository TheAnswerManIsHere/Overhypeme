/**
 * Job resume, increment 2 (plan docs/plans/PLAN_JOB_RESUME.md, Issue #1000):
 * the tile's progress mapping (§D), the ownership check at the shared AI
 * dispatch point (Issue #1010), and the render transport's history reading (§C).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { asyncJobsTable, imageGenerationRequestsTable } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import {
  __resetHandlersForTest,
  asyncJobsTick,
  enqueueJob,
  recoverStuckProcessing,
  registerJobHandler,
  JobOwnershipLostError,
  RECOVER_STUCK_CUTOFF_MIN,
} from "../lib/asyncJobs.js";
import { renderProgressByAttempt, renderProgressOf, type RenderJobState } from "../lib/renderProgress.js";
import { __setUtilityLLMClientForTest, callUtilityLLM } from "../lib/utilityLLM.js";
import { aiBackend } from "../lib/aiClients.js";
import { renderFal } from "../lib/renderFalTransport.js";

const QUEUE_PREFIX = "test_render_resume_";

describe("the tile's progress (plan §D): one mapping from the job, its lease and fal's progress", () => {
  const job = (over: Partial<RenderJobState>): RenderJobState => ({
    queue: "image_generation", status: "processing", attempts: 0, lastError: null, leaseLapsed: false, recovering: false, retryAhead: false, ...over,
  });

  it("maps every row of the plan's table", () => {
    assert.equal(renderProgressOf(job({ status: "pending" }), null), "queued", "job pending");
    assert.equal(renderProgressOf(job({ queue: "image_prompt_generation" }), null), "queued", "held and preparing (planning)");
    assert.equal(renderProgressOf(job({}), null), "queued", "held and preparing (submitting)");
    assert.equal(renderProgressOf(job({}), "IN_QUEUE"), "queued", "waiting in fal's queue");
    assert.equal(renderProgressOf(job({}), "IN_PROGRESS"), "drawing", "fal reports it in progress");
    assert.equal(renderProgressOf(job({ leaseLapsed: true }), "IN_PROGRESS"), "resuming", "the holder stopped: waiting for the reclaim");
    assert.equal(renderProgressOf(job({ status: "recovering" }), "IN_PROGRESS"), "resuming", "taken back, not yet claimed again");
    assert.equal(renderProgressOf(job({ recovering: true }), null), "resuming", "checking an interrupted request");
    assert.equal(renderProgressOf(job({ recovering: true }), "IN_PROGRESS"), "drawing", "a resumed run collecting a picture in progress");
    assert.equal(renderProgressOf(job({}), "COMPLETED"), "saving", "fal finished; storing");
    assert.equal(renderProgressOf(job({ status: "pending", attempts: 1, lastError: "fal submit failed: Bad Gateway", retryAhead: true }), null), "retrying");
  });

  it("a recovered job waiting out a retry reads 'retrying'; a fresh reclaim still reads 'resuming', even carrying an earlier error (PR #1017 round 1)", () => {
    const failed = { attempts: 1, lastError: "fal submit failed: Bad Gateway", recovering: true };
    assert.equal(renderProgressOf(job({ status: "recovering", ...failed, retryAhead: true }), null), "retrying", "failed after the reclaim; retry scheduled ahead");
    assert.equal(renderProgressOf(job({ status: "recovering", ...failed, retryAhead: false }), null), "resuming", "reclaimed after a stop; the error is from before it");
    assert.equal(renderProgressOf(job({ status: "recovering", recovering: true }), null), "resuming");
    assert.equal(renderProgressOf(job({ status: "pending", attempts: 1, lastError: "old", retryAhead: false }), null), "queued", "due now: about to run, not waiting");
  });

  it("reads it from the database: the latest in-flight job per render and its request's vendor status", async () => {
    const attemptId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const planner = await enqueueJob({ queue: "image_prompt_generation", payload: { attemptId }, dedupeKey: `image_prompt:attempt:${attemptId}` });
    try {
      assert.equal((await renderProgressByAttempt([attemptId])).get(attemptId), "queued");
      await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, planner.jobId));
      const image = await enqueueJob({ queue: "image_generation", payload: { attemptId }, dedupeKey: `image_generation:attempt:${attemptId}` });
      await db.execute(sql`UPDATE async_jobs SET status = 'processing', lease_token = 'tok', lease_expires_at = now() + interval '60 seconds' WHERE id = ${image.jobId}`);
      await db.insert(imageGenerationRequestsTable).values({
        producer: "review_render", endpointId: "fal-ai/test", request: {}, vendorRequestId: "v1", vendorStatus: "IN_PROGRESS", attemptId, actorKind: "system",
      });
      assert.equal((await renderProgressByAttempt([attemptId])).get(attemptId), "drawing");
      await db.execute(sql`UPDATE async_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${image.jobId}`);
      assert.equal((await renderProgressByAttempt([attemptId])).get(attemptId), "resuming", "the holder stopped renewing");
      // Reclaimed, carrying an error from an attempt before the stop: picking back up.
      await db.execute(sql`UPDATE async_jobs SET status = 'recovering', recovery_protocol = 1, lease_expires_at = NULL, attempts = 1, last_error = 'earlier failure', next_attempt_at = now() - interval '1 minute' WHERE id = ${image.jobId}`);
      assert.equal((await renderProgressByAttempt([attemptId])).get(attemptId), "resuming", "a fresh reclaim with an old error");
      // Then that recovered run failed and its retry is scheduled ahead: retrying.
      await db.execute(sql`UPDATE async_jobs SET attempts = 2, last_error = 'fal submit failed: Bad Gateway', next_attempt_at = now() + interval '5 minutes' WHERE id = ${image.jobId}`);
      assert.equal((await renderProgressByAttempt([attemptId])).get(attemptId), "retrying", "a recovered job waiting out its retry");
      await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, image.jobId));
      assert.equal((await renderProgressByAttempt([attemptId])).has(attemptId), false, "no job in flight: the attempt row says how it ended");
    } finally {
      await db.delete(asyncJobsTable).where(sql`${asyncJobsTable.dedupeKey} in (${`image_prompt:attempt:${attemptId}`}, ${`image_generation:attempt:${attemptId}`})`);
      await db.delete(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.attemptId, attemptId));
    }
  });
});

describe("Issue #1010: the shared AI dispatch point checks ownership; the refusal passes through the helpers", { concurrency: false }, () => {
  afterEach(async () => {
    __resetHandlersForTest();
    __setUtilityLLMClientForTest(null);
    await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
  });

  /** Run `body` inside a job whose lease lapses and is reclaimed before `body` runs. */
  async function inLostJob(body: () => Promise<void>): Promise<void> {
    const queue = `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let go!: () => void;
    const goP = new Promise<void>((r) => { go = r; });
    let bodyError: unknown = null;
    let runs = 0;
    registerJobHandler(queue, {
      async run() {
        // Only the first run is the one that lost its claim: the same tick may
        // claim the reclaimed row again, and that second run owns it.
        if (++runs > 1) return { ok: true };
        started();
        await goP;
        try { await body(); } catch (err) { bodyError = err; }
        return { ok: true };
      },
    });
    const { jobId } = await enqueueJob({ queue, payload: {}, maxAttempts: 1 });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await startedP;
    await db.execute(sql`UPDATE async_jobs SET lease_expires_at = now() - interval '1 second', claimed_at = now() - make_interval(mins => ${RECOVER_STUCK_CUTOFF_MIN + 1}) WHERE id = ${jobId}`);
    await recoverStuckProcessing(db);
    go();
    await tick;
    if (bodyError) throw bodyError;
  }

  it("a run that lost its claim makes no AI call: the dispatch refuses before the client is called", async () => {
    let calls = 0;
    __setUtilityLLMClientForTest({ chat: { completions: { create: async () => { calls++; return { choices: [] }; } } } } as never);
    await assert.rejects(
      inLostJob(async () => { await callUtilityLLM({ messages: [{ role: "user", content: "hi" }] }); }),
      JobOwnershipLostError,
    );
    assert.equal(calls, 0);
  });

  it("outside a job the dispatch is unchanged", async () => {
    let calls = 0;
    __setUtilityLLMClientForTest({ chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: "ok" } }] }; } } } } as never);
    await callUtilityLLM({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(calls, 1);
  });
});

describe("the render transport reads fal's history in full or not at all (plan §C)", () => {
  const live = aiBackend() === "vendors";

  it("an entry without its input makes the whole read fail (so the caller treats it as ambiguous)", { skip: !live && "the live transport is selected only under AI_BACKEND=vendors" }, async () => {
    const priorFetch = globalThis.fetch;
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = "test-fal-key";
    const pages = [
      { items: [{ request_id: "r1", json_input: { prompt: "a" } }], next_cursor: "c2" },
      { items: [{ request_id: "r2" }], next_cursor: null },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify(pages.shift()), { status: 200 })) as typeof fetch;
    try {
      await assert.rejects(renderFal().history("fal-ai/test", new Date()), /without its input/);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }
  });

  it("every page is read, following the cursor", { skip: !live && "the live transport is selected only under AI_BACKEND=vendors" }, async () => {
    const priorFetch = globalThis.fetch;
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = "test-fal-key";
    const urls: string[] = [];
    const pages = [
      { items: [{ request_id: "r1", json_input: { prompt: "a" } }], next_cursor: "c2" },
      { items: [{ request_id: "r2", json_input: { prompt: "b" } }], next_cursor: null },
    ];
    globalThis.fetch = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(pages.shift()), { status: 200 }); }) as typeof fetch;
    try {
      const entries = await renderFal().history("fal-ai/test", new Date("2026-11-17T12:00:00Z"));
      assert.deepEqual(entries.map((e) => e.requestId), ["r1", "r2"]);
      assert.match(urls[0]!, /expand=payloads/);
      assert.match(urls[1]!, /cursor=c2/);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }
  });
});
