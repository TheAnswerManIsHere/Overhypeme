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
import type { FactEnrichment, VisualPromptStrategyOverride } from "@workspace/api-zod";
import { OVERRIDABLE_PATHS, type OverridablePath, collectRenderedTextEntries, setRenderedTextAtPath } from "@workspace/api-zod";
import type { EnrichmentOverrideContext } from "./EnrichmentEditor";
import { useEnrichmentJobs } from "./useEnrichmentJobs";
import { useDraftForm, type UseDraftFormResult } from "./useDraftForm";

/** One field result from POST /api/ai/tokenize-enrichment. */
interface TokenizeEnrichmentResultEntry {
  path: string;
  value: string;
  changed: boolean;
  usedLlm: boolean;
  error?: string;
  errorKind?: "grammar" | "entity" | "path";
}

interface TokenizeEnrichmentResponse {
  results: TokenizeEnrichmentResultEntry[];
}

/** Sentinel path key for a whole-batch failure (network/HTTP error) that isn't
 *  attributable to any one field. Mirrored (not imported, to avoid a cycle
 *  with EnrichmentEditor) as `VSO_GENERAL_TOKENIZE_ERROR_KEY` there. */
const VSO_TOKENIZE_GENERAL_ERROR_KEY = "";

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

/** The only enrichment field editable through the whole-blob draft path —
 *  everything else is either tracked (per-field override endpoints) or
 *  server-owned. A fact's gags are not in the enrichment at all: they live in
 *  their own table and are edited in the Gags panel (plan
 *  docs/plans/PLAN_THREE_GAGS.md). */
export type UntrackedEnrichmentField = "suggestedHashtags";

const UNTRACKED_FIELDS: readonly UntrackedEnrichmentField[] = ["suggestedHashtags"];

function reconcileEnrichmentDraftToEditableFields(
  serverValue: FactEnrichment | null,
  restoredDraft: FactEnrichment | null,
  editableFields: readonly UntrackedEnrichmentField[],
): FactEnrichment | null {
  if (!serverValue || !restoredDraft) return restoredDraft;
  const next = { ...serverValue } as FactEnrichment;
  const restoredRecord = restoredDraft as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const field of editableFields) {
    if (Object.prototype.hasOwnProperty.call(restoredRecord, field)) {
      nextRecord[field] = restoredRecord[field];
    }
  }
  return next;
}

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
 * What this editor edits: a fact's enrichment layers (Facts page; moderation
 * staging, where the staging fact IS the record under review).
 */
export type EnrichmentEditTarget = { kind: "fact"; factId: number };

export interface UseFactEnrichmentEditingOptions {
  target: EnrichmentEditTarget;
  /** Gate: when false, nothing fetches and no editing state exists (the
   *  moderation modal passes production_review && stagingFactId > 0). */
  enabled: boolean;
  /** Which untracked fields THIS surface may commit through the draft PATCH.
   *  Facts page: suggestedHashtags; moderation: none. */
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
  /** The server's message from the most recent failed override write (parsed
   *  from `{error, code}` when present). Null after a success. */
  overrideError: string | null;
  /** Await every in-flight per-field override write (PUT/DELETE) and report
   *  whether all succeeded. Terminal actions (approve / reject) call this first:
   *  a field blurred by the same click starts an un-awaited write.
   *  Resolves true immediately when nothing is in flight. */
  flushOverrides: () => Promise<boolean>;
  reloadResolved: () => Promise<void>;
}

/**
 * The text a moderator sees when the enrichment PATCH refuses a save. The
 * over-budget refusal carries a machine code in `error` and the human sentence
 * for each violated cap in `details[].message` (both PATCH routes send
 * `{ error: "visual_strategy_override_over_budget", details: budget.errors }`),
 * so the sentences win; any other refusal falls back to `error` (#685).
 */
export function saveRefusalMessage(body: unknown): string | undefined {
  const b = body as { error?: unknown; details?: unknown } | null;
  if (!b || typeof b !== "object") return undefined;
  const details = Array.isArray(b.details) ? b.details : [];
  const sentences = details
    .map((d) => (d && typeof d === "object" ? (d as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string" && m.trim() !== "");
  if (sentences.length > 0) return sentences.join(" ");
  return typeof b.error === "string" && b.error ? b.error : undefined;
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

  // Stale-response guard for tokenizeAndSaveVisualOverride: captured at call
  // time and re-checked after the async batch route round trip, so a response
  // that lands after the admin has navigated to a different fact can never
  // write into the now-active target's draft.
  const targetKeyRef = useRef(`${targetKind}:${factId}`);
  targetKeyRef.current = `${targetKind}:${factId}`;

  // ONE place derives every endpoint + the draft namespace.
  const endpoints = useMemo(
    () => ({
      storageKey: `fact-enrichment-draft::${factId}`,
      fetchRecord: `/api/admin/facts/${factId}`,
      fetchResolved: `/api/admin/facts/${factId}/enrichment-resolved`,
      patch: `/api/admin/facts/${factId}/enrichment`,
      overrides: `/api/admin/facts/${factId}/enrichment-overrides`,
    }),
    [factId],
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
    // reload.
    storageKey: enabled ? endpoints.storageKey : "fact-enrichment-draft::disabled",
    emptyValue: null,
    debounceMs: 1500,
    fetchServer: async () => {
      if (!enabledRef.current) return null;
      const r = await fetch(endpoints.fetchRecord, { credentials: "include" });
      if (!r.ok) return null;
      return (await r.json()) as FactServerRecord;
    },
    selectValue: (rec) => rec.enrichment ?? null,
    reconcileRestoredDraft: (serverValue, restoredDraft) =>
      reconcileEnrichmentDraftToEditableFields(serverValue, restoredDraft, editableRef.current),
    onServerRecord: (rec) => {
      if (rec?.enrichment) serverEnrichmentRef.current = rec.enrichment;
      setEnrichmentStatus(rec?.enrichmentStatus ?? null);
    },
    commit: async (toSave): Promise<void | FactEnrichment> => {
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
        try { msg = saveRefusalMessage(await r.json()) ?? msg; } catch { /* generic */ }
        throw new Error(msg);
      }
      try {
        const body = (await r.json()) as EnrichmentSaveResponse;
        if (body?.enrichment) {
          serverEnrichmentRef.current = body.enrichment;
          onSavedRef.current?.(body);
          onAfterMutationRef.current?.();
          // Reconcile the draft's own baseline/value from the server's
          // canonical enrichment (e.g. schema-level token-case canonicalization,
          // provenance stamps) rather than blindly trusting the submitted
          // payload — see useDraftForm's `commit` return-value contract.
          return body.enrichment;
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
  // In-flight override write promises (each resolves to its success boolean),
  // tracked in a ref so a terminal action can await them synchronously after a
  // blur — no dependency on a React re-render landing first.
  const inFlightOverridesRef = useRef<Set<Promise<boolean>>>(new Set());

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
    (path: OverridablePath, run: () => Promise<Response>): Promise<boolean> => {
      const task = (async (): Promise<boolean> => {
        setPending((p) => ({ ...p, [path]: "saving" }));
        try {
          const r = await run();
          if (!r.ok) {
            // Surface the server's message when it sent one.
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
          return true;
        } catch (err) {
          setPending((p) => ({ ...p, [path]: "error" }));
          setOverrideError(err instanceof Error ? err.message : "Save failed.");
          return false;
        }
      })();
      inFlightOverridesRef.current.add(task);
      void task.finally(() => inFlightOverridesRef.current.delete(task));
      return task;
    },
    [applyResolved],
  );

  // Await all currently-in-flight override writes; loop so writes started while
  // awaiting (unlikely, but possible) are also drained. Reports overall success.
  const flushOverrides = useCallback(async (): Promise<boolean> => {
    let ok = true;
    while (inFlightOverridesRef.current.size > 0) {
      const batch = Array.from(inFlightOverridesRef.current);
      const results = await Promise.all(batch);
      if (results.some((r) => !r)) ok = false;
    }
    return ok;
  }, []);

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
    overrideError,
    flushOverrides,
    reloadResolved: fetchResolved,
  };
}
