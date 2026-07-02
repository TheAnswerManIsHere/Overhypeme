/**
 * useFactEnrichmentEditing — the ONE fact-enrichment editing engine, shared by
 * the Edit Fact screen and the moderation ReviewModal so the two flows stay in
 * lockstep by construction (David's rule: same tracking, same saving, no work
 * ever lost, no drift).
 *
 * What it owns (extracted verbatim from the Facts page's FactEnrichmentPanel):
 *  - the localStorage-backed draft (`useDraftForm`, key `fact-enrichment-draft::<id>`)
 *    for UNTRACKED fields, committed explicitly via PATCH /admin/facts/:id/enrichment
 *    — an accidentally closed tab/modal never loses work;
 *  - the resolved AI-baseline + override map (`GET .../enrichment-resolved`) and
 *    the per-field override writes (PUT/DELETE .../enrichment-overrides) that
 *    power the tracked-field decoration (overridden chips, Revert to AI,
 *    "AI changed — review" acknowledge) — tracked edits persist INSTANTLY;
 *  - the `useEnrichmentJobs` wiring (re-run classification; polling that never
 *    clobbers dirty work or in-flight override writes).
 *
 * Guards (per the reviewed plan):
 *  - `editableUntrackedFields`: on commit, any untracked field NOT listed is
 *    overlaid with the latest server-known value, so a stale localStorage draft
 *    or old client can never smuggle e.g. `suggestedHashtags` changes through a
 *    moderation VSO save (moderation passes ["visualPromptStrategyOverride"]).
 *  - `enabled=false` contract: no fetches; `enrichment` is null; `overrideContext`
 *    is undefined; no stale dirty state (the draft binds to a sentinel key).
 *    Flipping enabled→true (or switching factId) loads fresh detail + resolved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FactEnrichment } from "@workspace/api-zod";
import { OVERRIDABLE_PATHS, type OverridablePath } from "@workspace/api-zod";
import type { EnrichmentOverrideContext } from "./EnrichmentEditor";
import { useEnrichmentJobs } from "./useEnrichmentJobs";
import { useDraftForm, type UseDraftFormResult } from "./useDraftForm";

/** Server response from the enrichment PATCH, including re-synced projections. */
export interface EnrichmentSaveResponse {
  enrichment: FactEnrichment;
  projection?: {
    primaryArchetype: string;
    subtype: string;
    overhypeFit: string;
    adultSuitability: string;
  };
}

/** The slice of a fact's detail record this editor consumes. */
export interface FactServerRecord {
  enrichment?: FactEnrichment | null;
  enrichmentStatus?: string | null;
}

/** The only enrichment fields editable through the whole-blob draft path —
 *  everything else is either tracked (per-field override endpoints) or
 *  server-owned. */
export type UntrackedEnrichmentField = "suggestedHashtags" | "visualPromptStrategyOverride";

const UNTRACKED_FIELDS: readonly UntrackedEnrichmentField[] = [
  "suggestedHashtags",
  "visualPromptStrategyOverride",
];

interface ResolvedState {
  aiDerived: FactEnrichment | null;
  overrides: Record<string, { value: unknown; overriddenFrom: unknown }>;
  summary: EnrichmentOverrideContext["summary"];
}

interface ResolvedResponse {
  aiDerived: FactEnrichment | null;
  overrides: Record<string, { value: unknown; overriddenFrom: unknown }>;
  effective: FactEnrichment | null;
  overrideSummary: EnrichmentOverrideContext["summary"];
}

export interface UseFactEnrichmentEditingOptions {
  factId: number;
  /** Gate: when false, nothing fetches and no editing state exists (the
   *  moderation modal passes production_review && stagingFactId > 0). */
  enabled: boolean;
  /** Which untracked fields THIS surface may commit through the draft PATCH.
   *  Facts page: both; moderation: only the visual-strategy override. */
  editableUntrackedFields?: readonly UntrackedEnrichmentField[];
  /** Seed status shown before the first server fetch resolves (list-row value). */
  initialStatus?: string | null;
  /** Fires after EVERY successful server mutation that can change the effective
   *  enrichment (override PUT/DELETE/acknowledge, draft commit, re-enrich
   *  completion) — moderation bumps its scenario-grid reload key here. */
  onAfterMutation?: () => void;
  /** Fires with the server response after a commit / override reconciliation
   *  (the Facts page syncs its list-row projections). */
  onSaved?: (resp: EnrichmentSaveResponse) => void;
}

export interface UseFactEnrichmentEditingResult {
  /** The editable enrichment value (draft). Null while disabled/empty. */
  enrichment: FactEnrichment | null;
  enrichmentStatus: string | null;
  draft: UseDraftFormResult<FactEnrichment | null, FactServerRecord>;
  /** Undefined until the resolved baseline loads (or while disabled) — the
   *  editor then renders in plain mode with no decoration. */
  overrideContext: EnrichmentOverrideContext | undefined;
  jobs: ReturnType<typeof useEnrichmentJobs>;
  /** Re-run classification behind the shared "overrides are preserved" confirm. */
  rerunWithConfirm: () => Promise<void>;
  reloadResolved: () => Promise<void>;
}

export function useFactEnrichmentEditing({
  factId,
  enabled,
  editableUntrackedFields = UNTRACKED_FIELDS,
  initialStatus = null,
  onAfterMutation,
  onSaved,
}: UseFactEnrichmentEditingOptions): UseFactEnrichmentEditingResult {
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(initialStatus);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onAfterMutationRef = useRef(onAfterMutation);
  onAfterMutationRef.current = onAfterMutation;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const editableRef = useRef(editableUntrackedFields);
  editableRef.current = editableUntrackedFields;

  // Latest server-known enrichment — the overlay source for untracked fields
  // this surface may NOT edit (the anti-smuggle guard on commit).
  const serverEnrichmentRef = useRef<FactEnrichment | null>(null);

  const draft = useDraftForm<FactEnrichment | null, FactServerRecord>({
    // Sentinel key while disabled: binds the draft to nothing, so a disabled
    // mount can never read/write a real fact's localStorage draft or report
    // stale dirty state. Enabling (or switching facts) re-keys → clean reload.
    storageKey: enabled ? `fact-enrichment-draft::${factId}` : "fact-enrichment-draft::disabled",
    emptyValue: null,
    debounceMs: 1500,
    fetchServer: async () => {
      if (!enabledRef.current) return null;
      const r = await fetch(`/api/admin/facts/${factId}`, { credentials: "include" });
      if (!r.ok) return null;
      return (await r.json()) as FactServerRecord;
    },
    selectValue: (rec) => rec.enrichment ?? null,
    onServerRecord: (rec) => {
      if (rec?.enrichment) serverEnrichmentRef.current = rec.enrichment;
      setEnrichmentStatus(rec?.enrichmentStatus ?? null);
    },
    commit: async (toSave) => {
      if (!toSave) throw new Error("Nothing to save.");
      // Anti-smuggle overlay: untracked fields this surface may not edit are
      // pinned to the latest server value, so a stale draft can't change them.
      const payload = { ...toSave } as FactEnrichment;
      const server = serverEnrichmentRef.current;
      for (const f of UNTRACKED_FIELDS) {
        if (!editableRef.current.includes(f) && server) {
          (payload as Record<string, unknown>)[f] = (server as unknown as Record<string, unknown>)[f];
        }
      }
      let r: Response;
      try {
        r = await fetch(`/api/admin/facts/${factId}/enrichment`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ enrichment: payload }),
        });
      } catch {
        throw new Error("Network error — could not save.");
      }
      if (!r.ok) {
        let msg = r.status === 503 ? "API unavailable — try again shortly." : `Save failed (${r.status}).`;
        try { const b = (await r.json()) as { error?: string }; if (b?.error) msg = b.error; } catch { /* generic */ }
        throw new Error(msg);
      }
      try {
        const body = (await r.json()) as EnrichmentSaveResponse;
        if (body?.enrichment) {
          serverEnrichmentRef.current = body.enrichment;
          onSavedRef.current?.(body);
        }
      } catch {
        /* response body is best-effort; the save itself succeeded */
      }
      onAfterMutationRef.current?.();
    },
  });

  // ── AI-derived vs. manual-override state ────────────────────────────────────
  const [resolved, setResolved] = useState<ResolvedState | null>(null);
  const [pending, setPending] = useState<Record<string, "saving" | "error">>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const fetchResolved = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const r = await fetch(`/api/admin/facts/${factId}/enrichment-resolved`, { credentials: "include" });
      if (!r.ok) return;
      const b = (await r.json()) as ResolvedResponse;
      setResolved({ aiDerived: b.aiDerived ?? null, overrides: b.overrides ?? {}, summary: b.overrideSummary });
    } catch { /* best-effort; decoration just won't show */ }
  }, [factId]);

  useEffect(() => {
    if (!enabled) {
      // Disabled contract: no resolved state may linger from a prior fact.
      setResolved(null);
      setPending({});
      serverEnrichmentRef.current = null;
      return;
    }
    void fetchResolved();
  }, [enabled, fetchResolved]);

  const TRACKED_FIELDS = useMemo(
    () => (Object.keys(OVERRIDABLE_PATHS) as OverridablePath[]).map((p) => p.slice(1)),
    [],
  );

  // Apply a PUT/DELETE response: refresh the override map + summary, and fold the
  // new effective TRACKED fields into the draft (preserving unsaved untracked edits).
  const applyResolved = useCallback(
    (b: ResolvedResponse) => {
      setResolved({ aiDerived: b.aiDerived ?? null, overrides: b.overrides ?? {}, summary: b.overrideSummary });
      if (b.effective) {
        const eff = b.effective;
        serverEnrichmentRef.current = eff;
        draft.adoptServerSlice((prev) => {
          if (!prev) return eff;
          const next = { ...prev } as FactEnrichment;
          for (const f of TRACKED_FIELDS) (next as Record<string, unknown>)[f] = (eff as unknown as Record<string, unknown>)[f];
          return next;
        });
        onSavedRef.current?.({
          enrichment: eff,
          projection: {
            primaryArchetype: eff.primaryArchetype,
            subtype: eff.subtype,
            overhypeFit: eff.overhypeFit,
            adultSuitability: eff.adultSuitability,
          },
        });
      }
      onAfterMutationRef.current?.();
    },
    [draft, TRACKED_FIELDS],
  );

  const writeOverride = useCallback(
    async (path: OverridablePath, run: () => Promise<Response>) => {
      setPending((p) => ({ ...p, [path]: "saving" }));
      try {
        const r = await run();
        if (!r.ok) throw new Error(`(${r.status})`);
        applyResolved((await r.json()) as ResolvedResponse);
        setPending((p) => { const n = { ...p }; delete n[path]; return n; });
      } catch {
        setPending((p) => ({ ...p, [path]: "error" }));
      }
    },
    [applyResolved],
  );

  const putOverride = useCallback(
    (path: OverridablePath, value: unknown, acknowledge = false) =>
      writeOverride(path, () =>
        fetch(`/api/admin/facts/${factId}/enrichment-overrides`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(acknowledge ? { path, value, acknowledgeCurrentAiBaseline: true } : { path, value }),
        }),
      ),
    [writeOverride, factId],
  );

  const resetOverride = useCallback(
    (path: OverridablePath) =>
      writeOverride(path, () =>
        fetch(`/api/admin/facts/${factId}/enrichment-overrides?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          credentials: "include",
        }),
      ),
    [writeOverride, factId],
  );

  const overrideContext: EnrichmentOverrideContext | undefined =
    enabled && resolved
      ? {
          aiDerived: resolved.aiDerived,
          overrides: resolved.overrides,
          summary: resolved.summary,
          pending,
          onOverride: (path, value) => putOverride(path, value),
          onReset: (path) => resetOverride(path),
          onAcknowledge: (path, value) => putOverride(path, value, true),
        }
      : undefined;

  // ── Re-run classification (polling never clobbers dirty/in-flight work) ─────
  const jobs = useEnrichmentJobs({
    resource: "facts",
    id: factId,
    status: enabled ? enrichmentStatus : null,
    isDirty: () => draft.hasUncommittedChanges || Object.keys(pendingRef.current).length > 0,
    // A background re-run rewrites the enrichment server-side; fold it into BOTH
    // value and baseline, then refresh the resolved map so "AI changed — review"
    // decoration appears on overridden fields whose baseline moved.
    applyServerState: (e, s) => {
      serverEnrichmentRef.current = e;
      draft.adoptServerSlice(() => e);
      setEnrichmentStatus(s);
      void fetchResolved();
      onAfterMutationRef.current?.();
    },
  });

  const rerunWithConfirm = useCallback(async () => {
    if (
      draft.value &&
      !window.confirm(
        "Re-enrich this fact? The AI-derived baseline will be regenerated. Existing manual overrides are preserved and keep controlling the active value. If the new AI value differs from the originally-overridden value, the field is marked for review.",
      )
    ) {
      return;
    }
    await jobs.onRerun();
  }, [draft.value, jobs]);

  return {
    enrichment: enabled ? draft.value : null,
    enrichmentStatus: enabled ? enrichmentStatus : null,
    draft,
    overrideContext,
    jobs,
    rerunWithConfirm,
    reloadResolved: fetchResolved,
  };
}
