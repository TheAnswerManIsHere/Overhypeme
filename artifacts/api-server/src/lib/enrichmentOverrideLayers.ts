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
export type VisualOverride = FactEnrichment["visualPromptStrategyOverride"];

/**
 * The three override layers (+ derived effective) of an enrichment record —
 * a live fact's columns or a refresh candidate version's columns.
 */
export interface OverrideLayers {
  aiDerived: FactEnrichment | null;
  overrides: EnrichmentOverrides;
  visualPromptStrategyOverride: VisualOverride | undefined;
  effective: FactEnrichment | null;
  enrichmentStatus: string | null;
}

// Order-independent serialization: jsonb does NOT preserve object key order on
// the DB round-trip, so a plain JSON.stringify would falsely flag "changed".
// Sorts object keys recursively while preserving array order (reordering a list
// IS a real change).
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Drop undefined-valued keys: jsonb drops them on the DB round-trip, so the
    // in-memory (freshly-parsed) object and the stored one must compare equal.
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Stamp the moderator visual-strategy override's server-owned provenance
 * (updatedBy/updatedAt) when its content changed vs the prior stored override;
 * otherwise preserve the prior provenance verbatim. These fields are never set
 * by the client or the AI. Returns the enrichment unchanged when there is no
 * override. (Content comparison ignores the provenance fields themselves.)
 */
export function stampOverrideProvenance(
  next: FactEnrichment,
  prior: unknown,
  adminId: string | null,
): FactEnrichment {
  const ov = (next as { visualPromptStrategyOverride?: Record<string, unknown> }).visualPromptStrategyOverride;
  if (!ov) return next;
  const priorOv = (prior as { visualPromptStrategyOverride?: Record<string, unknown> } | null | undefined)
    ?.visualPromptStrategyOverride;
  const stripProvenance = (o: Record<string, unknown> | undefined) => {
    if (!o) return null;
    const { updatedBy: _b, updatedAt: _a, ...rest } = o;
    return stableStringify(rest);
  };
  const changed = stripProvenance(ov) !== stripProvenance(priorOv);
  const provenance = changed
    ? { updatedBy: adminId ?? undefined, updatedAt: new Date().toISOString() }
    : { updatedBy: priorOv?.["updatedBy"] as string | undefined, updatedAt: priorOv?.["updatedAt"] as string | undefined };
  return {
    ...next,
    visualPromptStrategyOverride: { ...ov, ...provenance },
  } as FactEnrichment;
}

/** Recover a best-effort pure AI baseline from an effective blob (strips the
 * moderator visual override) for legacy rows that predate enrichment_ai_derived. */
export function stripVisualOverride(enrichment: FactEnrichment | null | undefined): FactEnrichment | null {
  if (!enrichment) return null;
  const copy = { ...enrichment } as FactEnrichment;
  delete (copy as Record<string, unknown>)["visualPromptStrategyOverride"];
  return copy;
}

/** Load the three override layers for a LIVE fact, normalizing legacy rows (a
 * null enrichment_ai_derived derives its baseline from the current effective). */
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
  const visualPromptStrategyOverride = (effective as { visualPromptStrategyOverride?: VisualOverride } | null)
    ?.visualPromptStrategyOverride;
  const aiDerived = (row.enrichmentAiDerived as FactEnrichment | null) ?? stripVisualOverride(effective);
  const overrides = (row.enrichmentOverrides ?? {}) as EnrichmentOverrides;
  return { aiDerived, overrides, visualPromptStrategyOverride, effective, enrichmentStatus: row.enrichmentStatus ?? null };
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
  visualPromptStrategyOverride?: VisualOverride;
}): Record<string, unknown> {
  if (!s.aiDerived) {
    return {
      aiDerived: null,
      overrides: {},
      effective: s.effective,
      overrideSummary: {
        hasOverrides: false, overriddenPaths: [], baselineChangedPaths: [],
        invalidPaths: [], crossFieldInvalid: false,
        hasVisualStrategyOverride: Boolean(s.visualPromptStrategyOverride?.enabled),
      },
      enrichmentStatus: s.enrichmentStatus,
    };
  }
  const { effective, summary } = resolveEnrichment({
    aiDerived: s.aiDerived,
    overrides: s.overrides,
    visualPromptStrategyOverride: s.visualPromptStrategyOverride,
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
  const resolved = resolveEnrichment({ aiDerived, overrides, visualPromptStrategyOverride: layers.visualPromptStrategyOverride });
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
