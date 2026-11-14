/**
 * Boot-time engine reconciliation.
 *
 * Walks `ALL_ENGINES` (the typed code catalogue) and upserts each definition
 * into the `engines` table. Two-tier strategy:
 *
 *   - **Code-owned fields** are overwritten on every boot. These describe the
 *     pipeline contract — what fal accepts from the engine, how the wizard
 *     surfaces it. Editing them via SQL is meaningless because they get
 *     reset.
 *
 *   - **Preserved fields** (`RECONCILE_PRESERVED_FIELDS`) keep their stored
 *     value once the row exists. No admin screen edits them any more
 *     (decisions.md 2026-11-14), and the call-shaping ones among them are
 *     never read at run time; they are preserved so a code revert restores
 *     the old behaviour exactly.
 *
 *   - **Soft-deleted rows** stay soft-deleted. If an engine was archived, the next reconciliation does NOT resurrect it. Removing the
 *     engine's file from the code catalogue stops the row from updating
 *     but doesn't delete it either — lineage on video_jobs.video_engine_id
 *     stays intact.
 *
 * Called once from the server bootstrap (see app.ts).
 */

import { db } from "@workspace/db";
import { enginesTable, type InsertEngine } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { clearEngineCaches } from "../engineInterpreter";
import { ALL_ENGINES } from "./catalogue";
import { RECONCILE_PRESERVED_FIELDS, type EngineDefinition } from "./types";
import { codeDefinitionToRow } from "./toRow";

export { codeDefinitionToRow };

interface ReconcileResult {
  inserted: string[];
  updated: string[];
  preservedSoftDeleted: string[];
  totalCodeEngines: number;
}

/**
 * Reconciliation entrypoint. Idempotent — safe to call repeatedly.
 *
 * Steps per engine:
 *   1. Look up the existing row by id.
 *   2. If absent → insert the full code definition (admin fields use code
 *      defaults; deletedAt = null).
 *   3. If present and not soft-deleted → update only the code-owned fields;
 *      leave preserved fields and deletedAt alone.
 *   4. If present and soft-deleted → still update code-owned fields so the
 *      paramSchema stays accurate; do NOT touch deletedAt.
 */
export async function reconcileEngines(): Promise<ReconcileResult> {
  const inserted: string[] = [];
  const updated: string[] = [];
  const preservedSoftDeleted: string[] = [];

  for (const def of ALL_ENGINES) {
    const [existing] = await db
      .select()
      .from(enginesTable)
      .where(eq(enginesTable.id, def.id))
      .limit(1);

    if (!existing) {
      await db.insert(enginesTable).values(codeDefinitionToRow(def));
      inserted.push(def.id);
      continue;
    }

    if (existing.deletedAt != null) {
      // Soft-deleted: keep the tombstone but refresh code-owned fields so
      // any future un-archive lands on an up-to-date row.
      await db
        .update(enginesTable)
        .set(codeOwnedFields(def))
        .where(eq(enginesTable.id, def.id));
      preservedSoftDeleted.push(def.id);
      continue;
    }

    // Live row: refresh code-owned fields only.
    await db
      .update(enginesTable)
      .set(codeOwnedFields(def))
      .where(eq(enginesTable.id, def.id));
    updated.push(def.id);
  }

  clearEngineCaches();

  const result: ReconcileResult = {
    inserted,
    updated,
    preservedSoftDeleted,
    totalCodeEngines: ALL_ENGINES.length,
  };

  logger.info(result, "[engines/reconcile] boot reconciliation complete");
  return result;
}

/**
 * Subset of fields that reconciliation overwrites on every boot — i.e. the
 * "code is source of truth" fields. Excludes everything in
 * RECONCILE_PRESERVED_FIELDS (kept as stored) plus the auto-managed
 * created_at / updated_at columns.
 */
function codeOwnedFields(def: EngineDefinition): Partial<InsertEngine> {
  const allFields = { ...codeDefinitionToRow(def) } as Record<string, unknown>;
  // Remove the preserved fields.
  for (const field of RECONCILE_PRESERVED_FIELDS) {
    delete allFields[field];
  }
  // endpointId is preserved ONLY for LLM engines (where the retired model picker wrote it).
  // For media (fal) engines, code remains the source of truth for the
  // endpoint, so re-assert it on every boot.
  if (def.provider !== "openai") {
    allFields.endpointId = def.endpointId;
  }
  // `deletedAt` is also admin-owned (soft-delete via the dedicated DELETE
  // endpoint) but lives outside RECONCILE_PRESERVED_FIELDS because it's not
  // PATCH-editable. Reconciliation must never reset a tombstone.
  delete allFields.deletedAt;
  // Always refresh updated_at so we can see when reconciliation last touched
  // a row.
  allFields.updatedAt = new Date();
  return allFields as Partial<InsertEngine>;
}
