/**
 * A fact's stored AI taxonomy on the Facts editor: read-only, with "Re-run".
 *
 * The taxonomy is the classifier's own output, kept as stored data for AI and
 * code to use (plan PLAN_FACT_LIFECYCLE_REBUILD.md, oracle items 15 and 16). It
 * is not edited: the manual-override system, the hashtag edit and the version
 * panel went with Taxonomy Health (2A). "Re-run" asks for a fresh run, which
 * replaces the stored output when it finishes; a failed run leaves the old one
 * in place and blocks nothing. Below it, the run history: every classifier
 * call, failures included, newest first (item 16; increment 2.1b). The whole
 * panel moves into the fact sheet in Phase 3.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readError } from "./readError";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { FactEnrichment } from "@workspace/api-zod";
import { Button } from "@/components/ui/Button";
import { useEnrichmentJobs } from "./useEnrichmentJobs";

/** Where the prompt that produced this taxonomy came from, when it says. */
function PromptProvenanceLine({ diagnostics }: { diagnostics?: FactEnrichment["classificationPromptDiagnostics"] }) {
  if (!diagnostics) return null;
  const { source, hash, matchesCodeDefault } = diagnostics;
  const warn = source === "admin_config_debug_value" || !matchesCodeDefault;
  const label =
    source === "admin_config_debug_value"
      ? "Classified with a Debug mode prompt (Debug mode has since been removed)"
      : !matchesCodeDefault
        ? "Classification prompt differs from the current code default"
        : "Classification prompt matches the code default";
  return (
    <p
      className={`text-[11px] inline-flex items-center gap-1 ${warn ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      data-testid="taxonomy-prompt-provenance"
    >
      {warn ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
      {label} <span className="font-mono">({source}, {hash})</span>
    </p>
  );
}

/** The stored taxonomy, as the classifier wrote it. */
function TaxonomySummary({ e }: { e: FactEnrichment }) {
  const rows: [string, string][] = [
    ["Archetype", e.primaryArchetype],
    ["Subtype", e.subtype],
    ["Literalness", e.visualLiteralness],
    ["Complexity", e.visualComplexity],
    ["Overhype fit", e.overhypeFit],
    ["Adult", e.adultSuitability],
    ["Confidence", e.taxonomyConfidence.toFixed(2)],
  ];
  return (
    <div className="rounded-sm border border-border bg-muted/40 p-4 space-y-2" data-testid="taxonomy-summary">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground">{k}: </span><span className="text-foreground font-medium">{v}</span></div>
        ))}
      </div>
      {(e.modifiers ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground">Modifiers: <span className="text-foreground">{e.modifiers.join(", ")}</span></p>
      )}
      {(e.characters ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground">Characters: <span className="text-foreground">{(e.characters ?? []).map((c) => c.label).join(", ")}</span></p>
      )}
      <PromptProvenanceLine diagnostics={e.classificationPromptDiagnostics} />
      {(e.culturalReferences ?? []).length > 0 && (
        <div className="border-t border-border pt-2 mt-2 space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Cultural references</p>
          {e.culturalReferences.map((r, i) => (
            <p key={i} className="text-xs text-foreground">
              <span className="text-muted-foreground">"{r.sourcePhrase}"</span> ({r.referenceType})
              {r.canonicalReference && <> → <span className="font-medium">{r.canonicalReference}</span></>}
            </p>
          ))}
        </div>
      )}
      {(e.semanticEntities ?? []).length > 0 && (
        <div className="border-t border-border pt-2 mt-2 space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Semantic entities</p>
          {(e.semanticEntities ?? []).map((s, i) => (
            <p key={i} className="text-xs text-foreground">
              <span className="text-muted-foreground">"{s.surfaceText}"</span> ({s.entityKind})
              {s.visualReferent && <> → <span className="font-medium">{s.visualReferent}</span></>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** One row of GET /admin/facts/:id/taxonomy-runs. */
export interface TaxonomyRun {
  id: number;
  outcome: "ok" | "failed" | "discarded";
  origin: "provisional_approval" | "rerun" | "unrecorded" | "legacy_promoted" | "legacy_superseded" | "legacy_current";
  output: FactEnrichment | null;
  error: string | null;
  requestedByName: string | null;
  createdAt: string;
}

const OUTCOME_LABEL: Record<TaxonomyRun["outcome"], string> = {
  ok: "Stored",
  failed: "Failed",
  discarded: "Not stored",
};
const ORIGIN_LABEL: Record<TaxonomyRun["origin"], string> = {
  provisional_approval: "at provisional approval",
  rerun: "Re-run",
  unrecorded: "reason not recorded",
  legacy_promoted: "an earlier version, made current",
  legacy_superseded: "an earlier version, replaced (time archived; run time not recorded)",
  legacy_current: "the taxonomy held before run history began (time kept; run time not recorded)",
};

function RunRow({ run }: { run: TaxonomyRun }) {
  const [open, setOpen] = useState(false);
  const when = new Date(run.createdAt).toLocaleString();
  const tone = run.outcome === "ok" ? "text-foreground" : run.outcome === "failed" ? "text-destructive" : "text-amber-700 dark:text-amber-300";
  return (
    <li className="border-t border-border first:border-t-0 py-1.5" data-testid="taxonomy-run" data-outcome={run.outcome}>
      <div className="flex items-start gap-2 text-xs">
        {run.output ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-expanded={open}
            aria-label={open ? "Hide this run's output" : "Show this run's output"}
            data-testid="taxonomy-run-toggle"
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : <span className="w-3.5 shrink-0" />}
        <span className="text-muted-foreground shrink-0">{when}</span>
        <span className={`font-medium shrink-0 ${tone}`}>{OUTCOME_LABEL[run.outcome]}</span>
        <span className="text-muted-foreground">
          {ORIGIN_LABEL[run.origin]}
          {run.requestedByName ? `, by ${run.requestedByName}` : ""}
          {run.output ? ` · ${run.output.primaryArchetype}` : ""}
        </span>
      </div>
      {run.error && <p className="text-xs text-muted-foreground ml-5 mt-0.5" data-testid="taxonomy-run-error">{run.error}</p>}
      {open && run.output && <div className="ml-5 mt-1.5"><TaxonomySummary e={run.output} /></div>}
    </li>
  );
}

/** Every run of this fact's taxonomy, newest first. Reloaded when a run finishes. */
function RunHistory({ factId, reloadKey }: { factId: number; reloadKey: number }) {
  const [runs, setRuns] = useState<TaxonomyRun[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    fetch(`/api/admin/facts/${factId}/taxonomy-runs`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const body = (await r.json()) as { runs: TaxonomyRun[] };
        if (!cancelled) setRuns(body.runs);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the run history."); });
    return () => { cancelled = true; };
  }, [factId, reloadKey]);

  return (
    <div className="space-y-1" data-testid="taxonomy-run-history">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Run history</p>
      {error ? (
        <p className="text-xs text-destructive" data-testid="taxonomy-run-history-error">Could not load the run history: {error}</p>
      ) : runs === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Loading the run history…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="taxonomy-run-history-empty">No runs are recorded for this fact.</p>
      ) : (
        <ul>{runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>
      )}
    </div>
  );
}

/** Nothing on this panel is edited, so a server sync never clobbers local work. */
const NEVER_DIRTY = () => false;

interface FactDetail {
  enrichment?: FactEnrichment | null;
  enrichmentStatus?: string | null;
}

export function FactTaxonomyPanel({ factId, initialStatus }: { factId: number; initialStatus: string | null }) {
  const [enrichment, setEnrichment] = useState<FactEnrichment | null>(null);
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    fetch(`/api/admin/facts/${factId}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status}).`);
        const fact = (await r.json()) as FactDetail;
        if (cancelled) return;
        setEnrichment(fact.enrichment ?? null);
        setStatus(fact.enrichmentStatus ?? null);
      })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load the taxonomy."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [factId]);

  // A run in flight keeps the previous output on screen until the new one lands.
  const applyServerState = useCallback((next: FactEnrichment | null, nextStatus: string | null) => {
    if (next) setEnrichment(next);
    setStatus(nextStatus);
  }, []);
  // Polling waits for the first load, so a run already pending is read once, not twice.
  const jobs = useEnrichmentJobs({ resource: "facts", id: factId, status: loading ? null : status, isDirty: NEVER_DIRTY, applyServerState });

  const rerun = useCallback(async () => {
    if (!window.confirm("Re-run the AI taxonomy for this fact? It is a paid AI call. The new result replaces the stored one when it finishes; nothing members see changes.")) return;
    await jobs.onRerun();
  }, [jobs]);

  const running = status === "pending" || jobs.rerunBusy;
  // A run adds its history row as it finishes: reload the history then, and only then.
  const [historyKey, setHistoryKey] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setHistoryKey((k) => k + 1);
    wasRunning.current = running;
  }, [running]);
  return (
    <section className="space-y-2" data-testid="fact-taxonomy-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-foreground">AI taxonomy</h3>
          <p className="text-xs text-muted-foreground">
            How the AI classified this fact, kept for AI and code to use (finding similar facts, filtering). It can't be
            edited, and it doesn't decide what a picture shows: the gags do.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void rerun()}
          disabled={running || jobs.loading || loading}
          data-testid="taxonomy-rerun"
          className="shrink-0"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {running ? "Running…" : "Re-run"}
        </Button>
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Loading the taxonomy…</p>
      ) : loadError ? (
        <p className="text-xs text-destructive" data-testid="taxonomy-load-error">{loadError}</p>
      ) : (
        <>
          {running && (
            <p className="text-xs text-muted-foreground" data-testid="taxonomy-status-running">
              A run is in progress. The result below is the previous one until it finishes.
            </p>
          )}
          {status === "failed" && !running && (
            <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="taxonomy-status-failed">
              The last run failed. {enrichment ? "The result below is from an earlier run." : ""} Re-run to try again; nothing waits on it.
            </p>
          )}
          {enrichment ? <TaxonomySummary e={enrichment} /> : !running && (
            <p className="text-xs text-muted-foreground" data-testid="taxonomy-missing">This fact has no stored taxonomy yet.</p>
          )}
        </>
      )}
      {!loading && !loadError && <RunHistory factId={factId} reloadKey={historyKey} />}
      {jobs.error && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2" data-testid="taxonomy-rerun-error">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{jobs.error}</p>
        </div>
      )}
    </section>
  );
}
