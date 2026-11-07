/**
 * The engine comparison on the eval dashboard (launch Phase 8, increment 2a;
 * plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Admin/User UX Impact*).
 *
 * Create a comparison set from a round preset, see each set's status at both
 * altitudes (every cell's state, and the aggregate), its bounded estimate, and
 * plan the next run of a kind: the run's bound and how many runs are left, or
 * the refusal with the figure. Planning spends nothing; running arrives in
 * increment 2b.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, MinusCircle, Plus } from "lucide-react";
import {
  COMPARISON_DEFAULT_FAMILIES,
  COMPARISON_ROUND_PRESETS,
  PAID_RUN_ALLOWANCE_USD,
  PAID_WEEK_ALLOWANCE_USD,
} from "@workspace/api-zod";

interface SetSummary { id: number; label: string; round: number; createdAt: string; panels: number; cells: number }
interface CellView { id: number; engineId: string; state: string; skipReason: string | null; error: string | null }
interface PanelView { id: number; factId: number; scenarioKey: string; lookStyleId: string; imageMode: string; state: string; skipReason: string | null; error: string | null; cells: CellView[] }
interface SetDetail {
  set: { id: number; label: string; round: number; engineFamilies: string[] };
  panels: PanelView[];
  aggregate: { panels: Record<string, number>; cells: Record<string, number> };
  estimate: { preparationBoundUsd: number; renderBoundUsd: number; perEngineBoundUsd: Record<string, number> };
}
interface RunPlan {
  admitted: boolean;
  items: Array<{ ref: string; label: string; boundUsd: number }>;
  boundUsd: number;
  allowanceUsd: number;
  remainingItems: number;
  remainingBoundUsd: number;
  runsNeeded: number;
  refusal: string | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function StateIcon({ state }: { state: string }) {
  if (state === "rendered" || state === "prepared") return <CheckCircle2 className="w-3 h-3 text-green-500" />;
  if (state === "failed") return <AlertTriangle className="w-3 h-3 text-amber-500" />;
  if (state === "skipped") return <MinusCircle className="w-3 h-3 text-muted-foreground" />;
  if (state === "enqueued") return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
  return <Circle className="w-3 h-3 text-muted-foreground" />;
}

function tallyLine(t: Record<string, number>): string {
  return Object.entries(t).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(" · ") || "none";
}

async function readError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string; reasons?: string[] } | null;
  if (body?.reasons?.length) return body.reasons.join("; ");
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
  const [factIds, setFactIds] = useState("");
  const [weekRemaining, setWeekRemaining] = useState(String(PAID_WEEK_ALLOWANCE_USD));
  const [plan, setPlan] = useState<{ kind: string; result: RunPlan } | null>(null);
  const [planning, setPlanning] = useState(false);

  const loadSets = useCallback(async () => {
    const r = await fetch("/api/admin/comparison/sets", { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError("Failed to load comparison sets."); return; }
    setSets(((await r.json()) as { sets?: SetSummary[] }).sets ?? []);
  }, []);
  useEffect(() => { void loadSets(); }, [loadSets]);

  const loadDetail = useCallback(async (id: number) => {
    setDetail(null);
    setPlan(null);
    const r = await fetch(`/api/admin/comparison/sets/${id}`, { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError(r ? await readError(r) : "Failed to load the set."); return; }
    setDetail((await r.json()) as SetDetail);
  }, []);
  useEffect(() => { if (selected != null) void loadDetail(selected); }, [selected, loadDetail]);

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
    if (selected == null) return;
    const week = Number(weekRemaining);
    if (!Number.isFinite(week) || week < 0 || week > PAID_WEEK_ALLOWANCE_USD) { setError(`This week's remaining budget is between $0 and ${usd(PAID_WEEK_ALLOWANCE_USD)}.`); return; }
    setPlanning(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/sets/${selected}/plan`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, weekRemainingUsd: week }),
    }).catch(() => null);
    setPlanning(false);
    if (!r || !r.ok) { setError(r ? await readError(r) : "Failed to plan the run."); return; }
    setPlan({ kind, result: (await r.json()) as RunPlan });
  };

  const preset = COMPARISON_ROUND_PRESETS[round];

  return (
    <section className="space-y-3" data-testid="comparison-section">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Engine comparison</h2>
        <p className="text-xs text-muted-foreground">
          The same prepared prompt rendered by every candidate engine, judged blind. Every run is bounded under {usd(PAID_RUN_ALLOWANCE_USD)} before it is dispatched.
        </p>
      </div>

      {error && <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="comparison-error"><AlertTriangle className="w-4 h-4" /> {error}</p>}

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
          {preset.scenarioKeys.length} scenario{preset.scenarioKeys.length === 1 ? "" : "s"} × {preset.lookStyleIds.join(", ")} × {COMPARISON_DEFAULT_FAMILIES.length} engines ({COMPARISON_DEFAULT_FAMILIES.join(", ")}). Creating a set spends nothing.
        </p>
      </div>

      {sets === null ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : sets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comparison sets yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="comparison-sets">
          {sets.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setSelected(s.id)} className={`text-xs px-2 py-1 rounded-sm border ${selected === s.id ? "border-primary bg-primary/10" : "border-border"}`}>
                #{s.id} {s.label} · round {s.round} · {s.panels} panels · {s.cells} cells
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected != null && !detail && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      {detail && (
        <div className="rounded-sm border border-border bg-background p-3 space-y-3" data-testid="comparison-detail">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Set #{detail.set.id} · {detail.set.label}</p>
            <p className="text-xs font-mono text-muted-foreground" data-testid="comparison-aggregate">
              panels: {tallyLine(detail.aggregate.panels)} — cells: {tallyLine(detail.aggregate.cells)}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="comparison-estimate">
              Still to spend, at most: preparing {usd(detail.estimate.preparationBoundUsd)} · rendering {usd(detail.estimate.renderBoundUsd)}
              {Object.keys(detail.estimate.perEngineBoundUsd).length > 0 && (
                <> ({Object.entries(detail.estimate.perEngineBoundUsd).map(([e, v]) => `${e} ${usd(v)}`).join(", ")})</>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Left this week (from the paid-run ledger)</span>
              <input value={weekRemaining} onChange={(e) => setWeekRemaining(e.target.value)} inputMode="decimal" data-testid="comparison-week-remaining" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground w-28" />
            </label>
            <button type="button" disabled={planning} onClick={() => void planRun("prepare")} data-testid="comparison-plan-prepare" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">Plan a preparation run</button>
            <button type="button" disabled={planning} onClick={() => void planRun("render")} data-testid="comparison-plan-render" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">Plan a render run</button>
            {planning && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>

          {plan && (
            <div className={`rounded-sm border p-2 text-sm ${plan.result.admitted ? "border-green-500/40 bg-green-500/5" : "border-amber-500/40 bg-amber-500/5"}`} data-testid="comparison-plan">
              {plan.result.admitted ? (
                <p>
                  The next {plan.kind === "prepare" ? "preparation" : "render"} run takes <strong>{plan.result.items.length}</strong> item{plan.result.items.length === 1 ? "" : "s"}, bounded at <strong>{usd(plan.result.boundUsd)}</strong> of the {usd(plan.result.allowanceUsd)} allowance.
                  {" "}{plan.result.remainingItems > 0 ? `${plan.result.remainingItems} more (at most ${usd(plan.result.remainingBoundUsd)}) need ${plan.result.runsNeeded - 1} further run${plan.result.runsNeeded - 1 === 1 ? "" : "s"}.` : "That finishes this kind of work."}
                </p>
              ) : (
                <p data-testid="comparison-plan-refusal"><strong>Refused:</strong> {plan.result.refusal}</p>
              )}
            </div>
          )}

          <div className="space-y-1" data-testid="comparison-grid">
            {detail.panels.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="inline-flex items-center gap-1 font-mono text-muted-foreground w-64 shrink-0" title={p.error ?? p.skipReason ?? undefined}>
                  <StateIcon state={p.state} /> fact #{p.factId} · {p.scenarioKey} · {p.lookStyleId}
                </span>
                {p.cells.map((c) => (
                  <span key={c.id} title={c.error ?? c.skipReason ?? c.state} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-border">
                    <StateIcon state={c.state} /> {c.engineId}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
