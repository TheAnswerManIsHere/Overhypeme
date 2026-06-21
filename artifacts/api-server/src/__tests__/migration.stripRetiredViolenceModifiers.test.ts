/**
 * Fixture test for migration 0073_strip_retired_violence_modifiers.
 *
 * Seeds facts + a pending review carrying the retired `avoid_gore` /
 * `non_graphic_action` modifiers across every runtime source (effective,
 * AI-derived, override value, override overriddenFrom), then runs the migration's
 * SQL and asserts: retired terms stripped, non-retired order preserved,
 * all-removed arrays collapse to [], and a /modifiers override that matches the
 * cleaned AI baseline is dropped.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0073_strip_retired_violence_modifiers.sql"),
  "utf8",
);

const TEXT_PREFIX = "t_strip0073 ";
const factIds: number[] = [];
const reviewIds: number[] = [];

async function insertFact(values: Record<string, unknown>): Promise<number> {
  const [row] = await db.insert(factsTable)
    .values({ text: `${TEXT_PREFIX}${randomUUID()}`, ...values } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  factIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (factIds.length) { await db.delete(factsTable).where(inArray(factsTable.id, factIds)); factIds.length = 0; }
  if (reviewIds.length) { await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds)); reviewIds.length = 0; }
}

before(cleanup);
after(cleanup);

describe("migration 0073 — strip retired violence modifiers", () => {
  it("cleans every runtime source, preserves order, and drops a now-redundant /modifiers override", async () => {
    // Fact A: retired terms mixed into effective + AI-derived; order matters.
    const aId = await insertFact({
      enrichment: { modifiers: ["projectile_impact_power", "avoid_gore", "non_graphic_action", "cinematic_aftermath"] },
      enrichmentAiDerived: { modifiers: ["projectile_impact_power", "avoid_gore", "cinematic_aftermath"] },
    });
    // Fact B: an array that is ENTIRELY retired terms → must become [].
    const bId = await insertFact({
      enrichment: { modifiers: ["avoid_gore", "non_graphic_action"] },
    });
    // Fact C: a /modifiers override whose value, once cleaned, equals the cleaned
    // AI baseline → the override entry should be removed entirely.
    const cId = await insertFact({
      enrichmentAiDerived: { modifiers: ["projectile_impact_power"] },
      enrichmentOverrides: {
        "/modifiers": {
          value: ["projectile_impact_power", "avoid_gore"],
          overriddenFrom: ["projectile_impact_power", "non_graphic_action"],
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      },
    });
    // Fact D: a /modifiers override that still diverges after cleaning → kept.
    const dId = await insertFact({
      enrichmentAiDerived: { modifiers: ["projectile_impact_power"] },
      enrichmentOverrides: {
        "/modifiers": { value: ["avoid_gore", "wholesome"], overriddenFrom: ["projectile_impact_power"], createdAt: "2026-06-21T00:00:00.000Z" },
      },
    });
    // Pending review.
    const [pr] = await db.insert(pendingReviewsTable)
      .values({ submittedText: `${TEXT_PREFIX}${randomUUID()}`, enrichment: { modifiers: ["non_graphic_action", "action_comedy"] } } as typeof pendingReviewsTable.$inferInsert)
      .returning({ id: pendingReviewsTable.id });
    reviewIds.push(pr.id);

    await db.execute(sql.raw(MIGRATION_SQL));

    const facts = await db.select().from(factsTable).where(inArray(factsTable.id, factIds));
    const byId = new Map(facts.map((f) => [f.id, f]));
    const mods = (f: { enrichment: unknown } | undefined) => (f?.enrichment as { modifiers?: string[] })?.modifiers;
    const aiMods = (f: { enrichmentAiDerived: unknown } | undefined) => (f?.enrichmentAiDerived as { modifiers?: string[] })?.modifiers;

    // A: retired removed, order preserved.
    assert.deepEqual(mods(byId.get(aId)), ["projectile_impact_power", "cinematic_aftermath"]);
    assert.deepEqual(aiMods(byId.get(aId)), ["projectile_impact_power", "cinematic_aftermath"]);
    // B: all-retired → [].
    assert.deepEqual(mods(byId.get(bId)), []);
    // C: redundant override dropped.
    assert.deepEqual(byId.get(cId)!.enrichmentOverrides, {});
    // D: still-divergent override kept but cleaned (value + overriddenFrom).
    const dOv = byId.get(dId)!.enrichmentOverrides as Record<string, { value: string[]; overriddenFrom: string[] }>;
    assert.deepEqual(dOv["/modifiers"].value, ["wholesome"]);
    assert.deepEqual(dOv["/modifiers"].overriddenFrom, ["projectile_impact_power"]);

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, pr.id));
    assert.deepEqual((review.enrichment as { modifiers: string[] }).modifiers, ["action_comedy"]);

    // Zero-occurrence invariant across the seeded rows.
    const probe = await db.select({ id: factsTable.id }).from(factsTable).where(
      and(
        inArray(factsTable.id, factIds),
        sql`(${factsTable.enrichment}::text LIKE '%avoid_gore%' OR ${factsTable.enrichment}::text LIKE '%non_graphic_action%' OR coalesce(${factsTable.enrichmentAiDerived}::text,'') LIKE '%avoid_gore%' OR ${factsTable.enrichmentOverrides}::text LIKE '%avoid_gore%' OR ${factsTable.enrichmentOverrides}::text LIKE '%non_graphic_action%')`,
      ),
    );
    assert.equal(probe.length, 0);
  });
});
