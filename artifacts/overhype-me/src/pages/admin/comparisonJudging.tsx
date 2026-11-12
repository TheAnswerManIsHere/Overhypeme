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
 *
 * A set made since the prompt tuner (judging edition 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C) is judged
 * differently: the panel shows the fact and its approved gag as they were
 * frozen at preparation, and never the prompt; every picture is scored 1 to 5
 * on each category the panel asks (Visual quality, Gag fidelity and Realism
 * always; Style interpretation on a styled panel; Likeness where a photo was
 * supplied), one picture is picked as the one to send, and any can be marked
 * broken.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { readError } from "@/components/admin/EngineComparison";
import { COMPARISON_SCORE_MAX, COMPARISON_SCORE_MIN, JUDGING_CATEGORIES, type JudgingCategoryKey } from "@workspace/api-zod";

type CategoryScores = Partial<Record<JudgingCategoryKey, number>>;
interface Judgement { scores: Record<string, CategoryScores>; bestToken: string | null; brokenTokens: string[]; judgedAt: string }

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
  /** A styled panel: each picture can be marked "captured the style". */
  styleMarkable?: boolean;
  /** The source photo every engine was given (reference panels only). */
  reference?: { src: string; identityType: string | null } | null;
  /** The prompt every engine was sent, word for word. */
  prompt?: string | null;
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
  pick: { ratings: Record<string, number>; faceMismatchTokens: string[]; styleCapturedTokens?: string[]; judgedAt: string } | null;
  /** Second edition: the approved gag, frozen at preparation. */
  gag?: string | null;
  /** Second edition: the categories each picture is scored on. */
  categories?: JudgingCategoryKey[];
  /** Second edition: the saved judgement, by blind token. */
  judgement?: Judgement | null;
}
interface BlindSet {
  set: { id: number; label: string; round: number; judgingEdition?: number };
  progress: { panels: number; judgeable: number; judged: number; skipped: number; lost?: number };
  panels: BlindPanel[];
}

const sameSet = (saved: string[], current: Set<string>) => saved.length === current.size && saved.every((t) => current.has(t));

const letter = (i: number) => String.fromCharCode(65 + i);

/** The scale, worst to best, from the wire schema's bounds. */
export const SCORES = Array.from({ length: COMPARISON_SCORE_MAX - COMPARISON_SCORE_MIN + 1 }, (_, i) => COMPARISON_SCORE_MIN + i);

const sameRatings = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([t, v]) => b[t] === v);

/** How often the page re-reads while images are still rendering. */
export const REFRESH_MS = 5_000;

const isJudged = (p: BlindPanel) => !!(p.pick || p.judgement);

const CATEGORY = Object.fromEntries(JUDGING_CATEGORIES.map((c) => [c.key, c])) as Record<JudgingCategoryKey, (typeof JUDGING_CATEGORIES)[number]>;

/**
 * A second-edition judgement of one panel: each picture scored on the
 * panel's categories, one picked to send, any marked broken. Its state is
 * the panel's saved judgement or a clean slate; the parent remounts it when
 * the panel or its saved judgement changes.
 */
export function JudgementForm({ panel, onSave, saving }: { panel: BlindPanel; onSave: (body: unknown) => void; saving: boolean }) {
  const categories = panel.categories ?? [];
  const [scores, setScores] = useState<Record<string, CategoryScores>>(() => structuredClone(panel.judgement?.scores ?? {}));
  const [best, setBest] = useState<string | null>(panel.judgement?.bestToken ?? null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set(panel.judgement?.brokenTokens ?? []));

  const missing = panel.images.reduce((n, img) => n + categories.filter((k) => scores[img.token]?.[k] == null).length, 0);
  const complete = panel.images.length > 0 && missing === 0 && best != null;
  const saved = panel.judgement;
  const sameScores = !!saved && panel.images.every((img) => categories.every((k) => saved.scores[img.token]?.[k] === scores[img.token]?.[k]));
  const dirty = !saved || !sameScores || saved.bestToken !== best
    || !sameSet(saved.brokenTokens, broken);

  const rate = (token: string, k: JudgingCategoryKey, n: number) => setScores((prev) => ({ ...prev, [token]: { ...prev[token], [k]: n } }));
  const toggleBroken = (token: string) => setBroken((prev) => {
    const next = new Set(prev);
    if (next.has(token)) next.delete(token); else next.add(token);
    return next;
  });
  const submit = () => {
    if (!complete) return;
    onSave({
      scores: panel.images.map((img) => ({ token: img.token, ...Object.fromEntries(categories.map((k) => [k, scores[img.token]![k]])) })),
      bestToken: best,
      brokenTokens: [...broken],
    });
  };

  return (
    <>
      <dl className="grid gap-1 rounded-sm border border-dashed border-border p-2 text-xs" data-testid="judging-categories">
        {categories.map((k) => (
          <div key={k}>
            <dt className="inline font-bold text-foreground">{CATEGORY[k].label}: </dt>
            <dd className="inline text-muted-foreground">{CATEGORY[k].help}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="judging-images">
        {panel.images.map((img, i) => {
          const L = letter(i);
          const isBest = best === img.token;
          return (
            <div key={img.token} className={`rounded-sm border-2 p-1 space-y-1 ${isBest ? "border-primary" : "border-transparent"}`} data-testid={`judging-card-${L}`}>
              <div className="block w-full aspect-square bg-muted rounded-sm overflow-hidden">
                <img src={img.src} alt={`Image ${L}`} className="w-full h-full object-contain" />
              </div>
              <p className="text-xs font-bold text-foreground">{L}</p>
              {categories.map((k) => (
                <div key={k} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-foreground">{CATEGORY[k].label}</span>
                  <div className="flex items-center gap-1" role="group" aria-label={`${CATEGORY[k].label}, image ${L}`}>
                    {SCORES.map((n) => {
                      const on = scores[img.token]?.[k] === n;
                      return (
                        <button
                          key={n}
                          type="button"
                          onClick={() => rate(img.token, k, n)}
                          aria-pressed={on}
                          aria-label={`${CATEGORY[k].label}, image ${L}: ${n} of ${COMPARISON_SCORE_MAX}`}
                          data-testid={`judging-${k}-${L}-${n}`}
                          className={`w-7 h-7 rounded-sm border text-sm font-bold ${on ? "bg-primary text-white border-primary" : "border-border text-foreground hover:bg-muted"}`}
                        >
                          {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 text-xs pt-1">
                <label className="inline-flex items-center gap-1 font-bold text-foreground">
                  <input type="radio" name={`best-${panel.panelId}`} checked={isBest} onChange={() => setBest(img.token)} data-testid={`judging-best-${L}`} />
                  Send this one
                </label>
                <label className="inline-flex items-center gap-1 text-muted-foreground" title="The wrong person, extra limbs, stray text or a watermark">
                  <input type="checkbox" checked={broken.has(img.token)} onChange={() => toggleBroken(img.token)} data-testid={`judging-broken-${L}`} />
                  Broken
                </label>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!complete || saving || !dirty}
          data-testid="judging-save"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />} {saved ? "Save new judgement" : "Save judgement"}
        </button>
        {!complete && (
          <span className="text-xs text-muted-foreground" data-testid="judging-unscored">
            {missing > 0 ? `${missing} score${missing === 1 ? "" : "s"} still to give` : ""}{missing > 0 && best == null ? "; " : ""}{best == null ? "pick the one you would send" : ""}.
          </span>
        )}
      </div>
    </>
  );
}

/** The first panel still to judge after `from`, wrapping round; else `from`. */
function nextToJudge(panels: BlindPanel[], from: number): number {
  for (let step = 1; step <= panels.length; step++) {
    const i = (from + step) % panels.length;
    if (panels[i]!.judgeable && !isJudged(panels[i]!)) return i;
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
  const [styleMarks, setStyleMarks] = useState<Set<string>>(new Set());
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
      const first = body.panels.findIndex((p) => p.judgeable && !isJudged(p));
      setIndex(first >= 0 ? first : 0);
    });
  }, [load]);

  const panel = data?.panels[index] ?? null;
  const second = (data?.set.judgingEdition ?? 1) >= 2;

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
    setStyleMarks(new Set(panel?.pick?.styleCapturedTokens ?? []));
    setNotice("");
  }, [panel?.panelId, panel?.pick?.judgedAt]);

  const unscored = panel ? panel.images.filter((img) => ratings[img.token] == null).length : 0;
  const complete = !!panel && panel.images.length > 0 && unscored === 0;

  const dirty = useMemo(() => {
    if (!panel) return false;
    const saved = panel.pick;
    if (!saved) return Object.keys(ratings).length > 0;
    return !sameRatings(saved.ratings, ratings) || !sameSet(saved.faceMismatchTokens, faceMarks) || !sameSet(saved.styleCapturedTokens ?? [], styleMarks);
  }, [panel, ratings, faceMarks, styleMarks]);

  const rate = (token: string, score: number) => setRatings((prev) => ({ ...prev, [token]: score }));

  const toggleIn = (set: typeof setFaceMarks) => (token: string) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token); else next.add(token);
      return next;
    });
  };
  const toggleFace = toggleIn(setFaceMarks);
  const toggleStyle = toggleIn(setStyleMarks);

  const save = async (judgement?: unknown) => {
    if (!panel || (!judgement && !complete)) return;
    setSaving(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/panels/${panel.panelId}/pick`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(judgement ?? {
        ratings: panel.images.map((img) => ({ token: img.token, score: ratings[img.token]! })),
        faceMismatchTokens: panel.faceMarkable ? [...faceMarks] : [],
        styleCapturedTokens: panel.styleMarkable ? [...styleMarks] : [],
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
          {" · "}{second
            ? "Score each picture 1 (worst) to 5 (best) on every category shown, pick the one you would send to a friend, and mark any that are broken. "
            : "Score how each picture looks, 1 (worst) to 5 (best); prompt fidelity is tuned after the winner is chosen. "}
          Engines stay hidden until{" "}
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
                      {isJudged(panel) && <span className="ml-2 inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3 h-3" /> judged</span>}
                    </p>
                    <p className="text-sm text-foreground" data-testid="judging-fact">Fact #{panel.factId}: {panel.factText}</p>
                    {second && (
                      <p className="text-sm text-foreground" data-testid="judging-gag">
                        <span className="font-bold">The gag: </span>
                        {panel.gag ?? <span className="text-amber-600 dark:text-amber-400">this fact had no approved gag when the panel was prepared, so judge Gag fidelity against the fact.</span>}
                      </p>
                    )}
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
                        {panel.imagesMissing} {second ? "picture" : "engine"}{panel.imagesMissing === 1 ? "" : "s"} could not {second ? "be drawn for" : "draw"} this panel, so {panel.imagesMissing === 1 ? "its picture is" : "their pictures are"} missing and {panel.imagesMissing === 1 ? "counts" : "count"} as a 1. Score the {panel.images.length} that exist.
                      </p>
                    )}
                    {!second && panel.prompt && (
                      <details className="rounded-sm border border-dashed border-border p-2 text-xs" data-testid="judging-prompt">
                        <summary className="cursor-pointer font-bold text-foreground">Prompt every engine was sent ({panel.prompt.length.toLocaleString()} characters)</summary>
                        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground" data-testid="judging-prompt-text">{panel.prompt}</pre>
                      </details>
                    )}
                    {panel.reference && (
                      <div className="flex items-start gap-3 rounded-sm border border-dashed border-border p-2" data-testid="judging-reference">
                        <img src={panel.reference.src} alt="Source photo given to every engine" className="w-40 h-40 object-contain bg-muted rounded-sm" />
                        <div className="text-xs text-muted-foreground space-y-1">
                          <p className="font-bold text-foreground">Source photo</p>
                          <p>
                            {second
                              ? "Every picture was drawn from this same photo. Judge Likeness against it."
                              : `Every engine was given this same photo for this panel. Compare each picture against it${panel.faceMarkable ? ", and tick \"not the person\" where the face isn't this person" : ""}.`}
                          </p>
                        </div>
                      </div>
                    )}
                    {second && (
                      <JudgementForm key={`${panel.panelId}:${panel.judgement?.judgedAt ?? ""}`} panel={panel} saving={saving} onSave={(body) => void save(body)} />
                    )}
                    {!second && (<>
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
                            {panel.styleMarkable && (
                              <label className="flex items-center gap-1 text-xs text-foreground">
                                <input type="checkbox" checked={styleMarks.has(img.token)} onChange={() => toggleStyle(img.token)} data-testid={`judging-style-${letter(i)}`} />
                                Captured the style
                              </label>
                            )}
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
                    </>)}
                    {second && notice && <span className="text-xs text-foreground" data-testid="judging-notice">{notice}</span>}
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
