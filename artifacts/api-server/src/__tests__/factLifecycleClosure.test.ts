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

import { db, factsTable } from "@workspace/db";
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
