/**
 * Phase 2 fact-lifecycle closure — core invariant tests.
 *
 * 1. The DB backstop (since migration 0139, the deferred trigger
 *    enforce_live_fact_has_approved_gag: an active fact must have an approved
 *    gag in fact_gags) is tested by raw SQL in factGags.dbRules.test.ts. It
 *    replaced the facts_active_requires_concept CHECK on the enrichment blob.
 * 2. The activation chokepoint: activateFact is the sole is_active false->true
 *    writer. It requires an approved gag (ConceptMissingError) and is a
 *    compare-and-set on the validated text (ActivationConflictError). Never
 *    activates on failure.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db, factsTable, factGagsTable, usersTable, pool } from "@workspace/db";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";
import { eq, inArray, like } from "drizzle-orm";

import {
  activateFact,
  recordFirstApproval,
  ConceptMissingError,
  ActivationConflictError,
} from "../lib/factActivation.js";

const PREFIX = "t_lifecycle_closure_";
const ids: number[] = [];

async function cleanup() {
  const rows = await db.select({ id: factsTable.id }).from(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  if (rows.length) await db.delete(factsTable).where(inArray(factsTable.id, rows.map((r) => r.id)));
}

const ADMIN = `${PREFIX}admin`;
const OTHER_ADMIN = `${PREFIX}admin2`;

before(async () => {
  await cleanup();
  await db.insert(usersTable).values([{ id: ADMIN }, { id: OTHER_ADMIN }]).onConflictDoNothing();
});
after(async () => {
  await cleanup();
  await db.delete(usersTable).where(inArray(usersTable.id, [ADMIN, OTHER_ADMIN]));
});

/**
 * An inactive fact, with an approved gag unless `gag` says otherwise: "approved"
 * (the default), "pending" (saved, never approved) or null (none).
 */
async function insertInactive(text: string, opts: { gag?: "approved" | "pending" | null } = {}): Promise<number> {
  const gag = opts.gag === undefined ? "approved" : opts.gag;
  const [row] = await db
    .insert(factsTable)
    .values({ text, isActive: false, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  ids.push(row.id);
  if (gag === "approved") {
    await db.insert(factGagsTable).values({ factId: row.id, slot: 1, approvedContent: buildPlaceholderGag("A hero stands tall."), approvedCarriedOver: true });
  } else if (gag === "pending") {
    await db.insert(factGagsTable).values({ factId: row.id, slot: 1, pendingContent: buildPlaceholderGag("A hero stands tall.") });
  }
  return row.id;
}

describe("activateFact — the sole activation chokepoint", () => {
  it("activates an inactive fact that has a concept + matching text", async () => {
    const text = `${PREFIX}activate-ok`;
    const id = await insertInactive(text);
    await db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text }));
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.isActive, true);
  });

  it("records the first approval, and a second never rewrites it", async () => {
    const text = `${PREFIX}approval-record`;
    const id = await insertInactive(text);
    await db.transaction(async (tx) => {
      await activateFact(tx, { factId: id, expectedText: text });
      await recordFirstApproval(tx, id, ADMIN);
    });
    const read = async () => (await db.select({ at: factsTable.approvedAt, by: factsTable.approvedById, source: factsTable.approvalSource })
      .from(factsTable).where(eq(factsTable.id, id)))[0];
    const first = await read();
    assert.ok(first.at, "approved_at is set");
    assert.equal(first.by, ADMIN);
    assert.equal(first.source, "moderator");
    await db.transaction((tx) => recordFirstApproval(tx, id, OTHER_ADMIN));
    assert.deepEqual(await read(), first, "the first approval stays on record");
  });

  it("throws ConceptMissingError and does NOT activate a fact with only a pending (never approved) gag", async () => {
    const text = `${PREFIX}activate-pending-gag`;
    const id = await insertInactive(text, { gag: "pending" });
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text })),
      (err: unknown) => err instanceof ConceptMissingError,
    );
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.isActive, false, "must remain inactive");
  });

  it("throws ConceptMissingError and does NOT activate a fact with no gag", async () => {
    const text = `${PREFIX}activate-noconcept`;
    const id = await insertInactive(text, { gag: null });
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text })),
      (err: unknown) => err instanceof ConceptMissingError,
    );
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.isActive, false, "must remain inactive");
  });

  it("throws ActivationConflictError when the text changed under it (compare-and-set)", async () => {
    const text = `${PREFIX}activate-cas`;
    const id = await insertInactive(text);
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: id, expectedText: `${text}-STALE` })),
      (err: unknown) => err instanceof ActivationConflictError,
    );
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.isActive, false);
  });

  it("throws ActivationConflictError when the enrichment changed under it (concurrent Visual Concept edit)", async () => {
    const text = `${PREFIX}activate-enrichment-cas`;
    const id = await insertInactive(text);
    const [row] = await db.select({ enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, id));
    const staleEnrichment = { ...(row.enrichment as object), taxonomyConfidence: 0.01 };
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text, expectedEnrichment: staleEnrichment })),
      (err: unknown) => err instanceof ActivationConflictError,
    );
    const [after] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(after.isActive, false, "must remain inactive — the row's enrichment no longer matches what was reviewed");
  });

  it("activates normally when expectedEnrichment matches the row's current enrichment exactly", async () => {
    const text = `${PREFIX}activate-enrichment-match`;
    const id = await insertInactive(text);
    const [row] = await db.select({ enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, id));
    await db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text, expectedEnrichment: row.enrichment }));
    const [after] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(after.isActive, true);
  });
});

describe("Migration 0092 backfill block — the real statements", () => {
  // Runs the migration's own first DO block (grandfather deactivation, orphan
  // sweep and sentinel stamp), not a copy of it, so a change to the migration's
  // SQL is what these tests see. The block is cut at its `END $$;`, which leaves
  // the CHECK-adding block behind.
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationSql = fs.readFileSync(
    path.resolve(dirname, "../../../../lib/db/migrations/0092_fact_lifecycle_phase2_backfill_check.sql"),
    "utf-8",
  );
  const blockStart = migrationSql.indexOf("DO $$");
  const blockEnd = migrationSql.indexOf("END $$;", blockStart) + "END $$;".length;
  const BACKFILL_BLOCK = migrationSql.slice(blockStart, blockEnd);
  const SENTINEL = "{NAME} stands there confidently.";

  type FactState = { is_active: boolean; scene: string | null; version: unknown; enrichment: unknown };

  /**
   * Seeds the pre-0092 world (active facts the CHECK would now refuse), runs the
   * backfill block, reads the rows back, and rolls everything back — including
   * the dropped CHECK and the re-added parent link, since DDL is transactional
   * in PostgreSQL.
   */
  async function backfill(seed: Array<{ key: string; active: boolean; archetype: string | null; enrichment: unknown }>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_active_requires_concept"');
      // The pre-0139 world too: no live-fact trigger, gags in the enrichment.
      await client.query('ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_enrichment_holds_no_gag"');
      await client.query('DROP TRIGGER IF EXISTS "facts_live_requires_approved_gag" ON "facts"');
      // ...and the pre-0142 parent link the block's orphan sweep reads.
      await client.query('ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "parent_id" integer');
      const idByKey = new Map<string, number>();
      for (const row of seed) {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO facts (text, is_active, primary_archetype, enrichment) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
          [`${PREFIX}0092-${row.key}`, row.active, row.archetype, row.enrichment == null ? null : JSON.stringify(row.enrichment)],
        );
        idByKey.set(row.key, rows[0]!.id);
      }
      await client.query(BACKFILL_BLOCK);
      const out = new Map<string, FactState>();
      for (const [key, id] of idByKey) {
        const { rows } = await client.query<FactState>(
          `SELECT is_active,
                  enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}' AS scene,
                  enrichment #> '{visualPromptStrategyOverride,version}' AS version,
                  enrichment
             FROM facts WHERE id = $1`,
          [id],
        );
        out.set(key, rows[0]!);
      }
      return out;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  it("leaves an active fact with a projection and a non-empty scene active, with its scene unchanged", async () => {
    const enrichment = { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: buildPlaceholderGag("A hero stands tall.") };
    const result = await backfill([{ key: "has-scene", active: true, archetype: "hero", enrichment }]);
    const row = result.get("has-scene")!;
    assert.equal(row.is_active, true);
    assert.equal(row.scene, "A hero stands tall.", "an existing scene must not be overwritten by the sentinel");
    assert.deepEqual(row.enrichment, JSON.parse(JSON.stringify(enrichment)), "the whole enrichment is untouched");
  });

  it("stamps '{NAME} stands there confidently.' on an active fact with a projection and no scene, leaving it active", async () => {
    const result = await backfill([
      { key: "no-vso", active: true, archetype: "hero", enrichment: { note: "no override object at all" } },
      { key: "blank-scene", active: true, archetype: "hero", enrichment: { visualPromptStrategyOverride: { version: 1, coreSceneOverride: "   " } } },
    ]);
    for (const key of ["no-vso", "blank-scene"]) {
      const row = result.get(key)!;
      assert.equal(row.is_active, true, `${key} must stay live`);
      assert.equal(row.scene, SENTINEL, `${key} must be stamped with the placeholder scene`);
      assert.equal(row.version, 1, `${key}: the override object is versioned 1`);
    }
  });

  it("sets is_active false on an active fact whose primary_archetype or enrichment is null", async () => {
    const result = await backfill([
      { key: "no-archetype", active: true, archetype: null, enrichment: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: buildPlaceholderGag("A hero stands tall.") } },
      { key: "no-enrichment", active: true, archetype: "hero", enrichment: null },
    ]);
    assert.equal(result.get("no-archetype")!.is_active, false, "no projection: deactivated, not stamped");
    assert.equal(result.get("no-enrichment")!.is_active, false, "no enrichment: deactivated, not stamped");
    assert.equal(result.get("no-archetype")!.scene, "A hero stands tall.", "a deactivated row is not rewritten either");
  });
});
