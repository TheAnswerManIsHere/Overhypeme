/**
 * Eval dashboard (Slice 2B) — /admin/eval.
 *
 * The golden set + controlled eval runs: mark facts golden, "Start eval run"
 * (cost-confirmed) to render the golden set under the current pipeline, watch
 * per-item render status (rule 8), rate/attribute each render, and compare run
 * N vs N-1. Opportunistic (non-run) moderation ratings are shown separately and
 * labeled directional — only eval-run rows are a true A/B.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Loader2, AlertTriangle, Play, CheckCircle2, TrendingUp, TrendingDown } from "lucide-react";
import { FAILURE_TAG_VALUES, type FailureTag } from "@workspace/api-zod";
import { AttemptEvalControl, FAILURE_TAG_LABELS, type EvalWriteBody } from "@/components/admin/AttemptEvalControl";

// ─── API view types (mirror lib/eval/dashboard.ts + evalRunJobs.ts) ──────────

type TagDistribution = Record<FailureTag, number>;
interface AggregateStats { count: number; ratedCount: number; avgRating: number | null; tagDistribution: TagDistribution }
interface AttemptView { attemptId: number; factId: number; status: string; rating: number | null; failureTag: string | null }
interface SignatureGroup { signatureKey: string; signature: { scenarioKey: string; actualImageEngineId: string; subjectRenderMode: string }; attempts: AttemptView[] }
interface RunFactGroup { factId: number; signatures: SignatureGroup[] }
interface RunView { id: number; label: string | null; createdAt: string; aggregate: AggregateStats; byFact: RunFactGroup[] }
interface RunDiff { currentRunId: number; previousRunId: number; avgRatingDelta: number | null; tagDeltas: Array<{ tag: FailureTag; current: number; previous: number; delta: number }> }
interface EvalDashboardData {
  goldenFacts: Array<{ id: number; text: string }>;
  runs: RunView[];
  runDiff: RunDiff | null;
  opportunistic: AggregateStats;
}
interface RunStatusData {
  run: { id: number; label: string | null };
  items: Array<{ attemptId: number; factId: number; scenarioKey: string | null; status: string }>;
  tally: { total: number; done: number; failed: number; blocked: number; working: number };
}

function fmtAvg(v: number | null): string { return v == null ? "—" : v.toFixed(2); }

function TagChips({ dist }: { dist: TagDistribution }) {
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {FAILURE_TAG_VALUES.filter((t) => dist[t] > 0).map((t) => (
        <span key={t} title={FAILURE_TAG_LABELS[t].hint} className="text-[10px] font-mono px-1 py-0.5 rounded-sm bg-muted text-muted-foreground">
          {FAILURE_TAG_LABELS[t].label}:{dist[t]}
        </span>
      ))}
    </span>
  );
}

export default function EvalDashboard() {
  const [data, setData] = useState<EvalDashboardData | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [activeRun, setActiveRun] = useState<RunStatusData | null>(null);
  const activeRunId = useRef<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/eval/dashboard", { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError("Failed to load the eval dashboard."); return; }
    setError("");
    setData((await r.json()) as EvalDashboardData);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Poll the active run's per-item status until every item is terminal.
  const loadRunStatus = useCallback(async (runId: number) => {
    const r = await fetch(`/api/admin/eval/runs/${runId}`, { credentials: "include" }).catch(() => null);
    if (r && r.ok) setActiveRun((await r.json()) as RunStatusData);
  }, []);
  useEffect(() => {
    const runId = activeRunId.current;
    if (runId == null) return;
    // Terminal once no item is still working. Stop polling (clear the ref so a
    // re-render can't re-arm the interval) and reconcile the dashboard ONCE;
    // keep the active-run panel visible showing its final per-item state
    // (rule 8). A run with zero items reports working === 0 immediately, so this
    // also can't spin forever on an empty run.
    if (activeRun && activeRun.tally.working === 0) {
      activeRunId.current = null;
      void load();
      return;
    }
    const h = setInterval(() => { void loadRunStatus(runId); }, 1500);
    return () => clearInterval(h);
  }, [activeRun, loadRunStatus, load]);

  async function startRun() {
    setConfirmOpen(false);
    setStarting(true);
    setError("");
    const r = await fetch("/api/admin/eval/runs", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim() || null }),
    }).catch(() => null);
    setStarting(false);
    if (!r || !r.ok) { setError("Could not start the eval run."); return; }
    const body = (await r.json()) as { runId: number };
    activeRunId.current = body.runId;
    setLabel("");
    void loadRunStatus(body.runId);
  }

  const rateEvalAttempt = (attemptId: number) => async (b: EvalWriteBody) => {
    const r = await fetch(`/api/admin/eval/attempts/${attemptId}/eval`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    }).catch(() => null);
    if (r && r.ok) return { ok: true };
    return { ok: false, error: "Save failed" };
  };

  const goldenCount = data?.goldenFacts.length ?? 0;

  return (
    <AdminLayout title="Eval">
      <div className="max-w-5xl mx-auto p-4 space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Eval harness</h1>
            <p className="text-sm text-muted-foreground">
              Render the golden set under the current pipeline, rate the results, and compare runs.
            </p>
          </div>
          <button
            type="button"
            data-testid="eval-start-run"
            disabled={starting || goldenCount === 0}
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Start eval run
          </button>
        </div>

        {error && (
          <p className="text-sm text-destructive flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {error}</p>
        )}

        {/* Cost-confirmation before spending model budget on the whole golden set. */}
        {confirmOpen && (
          <div className="rounded-sm border-2 border-primary/40 bg-primary/5 p-4 space-y-3" data-testid="eval-run-confirm">
            <p className="text-sm text-foreground">
              This renders <strong>every golden fact ({goldenCount})</strong> across the approval-required scenarios —
              real image-model spend. Continue?
            </p>
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Run label (e.g. baseline, post-compiler-fix)"
              className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex items-center gap-3">
              <button type="button" data-testid="eval-run-confirm-yes" onClick={() => void startRun()} className="px-3 py-1 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90">
                Start run
              </button>
              <button type="button" onClick={() => setConfirmOpen(false)} className="text-sm text-primary underline hover:opacity-80">Cancel</button>
            </div>
          </div>
        )}

        {/* Active run — per-item live status (rule 8). */}
        {activeRun && (
          <div className="rounded-sm border border-border bg-background p-4 space-y-2" data-testid="eval-active-run">
            <p className="text-sm font-semibold text-foreground">
              Run #{activeRun.run.id}{activeRun.run.label ? ` · ${activeRun.run.label}` : ""}
            </p>
            <p className="text-xs font-mono text-muted-foreground">
              {activeRun.tally.done} of {activeRun.tally.total} rendered
              {activeRun.tally.failed > 0 ? ` · ${activeRun.tally.failed} failed` : ""}
              {activeRun.tally.blocked > 0 ? ` · ${activeRun.tally.blocked} blocked` : ""}
              {activeRun.tally.working > 0 ? ` · ${activeRun.tally.working} working` : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {activeRun.items.map((it) => (
                <span key={it.attemptId} title={`fact ${it.factId} · ${it.scenarioKey ?? ""}`} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm border border-border">
                  {it.status === "image_ready" ? <CheckCircle2 className="w-3 h-3 text-green-500" />
                    : it.status === "failed" || it.status === "blocked" ? <AlertTriangle className="w-3 h-3 text-amber-500" />
                    : <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
                  {it.scenarioKey ?? "?"}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Run N vs N-1 diff. */}
        {data?.runDiff && (
          <div className="rounded-sm border border-border bg-background p-4 space-y-2" data-testid="eval-run-diff">
            <p className="text-sm font-semibold text-foreground">
              Run #{data.runDiff.currentRunId} vs #{data.runDiff.previousRunId}
            </p>
            <p className="text-sm text-foreground flex items-center gap-1.5">
              Avg rating change:
              {data.runDiff.avgRatingDelta == null ? <span className="text-muted-foreground">—</span> : (
                <span className={`font-bold inline-flex items-center gap-1 ${data.runDiff.avgRatingDelta >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                  {data.runDiff.avgRatingDelta >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {data.runDiff.avgRatingDelta >= 0 ? "+" : ""}{data.runDiff.avgRatingDelta.toFixed(2)}
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {data.runDiff.tagDeltas.filter((d) => d.delta !== 0).map((d) => (
                <span key={d.tag} title={FAILURE_TAG_LABELS[d.tag].hint} className="text-[11px] font-mono px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground">
                  {FAILURE_TAG_LABELS[d.tag].label} {d.delta > 0 ? "+" : ""}{d.delta}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Golden set. */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Golden set ({goldenCount})</h2>
          {goldenCount === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="eval-golden-empty">
              No golden facts yet. Mark stable active facts golden (from the fact editor or the API) to include them in eval runs.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="eval-golden-list">
              {data!.goldenFacts.map((f) => (
                <li key={f.id} className="text-sm text-foreground rounded-sm border border-border bg-background px-2 py-1">
                  <span className="font-mono text-[10px] text-muted-foreground mr-2">#{f.id}</span>{f.text}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Runs. */}
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Runs</h2>
          {(data?.runs.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No eval runs yet.</p>
          ) : data!.runs.map((run) => (
            <div key={run.id} className="rounded-sm border border-border bg-background p-3 space-y-2" data-testid="eval-run">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-semibold text-foreground">
                  Run #{run.id}{run.label ? ` · ${run.label}` : ""}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
                </p>
                <p className="text-xs font-mono text-muted-foreground">
                  avg {fmtAvg(run.aggregate.avgRating)} · {run.aggregate.ratedCount}/{run.aggregate.count} rated
                </p>
              </div>
              <TagChips dist={run.aggregate.tagDistribution} />
              {run.byFact.map((fg) => (
                <div key={fg.factId} className="pl-2 border-l-2 border-border/50 space-y-1">
                  <p className="text-xs font-mono text-muted-foreground">fact #{fg.factId}</p>
                  {fg.signatures.map((sg) => (
                    <div key={sg.signatureKey} className="space-y-1">
                      <p className="text-[11px] text-muted-foreground">
                        {sg.signature.scenarioKey} · {sg.signature.actualImageEngineId}
                      </p>
                      {sg.attempts.map((a) => (
                        <div key={a.attemptId} className="pl-2 space-y-1" data-testid="eval-run-attempt">
                          {/* You can't validly rate a render you can't see — eval
                              attempts have no review grid, so surface the image
                              here via the admin-gated eval image route. */}
                          {a.status === "image_ready" ? (
                            <img
                              src={`/api/admin/eval/attempts/${a.attemptId}/image`}
                              alt={`eval render for attempt ${a.attemptId}`}
                              loading="lazy"
                              data-testid="eval-attempt-image"
                              className="max-h-40 rounded-sm border border-border"
                            />
                          ) : (
                            <p className="text-[10px] italic text-muted-foreground">
                              {a.status === "failed" ? "render failed" : a.status === "blocked" ? "blocked" : "no image yet"}
                            </p>
                          )}
                          <AttemptEvalControl compact rating={a.rating} failureTag={a.failureTag} onSave={rateEvalAttempt(a.attemptId)} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </section>

        {/* Opportunistic (directional only). */}
        {data && data.opportunistic.ratedCount > 0 && (
          <section className="space-y-1" data-testid="eval-opportunistic">
            <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Opportunistic ratings</h2>
            <p className="text-xs text-muted-foreground">
              Ratings on ordinary moderation renders (not a controlled run) — <strong>directional only</strong>.
            </p>
            <p className="text-sm text-foreground font-mono">
              avg {fmtAvg(data.opportunistic.avgRating)} · {data.opportunistic.ratedCount} rated
            </p>
            <TagChips dist={data.opportunistic.tagDistribution} />
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
