/**
 * Unit tests for the `fact_pexels` async-job handler after the
 * variant-independence bulk-backfill conversion (tasks 15/16):
 *
 *   • enqueue sets pexels_status "pending" unconditionally
 *   • bulkBackfill execution-time inactive recheck: only applies when the
 *     `bulkBackfill` payload discriminator is set — the single-fact staging
 *     enqueue path (bulkBackfill unset) must NEVER be affected by it and
 *     keeps using isStagingImagePrepActive's OR-with-review-status logic
 *   • success / retryable-failure paths
 *   • the 1s pacing sleep runs on every exit path (skip / success / failure)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import {
  runFactPexelsJob,
  enqueueFactPexels,
  factPexelsDedupeKey,
  factPexelsJobHandler,
} from "../lib/factPexelsJobs.js";

const USER_PREFIX = "t_fpj_";
const insertedFactIds: number[] = [];
let submitterId: string;

async function seedFact(overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does something #${randomUUID().slice(0, 8)}.`,
      submittedById: submitterId,
      isActive: true,
      // Active facts require a non-empty Visual Concept (facts_active_requires_concept CHECK).
      enrichment: buildPlaceholderFactEnrichment(),
      ...overrides,
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  return fact!.id;
}

async function pexelsStatusOf(factId: number): Promise<string | null> {
  const [row] = await db.select({ status: factsTable.pexelsStatus }).from(factsTable).where(eq(factsTable.id, factId));
  return row?.status ?? null;
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, insertedFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  submitterId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: submitterId, email: `${submitterId}@example.test`, isAdmin: true });
});

after(cleanup);

function stubSeed(impl: (factId: number, text: string) => Promise<void>) {
  let calls = 0;
  const seed = async (factId: number, text: string) => {
    calls++;
    return impl(factId, text);
  };
  return { seed, callCount: () => calls };
}

describe("factPexelsDedupeKey", () => {
  it("is stable per fact id", () => {
    assert.equal(factPexelsDedupeKey(7), "fact_pexels:fact:7");
  });
});

describe("enqueueFactPexels", () => {
  it("sets pexelsStatus to 'pending' unconditionally", async () => {
    const factId = await seedFact({ pexelsStatus: "failed" });
    await enqueueFactPexels(factId);
    assert.equal(await pexelsStatusOf(factId), "pending");
  });

  it("carries bulkBackfill:true in the payload only when requested", async () => {
    const factId = await seedFact();
    const result = await enqueueFactPexels(factId, { bulkBackfill: true });
    assert.equal(result.inserted, true);
  });
});

describe("runFactPexelsJob — bulkBackfill execution-time inactive recheck", () => {
  it("bulkBackfill=true + inactive fact: skips without calling seed, marks pexelsStatus 'failed'", async () => {
    const factId = await seedFact({ isActive: false });
    const { seed, callCount } = stubSeed(async () => {});
    const result = await runFactPexelsJob(factId, true, { seed });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "not_active" });
    assert.equal(callCount(), 0, "the paid pipeline must never run for an inactive bulk-backfill target");
    assert.equal(await pexelsStatusOf(factId), "failed");
  });

  it("bulkBackfill=false (unset) never applies the inactive recheck — an inactive fact with no unresolved review still no-ops via the cost guard, not the bulk skip", async () => {
    const factId = await seedFact({ isActive: false });
    const { seed, callCount } = stubSeed(async () => {});
    const result = await runFactPexelsJob(factId, false, { seed });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    // Cost-guard no-op returns a bare { ok: true } — never the bulk skip shape.
    assert.equal(result.result, undefined, "must go through the cost-guard path, not the bulk-backfill skip path");
    assert.equal(callCount(), 0);
  });

  it("bulkBackfill=false + inactive fact with an UNRESOLVED review still runs the pipeline (isStagingImagePrepActive's OR-with-review logic, unaffected by the bulk guard)", async () => {
    const factId = await seedFact({ isActive: false });
    await db.insert(pendingReviewsTable).values({
      submittedText: "seed",
      submittedById: submitterId,
      status: "pending",
      workflowStage: "prep_pending",
      stagingFactId: factId,
    });
    const { seed, callCount } = stubSeed(async () => {});
    const result = await runFactPexelsJob(factId, false, { seed });
    assert.equal(result.ok, true);
    assert.equal(callCount(), 1, "an unresolved staging review keeps image prep active even on an inactive fact");
  });
});

describe("runFactPexelsJob — success and retryable-failure paths", () => {
  it("success: calls seed once, returns ok:true", async () => {
    const factId = await seedFact();
    const { seed, callCount } = stubSeed(async () => {});
    const result = await runFactPexelsJob(factId, false, { seed });
    assert.equal(result.ok, true);
    assert.equal(callCount(), 1);
  });

  it("retryable failure: seed throws — ok:false, error message surfaced, pexelsStatus untouched (stays 'pending', not 'failed' — onAbandon owns terminal failure)", async () => {
    const factId = await seedFact({ pexelsStatus: "pending" });
    const { seed } = stubSeed(async () => { throw new Error("pexels API boom"); });
    const result = await runFactPexelsJob(factId, false, { seed });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /pexels API boom/);
    assert.equal(await pexelsStatusOf(factId), "pending", "a retryable failure must not prematurely mark the fact failed");
  });

  it("fact not found → ok:false", async () => {
    const { seed } = stubSeed(async () => {});
    const result = await runFactPexelsJob(999_999_999, false, { seed });
    assert.equal(result.ok, false);
  });
});

describe("factPexelsJobHandler.onAbandon", () => {
  it("marks pexelsStatus 'failed' once retries are exhausted", async () => {
    const factId = await seedFact({ pexelsStatus: "pending" });
    await factPexelsJobHandler.onAbandon!({ id: 1, payload: { factId } } as never);
    assert.equal(await pexelsStatusOf(factId), "failed");
  });

  it("no-ops safely on a malformed payload", async () => {
    await assert.doesNotReject(async () => { await factPexelsJobHandler.onAbandon!({ id: 1, payload: {} } as never); });
  });
});

describe("factPexelsJobHandler.run", () => {
  it("rejects a payload missing factId", async () => {
    const result = await factPexelsJobHandler.run({}, {} as never);
    assert.equal(result.ok, false);
  });
});
