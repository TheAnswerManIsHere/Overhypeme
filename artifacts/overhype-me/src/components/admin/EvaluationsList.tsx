/**
 * @purpose The Eval page's list of evaluations for one tab: each one's status (generating with progress, needs action with its retries, ready to judge, judging, finished), Judge results, and Results, polled while anything is in flight.
 * @subsystem visual-pipeline
 *
 * Plan `docs/plans/PLAN_EVAL_PAGE.md`, D and E. Statuses are derived on the
 * server from the panels, cells and judgements. While anything is in flight
 * the list polls every 5 seconds; a failed poll shows "Connection lost" with
 * the last known status and keeps trying — it never claims the server
 * stopped.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Gavel, Loader2, RotateCcw, BarChart3, WifiOff } from "lucide-react";
import { readError } from "@/components/admin/readError";
import { engineLabel, type EvaluationKind } from "@/components/admin/EvaluationWizard";

interface NeedsAction { panelId: number; cellId: number | null; action: "retry_scene" | "retry_picture" | "retry_storage" | "resume"; costs: boolean; reason: string }
export interface EvaluationSummary {
  id: number;
  description: string;
  createdAt: string;
  finishedAt: string | null;
  status: "generating" | "needs_action" | "ready" | "judging" | "finished" | "nothing_to_judge";
  images: number;
  drawn: number;
  inFlight: number;
  failed: number;
  lost: number;
  skippedPanels: number;
  judgeablePanels: number;
  judgedPanels: number;
  needsAction: NeedsAction[];
  engineFamilies: string[];
  scenarioKeys: string[];
  lookStyleIds: string[];
  factCount: number;
  round: number;
  imageSize: string;
}

export const POLL_MS = 5_000;

const keyOf = (evaluationId: number, a: NeedsAction) => a.action === "resume" ? `resume:${evaluationId}` : `${a.action}:${a.cellId ?? a.panelId}`;

const ACTION_LABEL: Record<NeedsAction["action"], string> = {
  retry_scene: "Retry scene",
  retry_picture: "Retry picture",
  retry_storage: "Retry storage",
  resume: "Resume generation",
};

function StatusLine({ e }: { e: EvaluationSummary }) {
  switch (e.status) {
    case "generating":
      return <span className="inline-flex items-center gap-1.5 text-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Generating: {e.drawn} of {e.images} pictures drawn</span>;
    case "needs_action":
      return <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-bold"><AlertTriangle className="w-4 h-4" /> Needs action: {e.needsAction.length} to retry</span>;
    case "ready":
      return <span className="inline-flex items-center gap-1.5 text-foreground font-bold"><CheckCircle2 className="w-4 h-4" /> Ready to judge</span>;
    case "judging":
      return <span className="text-foreground">Judging: {e.judgedPanels} of {e.judgeablePanels} panels</span>;
    case "finished":
      return <span className="inline-flex items-center gap-1.5 text-foreground"><CheckCircle2 className="w-4 h-4" /> Finished</span>;
    case "nothing_to_judge":
      return <span className="text-muted-foreground">No images to judge</span>;
  }
}

/**
 * One list per tab, mounted for the page visit (PR #931 round 1): it only ever
 * asks for its own kind, and it keeps polling its generating evaluations
 * while the other tab is shown. An inactive list renders nothing.
 */
export function EvaluationsList({ kind, active = true, refreshKey }: { kind: EvaluationKind; active?: boolean; refreshKey: number }) {
  const [items, setItems] = useState<EvaluationSummary[] | null>(null);
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<boolean> => {
    const r = await fetch(`/api/admin/comparison/evaluations?kind=${kind}`, { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setLost(true); return false; }
    setLost(false);
    setItems(((await r.json()) as { evaluations: EvaluationSummary[] }).evaluations);
    return true;
  }, [kind]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  // Poll while anything is in flight, or while the connection is lost.
  const polling = lost || (items ?? []).some((e) => e.status === "generating");
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const retry = async (evaluationId: number, a: NeedsAction) => {
    const path = a.action === "resume" ? `evaluations/${evaluationId}/resume`
      : a.action === "retry_scene" ? `panels/${a.panelId}/reprepare`
      : a.action === "retry_picture" ? `cells/${a.cellId}/rerun`
      : `cells/${a.cellId}/retry-storage`;
    const key = keyOf(evaluationId, a);
    setBusy(key);
    setError("");
    const r = await fetch(`/api/admin/comparison/${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    setBusy("");
    if (!r || !r.ok) setError(r ? await readError(r) : "The request did not reach the server.");
    else {
      const body = (await r.json().catch(() => ({}))) as { startError?: string | null };
      if (body.startError) setError(`Reset, but not started: ${body.startError}. Press Resume generation to start it.`);
    }
    await load();
  };

  if (!active) return null;

  return (
    <section className="space-y-2" data-testid={`evaluations-${kind}`}>
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Evaluations</h3>
      {lost && (
        <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1.5" data-testid="evaluations-connection-lost">
          <WifiOff className="w-4 h-4" /> Connection lost — progress unavailable. Showing the last known status; retrying every few seconds.
        </p>
      )}
      {error && <p className="text-sm text-destructive" data-testid="evaluations-error">{error}</p>}
      {items == null && !lost && <p className="text-sm text-muted-foreground"><Loader2 className="inline w-4 h-4 animate-spin" /> Loading…</p>}
      {items?.length === 0 && <p className="text-sm text-muted-foreground" data-testid="evaluations-empty">None yet. Use the steps above to set one up.</p>}
      <ul className="space-y-2">
        {(items ?? []).map((e) => (
          <li key={e.id} className="rounded-sm border border-border bg-background p-3 space-y-2" data-testid={`evaluation-${e.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-0.5">
                <p className="text-sm font-bold text-foreground">{e.description}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString()} · {e.factCount} fact{e.factCount === 1 ? "" : "s"} · {kind === "engine" ? e.engineFamilies.map(engineLabel).join(", ") : engineLabel(e.engineFamilies[0] ?? "")} · {e.images} images
                  {e.round !== 1 || e.imageSize !== "comparison" ? ` · round ${e.round}${e.imageSize === "final" ? ", member size" : ""}` : ""}
                </p>
                <p className="text-sm" data-testid={`evaluation-status-${e.id}`}><StatusLine e={e} /></p>
                {(e.failed > 0 || e.lost > 0 || e.skippedPanels > 0) && (
                  <p className="text-xs text-muted-foreground">{e.failed} failed · {e.lost} lost for good · {e.skippedPanels} scene{e.skippedPanels === 1 ? "" : "s"} skipped</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {(e.status === "ready" || e.status === "judging") && (
                  <Link href={`/admin/eval/judge/${e.id}`} data-testid={`evaluation-judge-${e.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90">
                    <Gavel className="w-4 h-4" /> Judge results
                  </Link>
                )}
                {e.judgedPanels > 0 && (
                  <Link href={`/admin/eval/results?sets=${e.id}`} data-testid={`evaluation-results-${e.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted">
                    <BarChart3 className="w-4 h-4" /> Results
                  </Link>
                )}
              </div>
            </div>
            {e.needsAction.length > 0 && (
              <ul className="space-y-1" data-testid={`evaluation-actions-${e.id}`}>
                {e.needsAction.map((a) => {
                  const key = keyOf(e.id, a);
                  return (
                    <li key={key} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground flex-1 min-w-0 break-words">{a.reason}</span>
                      <button type="button" onClick={() => void retry(e.id, a)} disabled={busy !== ""} data-testid={`evaluation-retry-${key}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-border hover:bg-muted disabled:opacity-40">
                        {busy === key ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} {ACTION_LABEL[a.action]}{a.costs ? "" : " (free)"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
