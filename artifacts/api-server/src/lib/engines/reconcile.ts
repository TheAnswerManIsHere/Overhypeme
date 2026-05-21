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
 *   - **Admin-tunable fields** are preserved across boots once the row first
 *     exists. These are the operational levers: isActive, isDefault,
 *     defaults, expectedRunMs, pricing fallbacks. Admins flip them in the
 *     `/admin/engines` page; reconciliation respects their value.
 *
 *   - **Soft-deleted rows** stay soft-deleted. If an admin archives an
 *     engine, the next reconciliation does NOT resurrect it. Removing the
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
import { ALL_ENGINES } from "./index";
import { ADMIN_EDITABLE_FIELDS, type EngineDefinition } from "./types";

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
 *      leave admin-tunable fields and deletedAt alone.
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

/** Full row insert — includes both code-owned and admin-tunable fields. */
function codeDefinitionToRow(def: EngineDefinition): InsertEngine {
  return {
    id: def.id,
    provider: def.provider,
    endpointId: def.endpointId,
    label: def.label,
    description: def.description,
    kind: def.kind,
    tierRequirement: def.tierRequirement,
    isDefault: def.isDefault,
    isActive: def.isActive,
    sortOrder: def.sortOrder,
    allowedDurationsSec: def.allowedDurationsSec,
    defaultDurationSec: def.defaultDurationSec,
    allowedResolutions: def.allowedResolutions,
    defaultResolution: def.defaultResolution,
    allowedAspectRatios: def.allowedAspectRatios,
    defaultAspectRatio: def.defaultAspectRatio,
    supportedModes: def.supportedModes,
    defaultMode: def.defaultMode,
    audioHandling: def.audioHandling,
    paramSchema: def.paramSchema,
    estimatedCostUsdPerCall:
      def.estimatedCostUsdPerCall != null ? String(def.estimatedCostUsdPerCall) : null,
    estimatedCostUsdPerSecond:
      def.estimatedCostUsdPerSecond != null ? String(def.estimatedCostUsdPerSecond) : null,
    expectedRunMs: def.expectedRunMs,
    featureFlagRequired: def.featureFlagRequired,
    deletedAt: null,
  };
}

/**
 * Subset of fields that reconciliation overwrites on every boot — i.e. the
 * "code is source of truth" fields. Excludes everything in
 * ADMIN_EDITABLE_FIELDS (which the admin panel owns) plus the auto-managed
 * created_at / updated_at columns.
 */
function codeOwnedFields(def: EngineDefinition): Partial<InsertEngine> {
  const allFields = { ...codeDefinitionToRow(def) } as Record<string, unknown>;
  // Remove admin-editable fields (preserved across boots).
  for (const field of ADMIN_EDITABLE_FIELDS) {
    delete allFields[field];
  }
  // `deletedAt` is also admin-owned (soft-delete via the dedicated DELETE
  // endpoint) but lives outside ADMIN_EDITABLE_FIELDS because it's not
  // PATCH-editable. Reconciliation must never reset a tombstone.
  delete allFields.deletedAt;
  // Always refresh updated_at so we can see when reconciliation last touched
  // a row.
  allFields.updatedAt = new Date();
  return allFields as Partial<InsertEngine>;
}
