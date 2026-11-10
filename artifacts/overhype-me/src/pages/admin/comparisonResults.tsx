/**
 * The engine comparison's results — /admin/eval/results?sets=1,2 (launch
 * Phase 8, increment 3; plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
 * *Proposed Design* E). The engines revealed: each one's average score (every
 * image is scored 1 to 5, David, 2026-11-10) per mode (text-to-image;
 * reference edit) with the leader of each, per style and per scenario, how
 * often it could not draw a panel, the "not the person" marks, and what each
 * engine's calls could have cost. Stage 2 of judging (David, 2026-11-10):
 * beside each mode's ranking, what one image from each engine costs — exact
 * for a flat price, "about" for a token price — so quality can be weighed
 * against price after it was judged blind.
 * Several sets read together, so round 1 and round 2 give one winner per mode.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";

interface Score { mean: number | null; count: number }
type Scores = Record<string, Score>;
interface Results {
  sets: Array<{ id: number; label: string; round: number }>;
  families: string[];
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost?: number };
  scores: { overall: Scores; byMode: Record<string, Scores>; byStyle: Record<string, Scores>; byScenario: Record<string, Scores> };
  leaders: Record<string, { families: string[]; mean: number; judged: number }>;
  ranking?: Record<string, RankRow[]>;
  faceMismatches: Record<string, number>;
  humanReferencePanelsJudged: number;
  costs: Record<string, { family: string; calls: number; boundUsd: number }>;
  preparationBoundUsd: number;
}

interface RankRow {
  rank: number;
  family: string;
  engineId: string;
  mean: number | null;
  scored: number;
  lost: number;
  usdPerImage: number | null;
  exact: boolean;
}

const meanText = (mean: number | null) => (mean == null ? "—" : mean.toFixed(2));

function priceText(row: RankRow): string {
  if (row.usdPerImage == null) return "—";
  return (row.exact ? "" : "about ") + "$" + row.usdPerImage.toFixed(3);
}

/**
 * One mode's engines in score order, each with what one of its images costs.
 * Engines with the same average share a rank; one never scored has no rank.
 */
function RankingTable({ label, rows }: { label: string; rows: RankRow[] }) {
  return (
    <div className="rounded-sm border border-border bg-background p-3 space-y-1">
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}: quality, then price</p>
      <table className="text-xs w-full">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-semibold py-0.5">#</th>
            <th className="text-left font-semibold">Engine</th>
            <th className="text-right font-semibold">Average (1–5)</th>
            <th className="text-right font-semibold">Scored</th>
            <th className="text-right font-semibold">Couldn't draw</th>
            <th className="text-right font-semibold">Per image</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.engineId} className="border-t border-border">
              <td className="py-0.5 text-muted-foreground">{row.mean == null ? "—" : row.rank}</td>
              <td className="font-mono text-foreground">{row.family}</td>
              <td className="text-right font-bold text-foreground">{meanText(row.mean)}</td>
              <td className="text-right text-foreground">{row.scored}</td>
              <td className={`text-right ${row.lost > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground"}`}>{row.lost}</td>
              <td className="text-right font-mono text-foreground">{priceText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MODE_LABEL: Record<string, string> = { t2i: "Text-to-image", i2i: "Reference edit" };
const usd = (n: number) => `$${n.toFixed(2)}`;

function setsFromUrl(): string {
  return new URLSearchParams(window.location.search).get("sets") ?? "";
}

/** Each family's average score per group; a blank cell is a family with no score there. */
function ScoresTable({ title, groups, families, testId }: { title: string; groups: Record<string, Scores>; families: string[]; testId: string }) {
  const keys = Object.keys(groups).sort();
  if (keys.length === 0) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left pr-3 py-1 font-semibold text-muted-foreground" />
              {families.map((f) => <th key={f} className="px-2 py-1 font-mono font-semibold text-muted-foreground">{f}</th>)}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t border-border">
                <td className="pr-3 py-1 font-mono text-foreground">{MODE_LABEL[k] ?? k}</td>
                {families.map((f) => <td key={f} className="px-2 py-1 text-center text-foreground" title={groups[k]![f] ? `${groups[k]![f]!.count} scored` : undefined}>{meanText(groups[k]![f]?.mean ?? null)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ComparisonResults() {
  const [setsText, setSetsText] = useState(setsFromUrl);
  const [data, setData] = useState<Results | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (text: string) => {
    const ids = text.match(/[^\s,]+/g) ?? [];
    if (ids.length === 0 || ids.some((s) => !/^\d+$/.test(s))) { setError("Enter one or more set ids, comma-separated."); return; }
    setLoading(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/results?setIds=${ids.join(",")}`, { credentials: "include" }).catch(() => null);
    setLoading(false);
    if (!r || !r.ok) { setData(null); setError(r ? (r.status === 404 ? "One of those sets does not exist." : `Failed to load the results (${r.status}).`) : "Failed to load the results."); return; }
    setData((await r.json()) as Results);
  }, []);

  useEffect(() => { if (setsText.trim()) void load(setsText); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCost = data ? Object.values(data.costs).reduce((s, c) => s + c.boundUsd, 0) + data.preparationBoundUsd : 0;

  return (
    <AdminLayout title="Comparison results">
      <div className="space-y-4 max-w-5xl" data-testid="results-page">
        <p className="text-xs text-muted-foreground"><Link href="/admin/eval" className="text-primary underline">← Eval dashboard</Link> · This page names the engines. Judge first.</p>

        <div className="flex items-end gap-2">
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">Set ids</span>
            <input value={setsText} onChange={(e) => setSetsText(e.target.value)} placeholder="e.g. 4, 5" data-testid="results-set-ids" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground w-40" />
          </label>
          <button type="button" onClick={() => void load(setsText)} data-testid="results-load" className="px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted">Show results</button>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>

        {error && <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="results-error"><AlertTriangle className="w-4 h-4" /> {error}</p>}

        {data && (
          <div className="space-y-4">
            <p className="text-sm text-foreground" data-testid="results-summary">
              {data.sets.map((s) => `#${s.id} ${s.label} (round ${s.round})`).join(" + ")} — {data.panels.judged} of {data.panels.total} panels judged
              {data.panels.judged < data.panels.total ? ` (${data.panels.judgeable} ready to judge)` : ""}.
              {(data.panels.lost ?? 0) > 0 && <strong> {data.panels.lost} panel{data.panels.lost === 1 ? " lost" : "s lost"} every image for good and will never be judged.</strong>}
              {data.panels.skipped > 0 && <strong> {data.panels.skipped} panel{data.panels.skipped === 1 ? " was" : "s were"} skipped at preparation and will never be judged: this comparison is smaller than planned.</strong>}
            </p>

            <div className="grid sm:grid-cols-2 gap-3" data-testid="results-leaders">
              {["t2i", "i2i"].map((mode) => {
                const lead = data.leaders[mode];
                return (
                  <div key={mode} className="rounded-sm border border-border bg-background p-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{MODE_LABEL[mode]}</p>
                    {lead ? (
                      <p className="text-sm text-foreground">
                        <strong className="font-mono">{lead.families.join(" = ")}</strong> — average {lead.mean.toFixed(2)} of 5, over {lead.judged} panel{lead.judged === 1 ? "" : "s"}{lead.families.length > 1 ? " (tied)" : ""}
                      </p>
                    ) : <p className="text-sm text-muted-foreground">No panels judged yet.</p>}
                  </div>
                );
              })}
            </div>

            {data.ranking && Object.keys(data.ranking).length > 0 && (
              <div className="space-y-1" data-testid="results-ranking">
                <div className="grid sm:grid-cols-2 gap-3">
                  {["t2i", "i2i"].filter((m) => data.ranking![m]).map((mode) => (
                    <RankingTable key={mode} label={MODE_LABEL[mode] ?? mode} rows={data.ranking![mode]!} />
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">Ranked by average score; equal averages share a rank. "Couldn't draw" counts this engine's images lost for good, which have no score. Per-image prices are fal's list prices at the comparison's size (about 1 megapixel). "About" marks a token-billed engine: a typical cost, within about 10%.</p>
              </div>
            )}

            <ScoresTable title="Average score by mode" groups={data.scores.byMode} families={data.families} testId="results-by-mode" />
            <ScoresTable title="Average score by style" groups={data.scores.byStyle} families={data.families} testId="results-by-style" />
            <ScoresTable title="Average score by scenario" groups={data.scores.byScenario} families={data.families} testId="results-by-scenario" />

            <div className="space-y-1" data-testid="results-faces">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">"Not the person" marks, of {data.humanReferencePanelsJudged} judged panels with a person's photo</h3>
              <p className="text-xs font-mono text-foreground">
                {data.families.map((f) => `${f} ${data.faceMismatches[f] ?? 0}`).join(" · ")}
              </p>
            </div>

            <div className="space-y-1" data-testid="results-costs">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Calls made, at most</h3>
              <ul className="text-xs font-mono text-foreground space-y-0.5">
                {Object.entries(data.costs).sort(([a], [b]) => a.localeCompare(b)).map(([engine, c]) => (
                  <li key={engine}>{engine} ({c.family}) · {c.calls} call{c.calls === 1 ? "" : "s"} · {usd(c.boundUsd)}</li>
                ))}
                <li>planner preparation · {usd(data.preparationBoundUsd)}</li>
                <li className="font-bold">total, at most · {usd(totalCost)}</li>
              </ul>
              <p className="text-[11px] text-muted-foreground">Each call is recorded at the most it could cost; fal's dashboard has what was billed.</p>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
