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
});
