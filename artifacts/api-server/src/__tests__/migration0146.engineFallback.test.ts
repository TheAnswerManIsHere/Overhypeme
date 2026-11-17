/**
 * Migration 0146_engine_fallback (plan docs/plans/PLAN_NB_FALLBACK.md, Data
 * Model): one nullable jsonb column, added expand-only, with no backfill. It is
 * idempotent (re-running changes nothing), leaves existing rows null, and keeps
 * a recorded fallback across a re-run, which is what the plan's rollback
 * ("revert the code, keep the column") relies on.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { factsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0146_engine_fallback.sql"), "utf8");

const factIds: number[] = [];
after(async () => {
  for (const id of factIds) await db.delete(factsTable).where(eq(factsTable.id, id));
});

describe("migration 0146_engine_fallback", () => {
  it("adds a nullable jsonb column, is idempotent, and keeps recorded values across a re-run", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    const cols = await db.execute<{ data_type: string; is_nullable: string }>(sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'image_prompt_attempts' AND column_name = 'engine_fallback'`);
    assert.equal(cols.rows.length, 1);
    assert.equal(cols.rows[0]!.data_type, "jsonb");
    assert.equal(cols.rows[0]!.is_nullable, "YES");

    const [fact] = await db.insert(factsTable).values({ text: "{NAME} lifts a truck.", isActive: false }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    const base = {
      factId: fact!.id, generationMode: "i2i", subjectRenderMode: "human_identity_i2i", targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
      factEnrichmentSnapshot: {} as never, archetypeStrategyVersion: "v2",
    };
    const [plain] = await db.insert(imagePromptAttemptsTable).values({ ...base, renderJobId: randomUUID() }).returning({ id: imagePromptAttemptsTable.id });
    const recorded = { state: "switched", routedEngineId: "gpt-image-2-6-edit", reason: "refused" };
    const [fell] = await db.insert(imagePromptAttemptsTable).values({ ...base, renderJobId: randomUUID(), engineFallback: recorded as never }).returning({ id: imagePromptAttemptsTable.id });

    await db.execute(sql.raw(MIGRATION_SQL)); // a second run changes nothing
    const [p] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, plain!.id));
    const [f] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, fell!.id));
    assert.equal(p!.engineFallback, null, "a row that never fell back stays null");
    assert.deepEqual(f!.engineFallback, recorded, "a recorded fallback survives");
  });
});
