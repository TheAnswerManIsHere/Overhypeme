/**
 * The engine comparison on the eval dashboard (launch Phase 8, increment 2a;
 * plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Admin/User UX Impact*).
 *
 * Create a comparison set from a round preset, see each set's status at both
 * altitudes (every cell's state, and the aggregate), plan the next run of a
 * kind (every pending item, with the most it could cost) and start it, and
 * open the blind judging page and the results. Pricing does not gate a run
 * (David, 2026-11-07, `decisions.md`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Circle, Loader2, MinusCircle, Plus } from "lucide-react";
import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS } from "@workspace/api-zod";

interface SetSummary { id: number; label: string; round: number; imageSize?: string; createdAt: string; panels: number; cells: number }
interface CellView { id: number; engineId: string; state: string; skipReason: string | null; error: string | null; vendorResultUrl?: string | null; rerunCount?: number }
interface PanelView { id: number; factId: number; scenarioKey: string; lookStyleId: string; imageMode: string; state: string; skipReason: string | null; error: string | null; cells: CellView[] }
interface SetDetail {
  set: { id: number; label: string; round: number; engineFamilies: string[] };
  panels: PanelView[];
  aggregate: { panels: Record<string, number>; cells: Record<string, number> };
  estimate: { preparationBoundUsd: number | null; preparationRefusal?: string | null; renderBoundUsd: number; perEngineBoundUsd: Record<string, number> };
  runs?: RunView[];
}
interface RunView { id: number; kind: string; state: string; boundUsd: string; refusal: string | null; createdAt: string }
interface RunPlan {
  admitted: boolean;
  items: Array<{ ref: string; label: string; boundUsd: number }>;
  boundUsd: number;
  refusal: string | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function StateIcon({ state }: { state: string }) {
  if (state === "rendered" || state === "prepared") return <CheckCircle2 className="w-3 h-3 text-green-500" />;
  if (state === "failed") return <AlertTriangle className="w-3 h-3 text-amber-500" />;
  if (state === "skipped") return <MinusCircle className="w-3 h-3 text-muted-foreground" />;
  if (state === "enqueued" || state === "preparing" || state === "planning") return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
  return <Circle className="w-3 h-3 text-muted-foreground" />;
}

function tallyLine(t: Record<string, number>): string {
  return Object.entries(t).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(" · ") || "none";
}

/** The refusal or error an admin comparison route answered with, in words. */
export async function readError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string; reasons?: string[]; refusal?: string } | null;
  if (body?.reasons?.length) return body.reasons.join("; ");
  if (body?.refusal) return body.refusal;
  return body?.error ?? `request failed (${r.status})`;
}

export function EngineComparison() {
  const [sets, setSets] = useState<SetSummary[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [round, setRound] = useState<1 | 2>(1);
  const [imageSize, setImageSize] = useState<"comparison" | "final">("comparison");
  const [factIds, setFactIds] = useState("");
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<{ kind: string; result: RunPlan } | null>(null);
  const [planning, setPlanning] = useState(false);
  // A response is applied only while the set it was requested for is still
  // the selected one: a late answer for an earlier selection is dropped.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const stillSelected = (id: number) => selectedRef.current === id;

  const loadSets = useCallback(async () => {
    const r = await fetch("/api/admin/comparison/sets", { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError("Failed to load comparison sets."); return; }
    setSets(((await r.json()) as { sets?: SetSummary[] }).sets ?? []);
  }, []);
  useEffect(() => { void loadSets(); }, [loadSets]);

  /** Re-read the selected set without clearing it, while a run moves its items. */
  const refreshDetail = useCallback(async (id: number, opts: { reportErrors?: boolean } = {}) => {
    const r = await fetch(`/api/admin/comparison/sets/${id}`, { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) {
      if (!opts.reportErrors) return;
      const message = r ? await readError(r) : "Failed to load the set.";
      if (stillSelected(id)) setError(message);
      return;
    }
    const body = (await r.json()) as SetDetail;
    if (stillSelected(id)) setDetail(body);
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetail(null);
    setPlan(null);
    setPlanning(false);
    setStarting(false);
    await refreshDetail(id, { reportErrors: true });
  }, [refreshDetail]);
  useEffect(() => { if (selected != null) void loadDetail(selected); }, [selected, loadDetail]);

  const inFlight = !!detail && detail.set.id === selected && detail.panels.some((p) => p.state === "preparing" || p.state === "planning" || p.cells.some((c) => c.state === "enqueued"));
  useEffect(() => {
    if (!inFlight || selected == null) return;
    const id = selected;
    const timer = setInterval(() => { void refreshDetail(id); }, 5_000);
    return () => clearInterval(timer);
  }, [inFlight, selected, refreshDetail]);

  const create = async () => {
    const ids = factIds.split(/[\s,]+/).filter(Boolean).map(Number);
    if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) { setError("Fact ids must be positive whole numbers, comma-separated."); return; }
    const preset = COMPARISON_ROUND_PRESETS[round];
    setCreating(true);
    setError("");
    const r = await fetch("/api/admin/comparison/sets", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: label.trim() || `Round ${round}`,
        round,
        factIds: ids,
        scenarioKeys: preset.scenarioKeys,
        lookStyleIds: preset.lookStyleIds,
        engineFamilies: COMPARISON_DEFAULT_FAMILIES,
        imageSize,
      }),
    }).catch(() => null);
    setCreating(false);
    if (!r || !r.ok) { setError(r ? `Set refused: ${await readError(r)}` : "Failed to create the set."); return; }
    const created = (await r.json()) as { setId: number };
    setLabel("");
    await loadSets();
    setSelected(created.setId);
  };

  const planRun = async (kind: "prepare" | "render") => {
    const id = selected;
    if (id == null) return;
    setPlanning(true);
    setError("");
    setNotice("");
    const r = await fetch(`/api/admin/comparison/sets/${id}/plan`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }).catch(() => null);
    const outcome: { error: string } | { result: RunPlan } = !r || !r.ok
      ? { error: r ? await readError(r) : "Failed to plan the run." }
      : { result: (await r.json()) as RunPlan };
    if (!stillSelected(id)) return;
    setPlanning(false);
    if ("error" in outcome) setError(outcome.error);
    else setPlan({ kind, result: outcome.result });
  };

  /** Start the run just planned: the one action here that spends. */
  const startRun = async (kind: string) => {
    const id = selected;
    if (id == null) return;
    setStarting(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/sets/${id}/runs`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }).catch(() => null);
    const outcome: { error: string } | { run: RunView; plan: RunPlan } = !r || !r.ok
      ? { error: r ? await readError(r) : "Failed to start the run." }
      : ((await r.json()) as { run: RunView; plan: RunPlan });
    // The start finished, whichever set is on screen now: the button is free again.
    setStarting(false);
    if (!stillSelected(id)) return;
    setPlan(null);
    if ("error" in outcome) { setError(`Run refused: ${outcome.error}`); await refreshDetail(id); return; }
    setNotice(`Run #${outcome.run.id} started: ${outcome.plan.items.length} item${outcome.plan.items.length === 1 ? "" : "s"}, at most ${usd(outcome.plan.boundUsd)}.`);
    await refreshDetail(id);
  };

  /**
   * Recovery that spends nothing: a cell's storage again, its one re-run, or a
   * failed panel's re-preparation (each taken by the next run).
   */
  const cellAction = async (targetId: number, action: "retry-storage" | "rerun" | "reprepare") => {
    const id = selected;
    if (id == null) return;
    const path = action === "reprepare" ? `panels/${targetId}/reprepare` : `cells/${targetId}/${action}`;
    const r = await fetch(`/api/admin/comparison/${path}`, { method: "POST", credentials: "include" }).catch(() => null);
    if (!stillSelected(id)) return;
    if (!r || !r.ok) { setError(r ? await readError(r) : "The cell action failed."); return; }
    await refreshDetail(id);
  };

  const preset = COMPARISON_ROUND_PRESETS[round];
  /** The detail on screen is always the selected set's, never a stale one. */
  const shown = detail && detail.set.id === selected ? detail : null;

  return (
    <section className="space-y-3" data-testid="comparison-section">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Engine comparison</h2>
        <p className="text-xs text-muted-foreground">
          The same prepared prompt rendered by every candidate engine, judged blind. Each run shows the most it could cost before it starts.
        </p>
      </div>

      {error && <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="comparison-error"><AlertTriangle className="w-4 h-4" /> {error}</p>}
      {notice && <p className="text-sm text-foreground" data-testid="comparison-notice">{notice}</p>}

      <div className="rounded-sm border border-border bg-background p-3 space-y-2" data-testid="comparison-create">
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Round</span>
            <select value={round} onChange={(e) => setRound(Number(e.target.value) as 1 | 2)} className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value={1}>Round 1 — every scenario, no style</option>
              <option value={2}>Round 2 — stylisation</option>
            </select>
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Picture size</span>
            <select value={imageSize} onChange={(e) => setImageSize(e.target.value as "comparison" | "final")} data-testid="comparison-image-size" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="comparison">Comparison size (about 1 megapixel)</option>
              <option value="final">Member size (about 4 megapixels)</option>
            </select>
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Fact ids</span>
            <input value={factIds} onChange={(e) => setFactIds(e.target.value)} placeholder="e.g. 12, 40, 77" data-testid="comparison-fact-ids" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground w-40" />
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Round ${round}`} className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground w-48" />
          </label>
          <button type="button" onClick={() => void create()} disabled={creating} data-testid="comparison-create-submit" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create set
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {preset.scenarioKeys.length} scenario{preset.scenarioKeys.length === 1 ? "" : "s"} × {preset.lookStyleIds.join(", ")} × {COMPARISON_DEFAULT_FAMILIES.length} engines ({COMPARISON_DEFAULT_FAMILIES.join(", ")}). {imageSize === "final" ? "Drawn at member size, so each picture's bill is what a member's costs; the \"at most\" figure before a run is priced at comparison size and can be lower than the bill. " : ""}Creating a set spends nothing.
        </p>
      </div>

      {sets === null ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : sets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comparison sets yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="comparison-sets">
          {sets.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setSelected(s.id)} className={`text-xs px-2 py-1 rounded-sm border ${selected === s.id ? "border-primary bg-primary/10" : "border-border"}`}>
                #{s.id} {s.label} · round {s.round}{s.imageSize === "final" ? " · member size" : ""} · {s.panels} panels · {s.cells} cells
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected != null && !shown && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      {shown && (
        <div className="rounded-sm border border-border bg-background p-3 space-y-3" data-testid="comparison-detail">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Set #{shown.set.id} · {shown.set.label}</p>
            <p className="text-xs font-mono text-muted-foreground" data-testid="comparison-aggregate">
              panels: {tallyLine(shown.aggregate.panels)} — cells: {tallyLine(shown.aggregate.cells)}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="comparison-estimate">
              Still to spend, at most: preparing {shown.estimate.preparationBoundUsd == null ? "— (cannot be bounded)" : usd(shown.estimate.preparationBoundUsd)} · rendering {usd(shown.estimate.renderBoundUsd)}
              {Object.keys(shown.estimate.perEngineBoundUsd).length > 0 && (
                <> ({Object.entries(shown.estimate.perEngineBoundUsd).map(([e, v]) => `${e} ${usd(v)}`).join(", ")})</>
              )}
            </p>
            {shown.estimate.preparationRefusal && (
              <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="comparison-preparation-refusal">Preparation cannot run: {shown.estimate.preparationRefusal}</p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <button type="button" disabled={planning} onClick={() => void planRun("prepare")} data-testid="comparison-plan-prepare" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">Plan a preparation run</button>
            <button type="button" disabled={planning} onClick={() => void planRun("render")} data-testid="comparison-plan-render" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">Plan a render run</button>
            <Link href={`/admin/eval/judge/${shown.set.id}`} data-testid="comparison-judge-link" className="px-3 py-1.5 text-sm font-bold rounded-sm border border-primary text-primary hover:bg-primary/10">Judge blind</Link>
            <Link href={`/admin/eval/results?sets=${shown.set.id}`} data-testid="comparison-results-link" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted">Results (shows engines)</Link>
            {planning && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>

          {plan && (
            <div className={`rounded-sm border p-2 text-sm ${plan.result.admitted ? "border-green-500/40 bg-green-500/5" : "border-amber-500/40 bg-amber-500/5"}`} data-testid="comparison-plan">
              {plan.result.admitted ? (
                <p>
                  The next {plan.kind === "prepare" ? "preparation" : "render"} run takes all <strong>{plan.result.items.length}</strong> item{plan.result.items.length === 1 ? "" : "s"} still to do, at most <strong>{usd(plan.result.boundUsd)}</strong>.
                  {" "}
                  <button type="button" disabled={starting} onClick={() => void startRun(plan.kind)} data-testid="comparison-start-run" className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
                    {starting && <Loader2 className="w-3 h-3 animate-spin" />} Start this run — real spend, at most {usd(plan.result.boundUsd)}
                  </button>
                </p>
              ) : (
                <p data-testid="comparison-plan-refusal"><strong>Refused:</strong> {plan.result.refusal}</p>
              )}
            </div>
          )}

          <div className="space-y-1" data-testid="comparison-grid">
            {shown.panels.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="inline-flex items-center gap-1 font-mono text-muted-foreground w-64 shrink-0" title={p.error ?? p.skipReason ?? undefined}>
                  <StateIcon state={p.state} /> fact #{p.factId} · {p.scenarioKey} · {p.lookStyleId}
                  {p.state === "failed" && (
                    <button type="button" onClick={() => void cellAction(p.id, "reprepare")} data-testid={`comparison-reprepare-${p.id}`} className="ml-1 text-primary underline">prepare again</button>
                  )}
                </span>
                {p.cells.map((c) => (
                  <span key={c.id} title={c.error ?? c.skipReason ?? c.state} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-border">
                    <StateIcon state={c.state} /> {c.engineId}
                    {c.state === "failed" && c.vendorResultUrl && (
                      <button type="button" onClick={() => void cellAction(c.id, "retry-storage")} data-testid={`comparison-retry-storage-${c.id}`} className="ml-1 text-primary underline">retry storage</button>
                    )}
                    {c.state === "failed" && !c.vendorResultUrl && (c.rerunCount ?? 0) < 1 && (
                      <button type="button" onClick={() => void cellAction(c.id, "rerun")} data-testid={`comparison-rerun-${c.id}`} className="ml-1 text-primary underline">re-run</button>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>

          {(shown.runs?.length ?? 0) > 0 && (
            <ul className="space-y-0.5 text-[11px] font-mono text-muted-foreground" data-testid="comparison-runs">
              {shown.runs!.map((run) => (
                <li key={run.id}>
                  run #{run.id} · {run.kind} · {run.state} · at most {usd(Number(run.boundUsd))}{run.refusal ? ` · refused: ${run.refusal}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
