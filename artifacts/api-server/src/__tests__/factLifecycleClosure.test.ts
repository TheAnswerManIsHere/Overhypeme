/**
 * Phase 2 fact-lifecycle closure — core invariant tests.
 *
 * 1. The DB backstop: the `facts_active_requires_concept` CHECK constraint lets an
 *    active fact exist ONLY with a non-empty string Visual Concept at
 *    enrichment.visualPromptStrategyOverride.coreSceneOverride; inactive facts are
 *    unconstrained. (Raw-SQL negative tests — the true backstop below the app gate.)
 * 2. The activation chokepoint: activateFact is the sole is_active false->true
 *    writer. It requires the concept (ConceptMissingError), revalidates a variant's
 *    parent as an active root (ParentNotActiveError), and is a compare-and-set on
 *    the validated text (ActivationConflictError). Never activates on failure.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db, factsTable, pool } from "@workspace/db";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { eq, inArray, like, sql } from "drizzle-orm";

import {
  activateFact,
  cascadeDeactivateActiveChildren,
  ConceptMissingError,
  ParentNotActiveError,
  ActivationConflictError,
} from "../lib/factActivation.js";

const PREFIX = "t_lifecycle_closure_";
const ids: number[] = [];

async function cleanup() {
  const rows = await db.select({ id: factsTable.id }).from(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  if (rows.length) await db.delete(factsTable).where(inArray(factsTable.id, rows.map((r) => r.id)));
}

before(cleanup);
after(cleanup);

/** Insert a fact via raw SQL so we bypass Drizzle typing and hit the DB constraint directly. */
async function rawInsert(text: string, isActive: boolean, enrichment: unknown): Promise<void> {
  await db.execute(sql`
    INSERT INTO facts (text, is_active, enrichment)
    VALUES (${text}, ${isActive}, ${enrichment == null ? null : JSON.stringify(enrichment)}::jsonb)
  `);
}

describe("DB CHECK — facts_active_requires_concept", () => {
  it("ALLOWS an inactive fact with no concept", async () => {
    await rawInsert(`${PREFIX}inactive-noconcept`, false, null);
  });

  it("ALLOWS an active fact with a non-empty concept", async () => {
    await rawInsert(`${PREFIX}active-concept`, true, buildPlaceholderFactEnrichment("A hero stands tall."));
  });

  // The DB rejection surfaces through Drizzle's "Failed query" wrapper (the
  // constraint name lives in err.cause), so we assert the insert rejects AND that
  // no row landed — that combination is the CHECK doing its job (a plain
  // text+is_active+enrichment INSERT has no other reason to fail).
  async function assertRejectedAndNotWritten(text: string, run: () => Promise<unknown>) {
    await assert.rejects(run);
    const rows = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.text, text));
    assert.equal(rows.length, 0, "the rejected row must not exist");
  }

  it("REJECTS an active fact with null enrichment", async () => {
    await assertRejectedAndNotWritten(`${PREFIX}active-null`, () => rawInsert(`${PREFIX}active-null`, true, null));
  });

  it("REJECTS an active fact with a whitespace-only concept", async () => {
    await assertRejectedAndNotWritten(`${PREFIX}active-ws`, () => rawInsert(`${PREFIX}active-ws`, true, buildPlaceholderFactEnrichment("   ")));
  });

  it("REJECTS an active fact whose concept is a non-string JSON scalar", async () => {
    await assertRejectedAndNotWritten(`${PREFIX}active-num`, () => db.execute(sql`
      INSERT INTO facts (text, is_active, enrichment)
      VALUES (${`${PREFIX}active-num`}, true, ${'{"visualPromptStrategyOverride":{"version":1,"coreSceneOverride":42}}'}::jsonb)
    `));
  });
});

async function insertInactive(text: string, opts: { concept?: string | null; parentId?: number } = {}): Promise<number> {
  const enrichment = opts.concept === null ? undefined : buildPlaceholderFactEnrichment(opts.concept ?? "A hero stands tall.");
  const [row] = await db
    .insert(factsTable)
    .values({ text, isActive: false, parentId: opts.parentId, enrichment })
    .returning({ id: factsTable.id });
  ids.push(row.id);
  return row.id;
}

async function insertActive(text: string, opts: { parentId?: number } = {}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text, isActive: true, parentId: opts.parentId, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  ids.push(row.id);
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

  it("throws ConceptMissingError and does NOT activate a conceptless fact", async () => {
    const text = `${PREFIX}activate-noconcept`;
    const id = await insertInactive(text, { concept: null });
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: id, expectedText: text })),
      (err: unknown) => err instanceof ConceptMissingError,
    );
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.isActive, false, "must remain inactive");
  });

  it("throws ParentNotActiveError when a variant's parent is inactive (not an active root)", async () => {
    const parentId = await insertInactive(`${PREFIX}inactive-parent`); // parent stays inactive
    const text = `${PREFIX}variant-orphan`;
    const variantId = await insertInactive(text, { parentId });
    await assert.rejects(
      () => db.transaction((tx) => activateFact(tx, { factId: variantId, parentId, expectedText: text })),
      (err: unknown) => err instanceof ParentNotActiveError,
    );
    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, variantId));
    assert.equal(row.isActive, false);
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

describe("cascadeDeactivateActiveChildren", () => {
  it("deactivates only the currently-active children of the given fact", async () => {
    const rootId = await insertActive(`${PREFIX}cascade-root`);
    const activeChild = await insertActive(`${PREFIX}cascade-active-child`, { parentId: rootId });
    const alreadyInactiveChild = await insertInactive(`${PREFIX}cascade-inactive-child`, { parentId: rootId });
    const unrelated = await insertActive(`${PREFIX}cascade-unrelated`);

    const count = await db.transaction((tx) => cascadeDeactivateActiveChildren(tx, rootId));
    assert.equal(count, 1, "only the one active child should be reported deactivated");

    const rows = await db
      .select({ id: factsTable.id, isActive: factsTable.isActive })
      .from(factsTable)
      .where(inArray(factsTable.id, [rootId, activeChild, alreadyInactiveChild, unrelated]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    assert.equal(byId.get(rootId), true, "the root itself is untouched by the cascade call");
    assert.equal(byId.get(activeChild), false, "the active child is deactivated");
    assert.equal(byId.get(alreadyInactiveChild), false, "the already-inactive child is unaffected (still false)");
    assert.equal(byId.get(unrelated), true, "an unrelated active fact is untouched");
  });

  it("is a harmless no-op when called on a variant (which has no children)", async () => {
    const rootId = await insertActive(`${PREFIX}cascade-noop-root`);
    const variantId = await insertActive(`${PREFIX}cascade-noop-variant`, { parentId: rootId });
    const count = await db.transaction((tx) => cascadeDeactivateActiveChildren(tx, variantId));
    assert.equal(count, 0);
  });
});

describe("PATCH /admin/facts/:id — deactivating a root cascades to active variants", () => {
  it("cascades: deactivating an active root also deactivates its active children", async () => {
    const rootId = await insertActive(`${PREFIX}patch-cascade-root`);
    const childId = await insertActive(`${PREFIX}patch-cascade-child`, { parentId: rootId });

    // Exercise the exact write shape the admin.ts PATCH branch uses: update the
    // target then cascade in the same transaction when isActive is set false.
    await db.transaction(async (tx) => {
      await tx.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, rootId));
      await cascadeDeactivateActiveChildren(tx, rootId);
    });

    const rows = await db
      .select({ id: factsTable.id, isActive: factsTable.isActive })
      .from(factsTable)
      .where(inArray(factsTable.id, [rootId, childId]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    assert.equal(byId.get(rootId), false);
    assert.equal(byId.get(childId), false, "the variant must not be left active under an inactive root");
  });
});

describe("Migration 0092 orphan sweep — NOT EXISTS(active root parent)", () => {
  const sweepSql = sql`
    UPDATE "facts" AS f SET "is_active" = false
    WHERE f."is_active" = true
      AND f."parent_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "facts" AS p
        WHERE p."id" = f."parent_id" AND p."is_active" = true AND p."parent_id" IS NULL
      )
  `;

  it("deactivates an active variant whose parent row no longer exists (hard-deleted)", async () => {
    const rootId = await insertInactive(`${PREFIX}sweep-deleted-root`);
    const variantId = await insertActive(`${PREFIX}sweep-orphan-variant`, { parentId: rootId });
    // Hard-delete the parent, orphaning the variant's parent_id (no FK enforces referential integrity here).
    await db.delete(factsTable).where(eq(factsTable.id, rootId));
    ids.splice(ids.indexOf(rootId), 1);

    await db.execute(sweepSql);

    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, variantId));
    assert.equal(row.isActive, false, "an orphaned (parent-deleted) active variant must be swept inactive");
  });

  it("deactivates an active variant whose parent is inactive", async () => {
    const rootId = await insertInactive(`${PREFIX}sweep-inactive-root`);
    const variantId = await insertActive(`${PREFIX}sweep-inactive-parent-variant`, { parentId: rootId });

    await db.execute(sweepSql);

    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, variantId));
    assert.equal(row.isActive, false);
  });

  it("leaves an active variant under an active root untouched", async () => {
    const rootId = await insertActive(`${PREFIX}sweep-active-root`);
    const variantId = await insertActive(`${PREFIX}sweep-active-variant`, { parentId: rootId });

    await db.execute(sweepSql);

    const rows = await db
      .select({ id: factsTable.id, isActive: factsTable.isActive })
      .from(factsTable)
      .where(inArray(factsTable.id, [rootId, variantId]));
    for (const r of rows) assert.equal(r.isActive, true);
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
   * the dropped CHECK, since DDL is transactional in PostgreSQL.
   */
  async function backfill(seed: Array<{ key: string; active: boolean; archetype: string | null; enrichment: unknown }>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_active_requires_concept"');
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
    const enrichment = buildPlaceholderFactEnrichment("A hero stands tall.");
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
      { key: "no-archetype", active: true, archetype: null, enrichment: buildPlaceholderFactEnrichment("A hero stands tall.") },
      { key: "no-enrichment", active: true, archetype: "hero", enrichment: null },
    ]);
    assert.equal(result.get("no-archetype")!.is_active, false, "no projection: deactivated, not stamped");
    assert.equal(result.get("no-enrichment")!.is_active, false, "no enrichment: deactivated, not stamped");
    assert.equal(result.get("no-archetype")!.scene, "A hero stands tall.", "a deactivated row is not rewritten either");
  });
});
