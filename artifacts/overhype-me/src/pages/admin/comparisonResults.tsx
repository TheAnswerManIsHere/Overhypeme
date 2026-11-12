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
 *
 * A set judged on the second edition (the prompt tuner; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C) reads differently:
 * per mode, each engine's share of the panels on which its picture was the one
 * to send (the headline), its average on each category, how many of its
 * pictures were marked broken or could not be drawn, and what each picture
 * cost and how long it took. No single blended score is computed. Sets judged
 * on the two editions are never read together; the server refuses the mix.
 */
import { useCallback, useEffect, useState } from "react";
import { promoteRecipeVersion } from "@/components/admin/promoteRecipeVersion";
import { Link } from "wouter";
import { AlertTriangle, Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { COMPARISON_SCORE_MAX, JUDGING_CATEGORIES, type JudgingCategoryKey } from "@workspace/api-zod";

interface JudgedRow {
  family: string;
  engineId: string;
  recipeVersionId?: number | null;
  recipeLabel?: string;
  recipeNote?: string | null;
  panels: number;
  picked: number;
  pickShare: number | null;
  categories: Record<JudgingCategoryKey, Score>;
  scored: number;
  lost: number;
  broken: number;
  billedUsdPerImage: number | null;
  billedMinUsd: number | null;
  billedMaxUsd: number | null;
  billed: number;
  medianSeconds: number | null;
  slowestSeconds: number | null;
  timed: number;
}
interface JudgedPicture {
  panelId: number; factId: number; scenarioKey: string; lookStyleId: string; imageMode: string;
  engineId: string; family: string; recipeVersionId: number | null; recipeLabel: string;
  promptText: string | null; picked: boolean; broken: boolean; lost: boolean; scores: Partial<Record<JudgingCategoryKey, number>> | null;
}
interface JudgedResults {
  edition: 2;
  kind?: "engine" | "prompt";
  family?: string | null;
  sets: Array<{ id: number; label: string; round: number; imageSize?: string }>;
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost: number };
  rows: Record<string, JudgedRow[]>;
  byLook?: Record<string, Record<string, JudgedRow[]>>;
  pictures?: JudgedPicture[];
}

interface Score { mean: number | null; count: number }
type Scores = Record<string, Score>;
interface Results {
  edition?: 1;
  sets: Array<{ id: number; label: string; round: number; imageSize?: string }>;
  families: string[];
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost?: number };
  scores: { overall: Scores; byMode: Record<string, Scores>; byStyle: Record<string, Scores>; byScenario: Record<string, Scores> };
  leaders: Record<string, { families: string[]; pictures?: number[]; mean: number; judged: number }>;
  ranking?: Record<string, RankRow[]>;
  faceMismatches: Record<string, number>;
  styleCaptured?: Record<string, Record<string, { captured: number; pictures: number }>>;
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
  billedUsdPerImage?: number | null;
  billedMinUsd?: number | null;
  billedMaxUsd?: number | null;
  billed?: number;
  medianSeconds?: number | null;
  slowestSeconds?: number | null;
  timed?: number;
}

/** "14s (slowest 41s)", or a dash when nothing was timed. */
function timeText(row: Pick<RankRow, "medianSeconds" | "slowestSeconds">): string {
  if (row.medianSeconds == null) return "—";
  const s = (n: number) => (n >= 100 ? `${Math.round(n)}s` : `${n.toFixed(n < 10 ? 1 : 0)}s`);
  return `${s(row.medianSeconds)} (slowest ${s(row.slowestSeconds ?? row.medianSeconds)})`;
}

const meanText = (mean: number | null) => (mean == null ? "—" : mean.toFixed(2));

/** "$0.040 ($0.040–$0.041, 12 billed)": what fal charged per picture, or a dash before any bill is read. */
function billedText(row: Pick<RankRow, "billedUsdPerImage" | "billedMinUsd" | "billedMaxUsd" | "billed">): string {
  if (row.billedUsdPerImage == null) return "—";
  const usd = (n: number) => "$" + n.toFixed(3);
  const lo = row.billedMinUsd ?? row.billedUsdPerImage;
  const hi = row.billedMaxUsd ?? row.billedUsdPerImage;
  const range = usd(lo) === usd(hi) ? "" : `${usd(lo)}–${usd(hi)}, `;
  return `${usd(row.billedUsdPerImage)} (${range}${row.billed ?? 0} billed)`;
}

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
            <th className="text-right font-semibold">Couldn't draw (as 1)</th>
            <th className="text-right font-semibold">Billed per image</th>
            <th className="text-right font-semibold">List price</th>
            <th className="text-right font-semibold">Time per image</th>
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
              <td className="text-right font-mono font-bold text-foreground" data-testid={`results-billed-${row.engineId}`}>{billedText(row)}</td>
              <td className="text-right font-mono text-muted-foreground">{priceText(row)}</td>
              <td className="text-right font-mono text-foreground" title={row.timed ? `median of ${row.timed} timed` : undefined}>{timeText(row)}</td>
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

/** One mode's engines by pick share, each with its category averages, marks, cost and time. */
function JudgedTable({ label, rows, onPromote }: { label: string; rows: JudgedRow[]; onPromote?: (row: JudgedRow) => void }) {
  const asked = JUDGING_CATEGORIES.filter((c) => rows.some((r) => r.categories[c.key]?.count > 0));
  return (
    <div className="rounded-sm border border-border bg-background p-3 space-y-1 overflow-x-auto" data-testid={`results-judged-${label}`}>
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
      <table className="text-xs w-full">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-semibold py-0.5">{onPromote ? "Wording" : "Engine"}</th>
            <th className="text-right font-semibold">Picked to send</th>
            {asked.map((c) => <th key={c.key} className="text-right font-semibold" title={c.help}>{c.label}</th>)}
            <th className="text-right font-semibold">Broken</th>
            <th className="text-right font-semibold">Couldn't draw (as 1)</th>
            <th className="text-right font-semibold">Billed per image</th>
            <th className="text-right font-semibold">Time per image</th>
            {onPromote && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.engineId}|${row.recipeVersionId ?? 0}`} className="border-t border-border" data-testid={`results-row-${row.engineId}${onPromote ? `-${row.recipeVersionId ?? 0}` : ""}`}>
              <td className="py-0.5 font-mono text-foreground">{onPromote ? (row.recipeLabel ?? "Baseline") : row.family}{onPromote && row.recipeNote ? <span className="block text-[10px] text-muted-foreground font-sans">{row.recipeNote}</span> : null}</td>
              <td className="text-right font-bold text-foreground">{row.pickShare == null ? "—" : `${Math.round(row.pickShare * 100)}% (${row.picked} of ${row.panels})`}</td>
              {asked.map((c) => <td key={c.key} className="text-right text-foreground">{meanText(row.categories[c.key]?.mean ?? null)}<span className="block text-[10px] text-muted-foreground">{row.categories[c.key]?.count ?? 0} pictures</span></td>)}
              <td className={`text-right ${row.broken > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground"}`}>{row.broken}</td>
              <td className={`text-right ${row.lost > 0 ? "text-amber-600 dark:text-amber-400 font-bold" : "text-muted-foreground"}`}>{row.lost}</td>
              <td className="text-right font-mono text-foreground">{billedText(row)}</td>
              <td className="text-right font-mono text-foreground">{timeText(row)}</td>
              {onPromote && (
                <td className="text-right">
                  <button type="button" onClick={() => onPromote(row)} data-testid={`results-promote-${row.recipeVersionId ?? 0}`} className="px-2 py-0.5 rounded-sm border border-border hover:bg-muted">Promote</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JudgedResultsView({ data }: { data: JudgedResults }) {
  const [notice, setNotice] = useState("");
  const prompt = data.kind === "prompt" && !!data.family;
  /** Promote a version from its results (plan PLAN_PROMPT_TUNER.md, D): a confirmation, and a second for a changed policy line. */
  const promote = async (row: JudgedRow) => {
    const result = await promoteRecipeVersion({ family: data.family!, versionId: row.recipeVersionId ?? null, name: row.recipeLabel ?? "Baseline" });
    if (result) setNotice(result.ok ? result.message : `Not promoted: ${result.message}`);
  };
  const looks = Object.keys(data.byLook ?? {}).sort();
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground" data-testid="results-summary">
        {data.sets.map((s) => `#${s.id} ${s.label}${s.imageSize === "final" ? " (member size)" : ""}`).join(" + ")} — {data.panels.judged} of {data.panels.total} panels judged
        {data.panels.judged < data.panels.total ? ` (${data.panels.judgeable} ready to judge)` : ""}.
        {data.panels.lost > 0 && <strong> {data.panels.lost} panel{data.panels.lost === 1 ? " lost" : "s lost"} every picture for good and will never be judged.</strong>}
        {data.panels.skipped > 0 && <strong> {data.panels.skipped} panel{data.panels.skipped === 1 ? " was" : "s were"} skipped at preparation and will never be judged.</strong>}
      </p>
      {Object.keys(data.rows).length === 0 ? (
        <p className="text-sm text-muted-foreground">No pictures yet.</p>
      ) : (
        <div className="space-y-3">
          {["t2i", "i2i"].filter((m) => data.rows[m]).map((mode) => <JudgedTable key={mode} label={MODE_LABEL[mode] ?? mode} rows={data.rows[mode]!} {...(prompt ? { onPromote: (row: JudgedRow) => void promote(row) } : {})} />)}
          {notice && <p className="text-sm text-foreground" data-testid="results-notice">{notice}</p>}
          {looks.length > 1 && (
            <div className="space-y-2" data-testid="results-by-look">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">By look</h3>
              {looks.map((look) => ["t2i", "i2i"].filter((m) => data.byLook![look]![m]).map((mode) => (
                <JudgedTable key={`${look}-${mode}`} label={`${look === "none" ? "No look" : look} · ${MODE_LABEL[mode] ?? mode}`} rows={data.byLook![look]![mode]!} />
              )))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            "Picked to send" is the share of judged panels on which this {prompt ? "wording's" : "engine's"} picture was the one you would send; a picture that could not be drawn stays in the count and can never be picked. Each category is averaged over the pictures it was asked on (1 to {COMPARISON_SCORE_MAX}); a picture that could not be drawn counts as a 1 in each. Results rest on the number of panels shown beside the share.
          </p>
          {(data.pictures ?? []).length > 0 && (
            <details className="rounded-sm border border-dashed border-border p-2 text-xs" data-testid="results-pictures">
              <summary className="cursor-pointer font-bold text-foreground">Every picture, with the exact prompt it was sent</summary>
              <ul className="mt-2 space-y-2">
                {data.pictures!.map((p, i) => (
                  <li key={i} className="space-y-0.5">
                    <p className="text-foreground">
                      Fact #{p.factId} · {p.scenarioKey} · {p.lookStyleId} · <span className="font-mono">{p.family}</span> · {p.recipeLabel}
                      {p.picked ? " · picked to send" : ""}{p.broken ? " · broken" : ""}{p.lost ? " · could not be drawn" : ""}
                    </p>
                    {p.promptText && <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground max-h-40 overflow-auto">{p.promptText}</pre>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function ComparisonResults() {
  const [setsText, setSetsText] = useState(setsFromUrl);
  const [data, setData] = useState<Results | null>(null);
  const [judged, setJudged] = useState<JudgedResults | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (text: string) => {
    const ids = text.match(/[^\s,]+/g) ?? [];
    if (ids.length === 0 || ids.some((s) => !/^\d+$/.test(s))) { setError("Enter one or more set ids, comma-separated."); return; }
    setLoading(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/results?setIds=${ids.join(",")}`, { credentials: "include" }).catch(() => null);
    setLoading(false);
    if (!r || !r.ok) {
      setData(null);
      setJudged(null);
      setError(r ? (r.status === 404 ? "One of those sets does not exist." : r.status === 409 ? "Those sets were judged in different ways, so they can't be read together. Read the older and the newer sets separately." : `Failed to load the results (${r.status}).`) : "Failed to load the results.");
      return;
    }
    const body = (await r.json()) as Results | JudgedResults;
    if (body.edition === 2) { setJudged(body); setData(null); } else { setData(body); setJudged(null); }
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

        {judged && <JudgedResultsView data={judged} />}

        {data && (
          <div className="space-y-4">
            <p className="text-sm text-foreground" data-testid="results-summary">
              {data.sets.map((s) => `#${s.id} ${s.label} (round ${s.round}${s.imageSize === "final" ? ", member size" : ""})`).join(" + ")} — {data.panels.judged} of {data.panels.total} panels judged
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
                        <strong className="font-mono">{lead.families.map((f, i) => (lead.pictures ? `${f} (${lead.pictures[i]} picture${lead.pictures[i] === 1 ? "" : "s"})` : f)).join(" = ")}</strong> — average {lead.mean.toFixed(2)} of {COMPARISON_SCORE_MAX}, {lead.judged} panel{lead.judged === 1 ? "" : "s"} judged{lead.families.length > 1 ? " (tied)" : ""}
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
                <p className="text-[11px] text-muted-foreground">Ranked by average score; equal averages share a rank. "Couldn't draw" counts this engine's pictures lost for good on judged panels; each counts as a 1 in its average. Time per image is the median from sending the request to fal to getting the picture back (fal's queue plus drawing), with the slowest beside it. "Billed per image" is what fal actually charged, averaged over the pictures this engine drew, with the cheapest and dearest beside it; a dash means fal has not billed them yet. List prices are fal's published prices at the comparison's size (about 1 megapixel); "about" marks a token-billed engine, whose list figure is an estimate.</p>
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

            {data.styleCaptured && Object.keys(data.styleCaptured).length > 0 && (
              <div className="space-y-1" data-testid="results-style-captured">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">"Captured the style", by style: pictures marked of pictures judged</h3>
                <table className="text-xs font-mono text-foreground">
                  <thead>
                    <tr>
                      <th className="text-left pr-3 font-semibold">Style</th>
                      {data.families.map((f) => <th key={f} className="text-right pr-3 font-semibold">{f}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.styleCaptured).sort(([a], [b]) => a.localeCompare(b)).map(([style, byFamily]) => (
                      <tr key={style}>
                        <td className="pr-3">{style}</td>
                        {data.families.map((f) => {
                          const c = byFamily[f];
                          return <td key={f} className="text-right pr-3">{c ? `${c.captured} of ${c.pictures}` : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

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
