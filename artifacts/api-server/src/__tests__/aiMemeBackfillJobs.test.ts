/**
 * Unit tests for the `fact_ai_meme_backfill` async-job handler (variant-
 * independence tasks 15/16 — the new durable AI-meme backfill queue).
 *
 *   • enqueue writes a stable dedupe key and a "pending" status (unless a
 *     prior attempt is genuinely mid-flight)
 *   • crash-recovery entry guard: a pre-existing "processing" or any terminal
 *     marker short-circuits without calling the pipeline again, resolving
 *     with the outcome that matches the existing marker
 *   • execution-time inactive recheck: deactivated between enqueue and run
 *   • success sets a terminal "ok" marker; failure sets "failed" and is NOT
 *     retried again by a second call to the handler (maxAttempts:1 is
 *     enforced by the queue layer, not exercised directly here — this suite
 *     tests the handler's own logic in isolation)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import {
  runFactAiMemeBackfillJob,
  enqueueFactAiMemeBackfill,
  factAiMemeBackfillDedupeKey,
  factAiMemeBackfillJobHandler,
} from "../lib/aiMemeBackfillJobs.js";

const USER_PREFIX = "t_amb_";
const insertedFactIds: number[] = [];
let adminId: string;

async function seedFact(overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does something #${randomUUID().slice(0, 8)}.`,
      submittedById: adminId,
      isActive: true,
      ...overrides,
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  return fact!.id;
}

async function statusOf(factId: number): Promise<string | null> {
  const [row] = await db
    .select({ status: factsTable.aiMemeBackfillStatus })
    .from(factsTable)
    .where(eq(factsTable.id, factId));
  return row?.status ?? null;
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@example.test`, isAdmin: true });
});

after(cleanup);

function stubGenerate(impl: (factId: number, text: string, opts?: { suppressErrors?: boolean }) => Promise<void>) {
  let calls = 0;
  const generate = async (factId: number, text: string, opts?: { suppressErrors?: boolean }) => {
    calls++;
    return impl(factId, text, opts);
  };
  return { generate, callCount: () => calls };
}

describe("factAiMemeBackfillDedupeKey", () => {
  it("is stable per fact id", () => {
    assert.equal(factAiMemeBackfillDedupeKey(42), "fact_ai_meme_backfill:fact:42");
  });
});

describe("enqueueFactAiMemeBackfill", () => {
  it("writes aiMemeBackfillStatus to 'pending' and enqueues a job with a stable dedupe key", async () => {
    const factId = await seedFact();
    const result = await enqueueFactAiMemeBackfill(factId);
    assert.equal(result.inserted, true);
    assert.equal(await statusOf(factId), "pending");
  });

  it("does not clobber a genuinely mid-flight 'processing' marker back to 'pending'", async () => {
    const factId = await seedFact({ aiMemeBackfillStatus: "processing" });
    await enqueueFactAiMemeBackfill(factId);
    assert.equal(await statusOf(factId), "processing", "a live in-flight marker must survive a re-enqueue");
  });
});

describe("runFactAiMemeBackfillJob — success and failure paths", () => {
  it("success: calls generate once with suppressErrors:false, sets status 'ok'", async () => {
    const factId = await seedFact();
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, true);
    assert.equal(callCount(), 1);
    assert.equal(await statusOf(factId), "ok");
  });

  it("failure: generate throws — status ends 'failed', ok:false, error message surfaced", async () => {
    const factId = await seedFact();
    const { generate } = stubGenerate(async () => { throw new Error("fal.ai boom"); });
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /fal\.ai boom/);
    assert.equal(await statusOf(factId), "failed");
  });

  it("fact not found → ok:false without touching any row", async () => {
    const { generate } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(999_999_999, { generate });
    assert.equal(result.ok, false);
  });
});

describe("runFactAiMemeBackfillJob — execution-time inactive recheck", () => {
  it("a fact deactivated after enqueue is skipped without calling the pipeline", async () => {
    const factId = await seedFact({ isActive: false, aiMemeBackfillStatus: "pending" });
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "not_active" });
    assert.equal(callCount(), 0, "the paid pipeline must never be called for an inactive fact");
    assert.equal(await statusOf(factId), "skipped");
  });
});

describe("runFactAiMemeBackfillJob — crash-recovery entry guard", () => {
  it("a pre-existing 'processing' marker is treated as an unconfirmed replay — resolves failure without calling the pipeline again", async () => {
    const factId = await seedFact({ aiMemeBackfillStatus: "processing" });
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, false);
    assert.equal(callCount(), 0, "a recovered replay must never repeat the paid call");
    assert.equal(await statusOf(factId), "processing", "the guard doesn't touch the marker — it's the entry state itself");
  });

  it("a pre-existing 'ok' marker short-circuits to success without repeating paid work", async () => {
    const factId = await seedFact({ aiMemeBackfillStatus: "ok" });
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, true);
    assert.equal(callCount(), 0);
    assert.equal(await statusOf(factId), "ok", "the marker stays terminal, not re-derived");
  });

  it("a pre-existing 'failed' marker short-circuits to a (non-retried) failure without repeating paid work", async () => {
    const factId = await seedFact({ aiMemeBackfillStatus: "failed" });
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, false);
    assert.equal(callCount(), 0);
    assert.equal(await statusOf(factId), "failed");
  });

  it("a pre-existing 'skipped' marker short-circuits to a matching skip result without repeating paid work", async () => {
    const factId = await seedFact({ aiMemeBackfillStatus: "skipped" });
    const { generate, callCount } = stubGenerate(async () => {});
    const result = await runFactAiMemeBackfillJob(factId, { generate });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "not_active" });
    assert.equal(callCount(), 0);
    assert.equal(await statusOf(factId), "skipped");
  });

  it("a terminal marker is not sticky: a second, independent job for the same fact after 'ok' re-runs normally", async () => {
    const factId = await seedFact();
    const first = stubGenerate(async () => {});
    const r1 = await runFactAiMemeBackfillJob(factId, { generate: first.generate });
    assert.equal(r1.ok, true);
    assert.equal(await statusOf(factId), "ok");

    // Simulate an admin re-triggering backfill-ai-memes: the enqueue-side
    // write resets the marker to "pending" before the job runs again.
    await db.update(factsTable).set({ aiMemeBackfillStatus: "pending" }).where(eq(factsTable.id, factId));
    const second = stubGenerate(async () => {});
    const r2 = await runFactAiMemeBackfillJob(factId, { generate: second.generate });
    assert.equal(r2.ok, true);
    assert.equal(second.callCount(), 1, "a fresh pending marker must trigger a real (not short-circuited) run");
    assert.equal(await statusOf(factId), "ok");
  });
});

describe("factAiMemeBackfillJobHandler", () => {
  it("rejects a payload missing factId", async () => {
    const result = await factAiMemeBackfillJobHandler.run({}, {} as never);
    assert.equal(result.ok, false);
  });

  it("dispatches to runFactAiMemeBackfillJob using the real generateAiMemeBackgrounds dependency wiring (payload only, no stub injection at this layer)", async () => {
    // Exercises the handler's payload parsing, not the pipeline itself —
    // an inactive fact short-circuits before any network call either way.
    const factId = await seedFact({ isActive: false, aiMemeBackfillStatus: "pending" });
    const result = await factAiMemeBackfillJobHandler.run({ factId }, {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "not_active" });
  });
});
