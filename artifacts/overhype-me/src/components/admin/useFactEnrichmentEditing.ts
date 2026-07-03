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

/**
 * What this editor edits:
 *  - `fact` — the live fact's enrichment layers (Facts page; first-time
 *    moderation staging, where the staging fact IS the record under review);
 *  - `reviewCandidate` — a REFRESH cycle's candidate version row, via the
 *    review-scoped candidate endpoints. The live fact is frozen while the
 *    cycle is open; edits land on the candidate that approval promotes.
 *    `factId` is still carried (= review.stagingFactId) for identity/keying.
 */
export type EnrichmentEditTarget =
  | { kind: "fact"; factId: number }
  | { kind: "reviewCandidate"; reviewId: number; factId: number };

export interface UseFactEnrichmentEditingOptions {
  target: EnrichmentEditTarget;
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
  /** Re-run classification behind the shared "overrides are preserved" confirm.
   *  No-op when `supportsRerun` is false (candidate mode). */
  rerunWithConfirm: () => Promise<void>;
  /** False in candidate mode — surfaces must not render a re-run action then
   *  (a candidate is re-classified by rejecting + re-sending, never in place). */
  supportsRerun: boolean;
  /** The server's message from the most recent failed override write (parsed
   *  from `{error, code}` when present) — e.g. a stale tab hitting
   *  CANDIDATE_NOT_PENDING after the refresh resolved. Null after a success. */
  overrideError: string | null;
  reloadResolved: () => Promise<void>;
}

export function useFactEnrichmentEditing({
  target,
  enabled,
  editableUntrackedFields = UNTRACKED_FIELDS,
  initialStatus = null,
  onAfterMutation,
  onSaved,
}: UseFactEnrichmentEditingOptions): UseFactEnrichmentEditingResult {
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(initialStatus);

  // Primitive identity so an inline target object never re-keys the hook.
  const targetKind = target.kind;
  const factId = target.factId;
  const reviewId = target.kind === "reviewCandidate" ? target.reviewId : null;

  // ONE place derives every endpoint + the draft namespace, so fact mode and
  // candidate mode can never partially mix. Candidate mode reads/writes the
  // review-scoped candidate endpoints exclusively — never /api/admin/facts/:id.
  const endpoints = useMemo(
    () =>
      targetKind === "reviewCandidate"
        ? {
            storageKey: `candidate-enrichment-draft::${reviewId}`,
            fetchRecord: `/api/admin/reviews/${reviewId}/candidate-enrichment-resolved`,
            fetchResolved: `/api/admin/reviews/${reviewId}/candidate-enrichment-resolved`,
            patch: `/api/admin/reviews/${reviewId}/candidate-enrichment`,
            overrides: `/api/admin/reviews/${reviewId}/candidate-overrides`,
            supportsRerun: false,
          }
        : {
            storageKey: `fact-enrichment-draft::${factId}`,
            fetchRecord: `/api/admin/facts/${factId}`,
            fetchResolved: `/api/admin/facts/${factId}/enrichment-resolved`,
            patch: `/api/admin/facts/${factId}/enrichment`,
            overrides: `/api/admin/facts/${factId}/enrichment-overrides`,
            supportsRerun: true,
          },
    [targetKind, factId, reviewId],
  );

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
    // mount can never read/write a real record's localStorage draft or report
    // stale dirty state. Enabling (or switching targets) re-keys → clean
    // reload. Candidate drafts get their own namespace so they can never
    // collide with a prior fact-mode draft for the same staging fact.
    storageKey: enabled ? endpoints.storageKey : "fact-enrichment-draft::disabled",
    emptyValue: null,
    debounceMs: 1500,
    fetchServer: async () => {
      if (!enabledRef.current) return null;
      const r = await fetch(endpoints.fetchRecord, { credentials: "include" });
      if (!r.ok) return null;
      const body = (await r.json()) as Record<string, unknown>;
      // Candidate mode serves the resolved shape — adapt it to the record slice.
      if (targetKind === "reviewCandidate") {
        return {
          enrichment: (body["effective"] ?? null) as FactEnrichment | null,
          enrichmentStatus: (body["enrichmentStatus"] ?? null) as string | null,
        } satisfies FactServerRecord;
      }
      return body as FactServerRecord;
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
        r = await fetch(endpoints.patch, {
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
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const fetchResolved = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const r = await fetch(endpoints.fetchResolved, { credentials: "include" });
      if (!r.ok) return;
      const b = (await r.json()) as ResolvedResponse;
      setResolved({ aiDerived: b.aiDerived ?? null, overrides: b.overrides ?? {}, summary: b.overrideSummary });
    } catch { /* best-effort; decoration just won't show */ }
  }, [endpoints]);

  useEffect(() => {
    if (!enabled) {
      // Disabled contract: no resolved state may linger from a prior target.
      setResolved(null);
      setPending({});
      setOverrideError(null);
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
        if (!r.ok) {
          // Surface the server's message when it sent one — candidate-mode
          // failures (CANDIDATE_NOT_READY, REVIEW_NOT_EDITABLE,
          // CANDIDATE_NOT_PENDING after a stale tab) are meaningful, not noise.
          let msg = `Save failed (${r.status}).`;
          try {
            const b = (await r.json()) as { error?: string; code?: string };
            if (b?.error) msg = b.error;
          } catch { /* keep the status-only message */ }
          throw new Error(msg);
        }
        applyResolved((await r.json()) as ResolvedResponse);
        setPending((p) => { const n = { ...p }; delete n[path]; return n; });
        setOverrideError(null);
      } catch (err) {
        setPending((p) => ({ ...p, [path]: "error" }));
        setOverrideError(err instanceof Error ? err.message : "Save failed.");
      }
    },
    [applyResolved],
  );

  const putOverride = useCallback(
    (path: OverridablePath, value: unknown, acknowledge = false) =>
      writeOverride(path, () =>
        fetch(endpoints.overrides, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(acknowledge ? { path, value, acknowledgeCurrentAiBaseline: true } : { path, value }),
        }),
      ),
    [writeOverride, endpoints],
  );

  const resetOverride = useCallback(
    (path: OverridablePath) =>
      writeOverride(path, () =>
        fetch(`${endpoints.overrides}?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          credentials: "include",
        }),
      ),
    [writeOverride, endpoints],
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
  // Candidate mode pins the jobs hook OFF (status null): its sync path reads
  // GET /api/admin/facts/:id and would inject the LIVE fact's enrichment into
  // the candidate draft. Candidates are never re-classified in place.
  const jobs = useEnrichmentJobs({
    resource: "facts",
    id: factId,
    status: enabled && targetKind === "fact" ? enrichmentStatus : null,
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
    if (!endpoints.supportsRerun) return; // candidate mode: reject + re-send instead
    if (
      draft.value &&
      !window.confirm(
        "Re-enrich this fact? The AI-derived baseline will be regenerated. Existing manual overrides are preserved and keep controlling the active value. If the new AI value differs from the originally-overridden value, the field is marked for review.",
      )
    ) {
      return;
    }
    await jobs.onRerun();
  }, [draft.value, jobs, endpoints.supportsRerun]);

  return {
    enrichment: enabled ? draft.value : null,
    enrichmentStatus: enabled ? enrichmentStatus : null,
    draft,
    overrideContext,
    jobs,
    rerunWithConfirm,
    supportsRerun: endpoints.supportsRerun,
    overrideError,
    reloadResolved: fetchResolved,
  };
}
