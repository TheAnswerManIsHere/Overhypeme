/**
 * Blind judging for the engine comparison — /admin/eval/judge/:setId (launch
 * Phase 8, increment 3; plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
 * *Proposed Design* E).
 *
 * One panel at a time: the same prompt drawn by each candidate engine, in a
 * stable shuffled order, lettered A, B, C… with nothing that names an engine
 * (the server sends opaque tokens and serves each image without its path).
 * David scores every image 1 to 5 (David, 2026-11-10, in place of picking the
 * best) and, on panels with a person's reference photo, marks any face that
 * is not the person. An image an engine could not draw is shown as missing,
 * naming no engine, and the rest are scored. Saving moves to the next panel
 * still to judge; a saved panel can be judged again, which replaces its
 * scores. While images are still rendering the page refreshes every few
 * seconds, keeping the panel on screen and any unsaved scores; a panel
 * skipped at preparation stays listed with its reason.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { readError } from "@/components/admin/EngineComparison";
import { COMPARISON_SCORE_MAX, COMPARISON_SCORE_MIN } from "@workspace/api-zod";

interface BlindImage { token: string; src: string }
interface BlindPanel {
  panelId: number;
  position: number;
  factId: number;
  factText: string;
  scenarioKey: string;
  scenarioLabel: string;
  lookStyleId: string;
  imageMode: string;
  faceMarkable: boolean;
  judgeable: boolean;
  skipped: boolean;
  /** Why a panel that is neither judgeable nor skipped is waiting. */
  waiting?: "lost" | "needs_action" | "rendering" | null;
  skipReason: string | null;
  imagesReady: number;
  imagesExpected: number;
  /** Images an engine could not draw, lost for good. */
  imagesMissing?: number;
  images: BlindImage[];
  /** The saved scores, by blind token. */
  pick: { ratings: Record<string, number>; faceMismatchTokens: string[]; judgedAt: string } | null;
}
interface BlindSet {
  set: { id: number; label: string; round: number };
  progress: { panels: number; judgeable: number; judged: number; skipped: number; lost?: number };
  panels: BlindPanel[];
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** The scale, worst to best, from the wire schema's bounds. */
export const SCORES = Array.from({ length: COMPARISON_SCORE_MAX - COMPARISON_SCORE_MIN + 1 }, (_, i) => COMPARISON_SCORE_MIN + i);

const sameRatings = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([t, v]) => b[t] === v);

/** How often the page re-reads while images are still rendering. */
export const REFRESH_MS = 5_000;

/** The first panel still to judge after `from`, wrapping round; else `from`. */
function nextToJudge(panels: BlindPanel[], from: number): number {
  for (let step = 1; step <= panels.length; step++) {
    const i = (from + step) % panels.length;
    if (panels[i]!.judgeable && !panels[i]!.pick) return i;
  }
  return from;
}

export default function ComparisonJudging({ params }: { params: { setId: string } }) {
  const setId = Number(params.setId);
  const [data, setData] = useState<BlindSet | null>(null);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [faceMarks, setFaceMarks] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (): Promise<BlindSet | null> => {
    const r = await fetch(`/api/admin/comparison/sets/${setId}/judging`, { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError(r ? await readError(r) : "Failed to load the panels."); return null; }
    const body = (await r.json()) as BlindSet;
    setData(body);
    return body;
  }, [setId]);

  useEffect(() => {
    void load().then((body) => {
      if (!body || body.panels.length === 0) return;
      // Open on the first panel still to judge.
      const first = body.panels.findIndex((p) => p.judgeable && !p.pick);
      setIndex(first >= 0 ? first : 0);
    });
  }, [load]);

  const panel = data?.panels[index] ?? null;

  // While any image is still to come, refresh quietly: the panel on screen,
  // and any scores not yet saved, stay as they are.
  // Only work still in progress is polled for: a lost panel will never change,
  // and one that needs action changes only when someone acts on the comparison screen.
  const rendering = !!data && data.panels.some((p) => !p.judgeable && !p.skipped && (p.waiting ?? "rendering") === "rendering");
  useEffect(() => {
    if (!rendering) return;
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [rendering, load]);

  // The panel's saved scores, or a clean slate, whenever the panel changes —
  // before paint, so a click on the newly shown panel is never wiped by a
  // reset that lands after it.
  useLayoutEffect(() => {
    setRatings({ ...(panel?.pick?.ratings ?? {}) });
    setFaceMarks(new Set(panel?.pick?.faceMismatchTokens ?? []));
    setNotice("");
  }, [panel?.panelId, panel?.pick?.judgedAt]);

  const unscored = panel ? panel.images.filter((img) => ratings[img.token] == null).length : 0;
  const complete = !!panel && panel.images.length > 0 && unscored === 0;

  const dirty = useMemo(() => {
    if (!panel) return false;
    const saved = panel.pick;
    if (!saved) return Object.keys(ratings).length > 0;
    const savedMarks = new Set(saved.faceMismatchTokens);
    return !sameRatings(saved.ratings, ratings) || savedMarks.size !== faceMarks.size || [...faceMarks].some((t) => !savedMarks.has(t));
  }, [panel, ratings, faceMarks]);

  const rate = (token: string, score: number) => setRatings((prev) => ({ ...prev, [token]: score }));

  const toggleFace = (token: string) => {
    setFaceMarks((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token); else next.add(token);
      return next;
    });
  };

  const save = async () => {
    if (!panel || !complete) return;
    setSaving(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/panels/${panel.panelId}/pick`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ratings: panel.images.map((img) => ({ token: img.token, score: ratings[img.token]! })),
        faceMismatchTokens: panel.faceMarkable ? [...faceMarks] : [],
      }),
    }).catch(() => null);
    setSaving(false);
    if (!r || !r.ok) { setError(r ? `Not saved: ${await readError(r)}` : "Not saved: the request failed."); return; }
    const body = await load();
    if (!body) return;
    setNotice(`Saved panel ${panel.position}.`);
    setIndex(nextToJudge(body.panels, index));
  };

  const go = (delta: number) => {
    if (!data || data.panels.length === 0) return;
    setIndex((i) => (i + delta + data.panels.length) % data.panels.length);
  };

  return (
    <AdminLayout title="Blind judging">
      <div className="space-y-4 max-w-6xl" data-testid="judging-page">
        <p className="text-xs text-muted-foreground">
          <Link href="/admin/eval" className="text-primary underline">← Eval dashboard</Link>
          {" · "}Score how each picture looks, 1 (worst) to 5 (best); prompt fidelity is tuned after the winner is chosen. Engines stay hidden until{" "}
          <Link href={`/admin/eval/results?sets=${setId}`} className="text-primary underline">the results</Link>.
        </p>

        {error && <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="judging-error"><AlertTriangle className="w-4 h-4" /> {error}</p>}
        {!data && !error && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-foreground">Set #{data.set.id} · {data.set.label} · round {data.set.round}</p>
              <p className="text-xs font-mono text-muted-foreground" data-testid="judging-progress">
                {data.progress.judged} of {data.progress.panels} judged · {data.progress.judgeable} ready to judge
                {data.progress.skipped > 0 ? ` · ${data.progress.skipped} skipped, never judged` : ""}
                {(data.progress.lost ?? 0) > 0 ? ` · ${data.progress.lost} lost every image for good` : ""}
              </p>
            </div>

            {data.panels.length === 0 ? (
              <p className="text-sm text-muted-foreground">This set has no panels to judge.</p>
            ) : panel && (
              <div className="rounded-sm border border-border bg-background p-3 space-y-3" data-testid="judging-panel">
                <div className="flex flex-wrap items-start gap-3 justify-between">
                  <div className="space-y-1">
                    <p className="text-xs font-mono text-muted-foreground">
                      Panel {panel.position} of {data.panels.length} · {panel.scenarioLabel}{panel.lookStyleId !== "none" ? ` · style: ${panel.lookStyleId}` : ""}
                      {panel.pick && <span className="ml-2 inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3 h-3" /> judged</span>}
                    </p>
                    <p className="text-sm text-foreground" data-testid="judging-fact">Fact #{panel.factId}: {panel.factText}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => go(-1)} aria-label="Previous panel" data-testid="judging-prev" className="p-1 rounded-sm border border-border hover:bg-muted"><ChevronLeft className="w-4 h-4" /></button>
                    <button type="button" onClick={() => go(1)} aria-label="Next panel" data-testid="judging-next" className="p-1 rounded-sm border border-border hover:bg-muted"><ChevronRight className="w-4 h-4" /></button>
                  </div>
                </div>

                {panel.skipped ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="judging-skipped">
                    Skipped at preparation, so this panel can't be judged{panel.skipReason ? `: ${panel.skipReason}` : ""}. It still counts in the round.
                  </p>
                ) : panel.waiting === "lost" ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="judging-lost">
                    No engine's image for this panel could be made, so there is nothing to score. It still counts in the round.
                  </p>
                ) : panel.waiting === "needs_action" ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="judging-needs-action">
                    {panel.imagesReady} of {panel.imagesExpected} images are ready, and something failed: re-run it or prepare the panel again on the comparison screen, then come back.
                  </p>
                ) : !panel.judgeable ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="judging-not-ready">
                    {panel.imagesReady} of {panel.imagesExpected} images are ready. A panel is scored once every engine's image is in, or lost for good.
                  </p>
                ) : (
                  <>
                    {(panel.imagesMissing ?? 0) > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="judging-missing">
                        {panel.imagesMissing} engine{panel.imagesMissing === 1 ? "" : "s"} could not draw this panel, so {panel.imagesMissing === 1 ? "its picture is" : "their pictures are"} missing and {panel.imagesMissing === 1 ? "counts" : "count"} as a 1. Score the {panel.images.length} that exist.
                      </p>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="judging-images">
                      {panel.images.map((img, i) => {
                        const score = ratings[img.token];
                        const marked = faceMarks.has(img.token);
                        return (
                          <div key={img.token} className={`rounded-sm border-2 p-1 space-y-1 ${score != null ? "border-primary/60" : "border-transparent"}`}>
                            <div className="block w-full aspect-square bg-muted rounded-sm overflow-hidden">
                              <img src={img.src} alt={`Image ${letter(i)}`} className="w-full h-full object-contain" />
                            </div>
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-bold text-foreground">{letter(i)}</span>
                              <div className="flex items-center gap-1" role="group" aria-label={`Score image ${letter(i)}`}>
                                {SCORES.map((n) => (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() => rate(img.token, n)}
                                    aria-pressed={score === n}
                                    aria-label={`Score image ${letter(i)} ${n} of ${COMPARISON_SCORE_MAX}`}
                                    data-testid={`judging-score-${letter(i)}-${n}`}
                                    className={`w-7 h-7 rounded-sm border text-sm font-bold ${score === n ? "bg-primary text-white border-primary" : "border-border text-foreground hover:bg-muted"}`}
                                  >
                                    {n}
                                  </button>
                                ))}
                              </div>
                            </div>
                            {panel.faceMarkable && (
                              <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <input type="checkbox" checked={marked} onChange={() => toggleFace(img.token)} data-testid={`judging-face-${letter(i)}`} />
                                not the person
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void save()}
                        disabled={!complete || saving || !dirty}
                        data-testid="judging-save"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40"
                      >
                        {saving && <Loader2 className="w-4 h-4 animate-spin" />} {panel.pick ? "Save new scores" : "Save scores"}
                      </button>
                      {!complete && <span className="text-xs text-muted-foreground" data-testid="judging-unscored">Score every picture: {unscored} still to score.</span>}
                      {notice && <span className="text-xs text-foreground" data-testid="judging-notice">{notice}</span>}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
