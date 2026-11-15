/**
 * The retired `fact_ai_meme_backfill` queue (compiler review, Phase 2: every
 * picture starts from a photo). A job left in the queue ends without starting
 * any generation, and a fact's terminal marker is kept.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import {
  runFactAiMemeBackfillJob,
  factAiMemeBackfillJobHandler,
  RETIRED_SKIP_RESULT,
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
      // Active facts require a non-empty Visual Concept (facts_active_requires_concept CHECK).
      enrichment: buildPlaceholderFactEnrichment(),
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

describe("the retired fact_ai_meme_backfill handler", () => {
  for (const before of [null, "pending", "processing"] as const) {
    it(`ends a job whose marker is ${before ?? "unset"} as skipped, generating nothing`, async () => {
      const factId = await seedFact({ aiMemeBackfillStatus: before });
      const result = await runFactAiMemeBackfillJob(factId);
      assert.deepEqual(result, { ok: true, result: RETIRED_SKIP_RESULT });
      assert.equal(await statusOf(factId), "skipped");
    });
  }

  for (const terminal of ["ok", "failed", "skipped"] as const) {
    it(`keeps a fact's terminal '${terminal}' marker`, async () => {
      const factId = await seedFact({ aiMemeBackfillStatus: terminal });
      await runFactAiMemeBackfillJob(factId);
      assert.equal(await statusOf(factId), terminal);
    });
  }

  it("reports a missing fact and a malformed payload as failures", async () => {
    assert.equal((await runFactAiMemeBackfillJob(-1)).ok, false);
    assert.equal((await factAiMemeBackfillJobHandler.run({}, {} as never)).ok, false);
  });
});
