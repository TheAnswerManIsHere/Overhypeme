/**
 * The override-LAYER machinery shared by every enrichment editing surface:
 * the live-fact endpoints (routes/admin.ts) and the refresh-candidate
 * endpoints (routes/reviews.ts). Extracted verbatim from admin.ts so the two
 * write paths can never drift on the subtle semantics: reset-when-equal-to-AI,
 * acknowledge-current-baseline, archetype→subtype auto-linking, full-effective
 * cross-field validation, and visual-override provenance stamping.
 *
 * This module is PURE with respect to persistence: it loads/computes layers and
 * returns the next override map + a change list. Callers own their own row
 * locks, write freeze checks, materialization target (facts.* vs the version
 * row), and audit semantics (history rows for facts; none for candidates).
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import {
  isOverridablePath,
  overrideValuesEqual,
  pathToField,
  resolveEnrichment,
  subtypesForArchetype,
  validateOverrideValue,
  type EnrichmentOverrides,
  type FactEnrichment,
  type OverridablePath,
  type PrimaryArchetype,
} from "@workspace/api-zod";

// Transaction type, inferred from the db.transaction callback parameter.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The override layers (+ derived effective) of an enrichment record — a live
 * fact's columns or a refresh candidate version's columns. A fact's gags live
 * in fact_gags (migration 0139), so no layer carries one.
 */
export interface OverrideLayers {
  aiDerived: FactEnrichment | null;
  overrides: EnrichmentOverrides;
  effective: FactEnrichment | null;
  enrichmentStatus: string | null;
}

/** Load the override layers for a LIVE fact, normalizing legacy rows (a null
 * enrichment_ai_derived takes the current effective as its baseline; an
 * enrichment cannot hold a gag since migration 0139). */
export async function loadFactOverrideState(
  executor: typeof db | DbTx,
  factId: number,
  forUpdate = false,
): Promise<OverrideLayers | null> {
  const base = executor
    .select({
      enrichment: factsTable.enrichment,
      enrichmentAiDerived: factsTable.enrichmentAiDerived,
      enrichmentOverrides: factsTable.enrichmentOverrides,
      enrichmentStatus: factsTable.enrichmentStatus,
    })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  const [row] = forUpdate ? await base.for("update") : await base;
  if (!row) return null;
  const effective = (row.enrichment ?? null) as FactEnrichment | null;
  const aiDerived = (row.enrichmentAiDerived as FactEnrichment | null) ?? effective;
  const overrides = (row.enrichmentOverrides ?? {}) as EnrichmentOverrides;
  return { aiDerived, overrides, effective, enrichmentStatus: row.enrichmentStatus ?? null };
}

/** Ensure the EFFECTIVE subtype is valid for the EFFECTIVE archetype, creating
 * (or dropping) a `/subtype` override as needed. Mutates `overrides` in place;
 * returns the auto-link audit detail (or null when nothing changed). */
export function ensureSubtypeCompatible(args: {
  overrides: EnrichmentOverrides;
  aiDerived: FactEnrichment;
  adminId: string | null;
}): { oldValue: unknown; newValue: unknown } | null {
  const { overrides, aiDerived, adminId } = args;
  const effArchetype = (overrides["/primaryArchetype"]?.value ?? aiDerived.primaryArchetype) as PrimaryArchetype;
  const effSubtype = overrides["/subtype"]?.value ?? aiDerived.subtype;
  const allowed = subtypesForArchetype(effArchetype) as readonly string[];
  if (allowed.includes(effSubtype as string)) return null;
  const newSubtype = allowed[0];
  const prev = effSubtype;
  if (overrideValuesEqual(newSubtype, aiDerived.subtype)) {
    // The AI subtype is the compatible default → no override needed.
    delete overrides["/subtype"];
  } else {
    const now = new Date().toISOString();
    overrides["/subtype"] = {
      value: newSubtype,
      overriddenFrom: aiDerived.subtype,
      aiGenerationId: aiDerived.aiGenerationId,
      createdAt: now,
      createdBy: adminId,
      reason: "Auto-adjusted to match Primary Archetype override",
      autoLinked: true,
    };
  }
  return { oldValue: prev, newValue: newSubtype };
}

/** Shape the GET-resolved / PUT / DELETE response. */
export function serializeResolved(s: {
  aiDerived: FactEnrichment | null;
  overrides: EnrichmentOverrides;
  effective: FactEnrichment | null;
  enrichmentStatus: string | null;
}): Record<string, unknown> {
  if (!s.aiDerived) {
    return {
      aiDerived: null,
      overrides: {},
      effective: s.effective,
      overrideSummary: {
        hasOverrides: false, overriddenPaths: [], baselineChangedPaths: [],
        invalidPaths: [], crossFieldInvalid: false,
        hasVisualStrategyOverride: false,
      },
      enrichmentStatus: s.enrichmentStatus,
    };
  }
  const { effective, summary } = resolveEnrichment({
    aiDerived: s.aiDerived,
    overrides: s.overrides,
  });
  return {
    aiDerived: s.aiDerived,
    overrides: s.overrides,
    effective,
    overrideSummary: summary,
    enrichmentStatus: s.enrichmentStatus,
  };
}

/** One override-map mutation, for the caller to map to its own audit shape
 * (history rows for fact routes; dropped for candidate routes). */
export interface OverrideChange {
  path: OverridablePath;
  action: "set" | "update" | "reset" | "auto_linked";
  oldValue: unknown;
  newValue: unknown;
  aiGenerationId: string | null;
  reason: string | null;
}

export type ApplyOverrideResult =
  | { ok: true; overrides: EnrichmentOverrides; changes: OverrideChange[] }
  | { ok: false; status: 400; error: string };

/**
 * THE override-merge core (extracted from the fact PUT handler): create/update/
 * reset one override against the layers, with reset-when-equal-to-AI,
 * acknowledge-current-baseline semantics, `/primaryArchetype` → `/subtype`
 * auto-linking, and full-effective cross-field validation. Pure — returns the
 * NEXT override map + change list; the caller persists.
 */
export function applyOverrideUpsert(args: {
  layers: OverrideLayers & { aiDerived: FactEnrichment };
  path: string;
  value: unknown;
  reason?: string;
  acknowledge: boolean;
  adminId: string | null;
}): ApplyOverrideResult {
  const { layers, value: rawValue, reason, acknowledge, adminId } = args;
  const { aiDerived } = layers;
  if (!isOverridablePath(args.path)) {
    return { ok: false, status: 400, error: `Path "${args.path}" is not an overridable field` };
  }
  const path = args.path;

  const valid = validateOverrideValue(path, rawValue);
  if (!valid.ok) return { ok: false, status: 400, error: `Invalid value for ${path}: ${valid.error}` };
  const value = valid.value;
  const aiGenerationId = aiDerived.aiGenerationId;
  const aiNow = (aiDerived as Record<string, unknown>)[pathToField(path)];

  const overrides: EnrichmentOverrides = { ...layers.overrides };
  const changes: OverrideChange[] = [];
  const existing = overrides[path];

  if (overrideValuesEqual(value, aiNow)) {
    // Setting a field back to its AI value is a reset.
    if (existing) {
      delete overrides[path];
      changes.push({ path, action: "reset", oldValue: existing.value ?? null, newValue: null, aiGenerationId: aiGenerationId ?? null, reason: reason ?? null });
    }
  } else if (!existing) {
    const now = new Date().toISOString();
    overrides[path] = { value, overriddenFrom: aiNow, aiGenerationId, createdAt: now, createdBy: adminId, reason };
    changes.push({ path, action: "set", oldValue: aiNow ?? null, newValue: value, aiGenerationId: aiGenerationId ?? null, reason: reason ?? null });
  } else if (!overrideValuesEqual(existing.value, value)) {
    const now = new Date().toISOString();
    overrides[path] = {
      ...existing,
      value,
      // overriddenFrom is only refreshed on an explicit baseline acknowledgement —
      // never accidentally on an ordinary value edit (so baseline-change detection
      // survives autosaves / redundant PUTs).
      overriddenFrom: acknowledge ? aiNow : existing.overriddenFrom,
      aiGenerationId: acknowledge ? aiGenerationId : existing.aiGenerationId,
      updatedAt: now,
      updatedBy: adminId,
      reason: reason ?? existing.reason,
    };
    changes.push({ path, action: "update", oldValue: existing.value ?? null, newValue: value, aiGenerationId: aiGenerationId ?? null, reason: reason ?? null });
  }
  // else: value unchanged → no-op, do NOT refresh overriddenFrom.

  // Overriding the archetype can leave the subtype incompatible — auto-link it.
  if (path === "/primaryArchetype") {
    const linked = ensureSubtypeCompatible({ overrides, aiDerived, adminId });
    if (linked) {
      changes.push({ path: "/subtype", action: "auto_linked", oldValue: linked.oldValue ?? null, newValue: linked.newValue ?? null, aiGenerationId: aiGenerationId ?? null, reason: "Auto-adjusted to match Primary Archetype override" });
    }
  }

  // Validate the full assembled effective before persisting — never knowingly
  // store an invalid combination and lean on runtime fallback.
  const resolved = resolveEnrichment({ aiDerived, overrides });
  if (resolved.summary.crossFieldInvalid || resolved.summary.invalidPaths.length > 0) {
    return { ok: false, status: 400, error: "This override would produce an invalid enrichment" };
  }

  return { ok: true, overrides, changes };
}

/**
 * Reset one override path (or ALL of them when `path` is null) back to the AI
 * baseline. Pure — mirror of the fact DELETE handler's loop.
 */
export function applyOverrideReset(args: {
  layers: OverrideLayers & { aiDerived: FactEnrichment };
  path: OverridablePath | null;
}): { ok: true; overrides: EnrichmentOverrides; changes: OverrideChange[] } {
  const { layers, path } = args;
  const { aiDerived } = layers;
  const overrides: EnrichmentOverrides = { ...layers.overrides };
  const changes: OverrideChange[] = [];

  const toReset = path !== null ? [path] : (Object.keys(overrides) as OverridablePath[]);
  for (const p of toReset) {
    const existing = overrides[p];
    if (!existing) continue;
    delete overrides[p];
    changes.push({ path: p, action: "reset", oldValue: existing.value ?? null, newValue: null, aiGenerationId: aiDerived.aiGenerationId ?? null, reason: null });
  }
  return { ok: true, overrides, changes };
}
