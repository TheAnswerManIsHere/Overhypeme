/**
 * Blind judging for the engine comparison — /admin/eval/judge/:setId (launch
 * Phase 8, increment 3; plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
 * *Proposed Design* E).
 *
 * One panel at a time: the same prompt drawn by each candidate engine, in a
 * stable shuffled order, lettered A, B, C… with nothing that names an engine
 * (the server sends opaque tokens and serves each image without its path).
 * David picks the best and, on panels with a person's reference photo, marks
 * any face that is not the person. Saving moves to the next panel still to
 * judge; a saved panel can be judged again, which replaces the pick.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { readError } from "@/components/admin/EngineComparison";

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
  imagesReady: number;
  imagesExpected: number;
  images: BlindImage[];
  pick: { pickedToken: string; faceMismatchTokens: string[]; judgedAt: string } | null;
}
interface BlindSet {
  set: { id: number; label: string; round: number };
  progress: { panels: number; judgeable: number; judged: number };
  panels: BlindPanel[];
}

const letter = (i: number) => String.fromCharCode(65 + i);

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
  const [picked, setPicked] = useState<string | null>(null);
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

  // The panel's saved pick, or a clean slate, whenever the panel changes —
  // before paint, so a click on the newly shown panel is never wiped by a
  // reset that lands after it.
  useLayoutEffect(() => {
    setPicked(panel?.pick?.pickedToken ?? null);
    setFaceMarks(new Set(panel?.pick?.faceMismatchTokens ?? []));
    setNotice("");
  }, [panel?.panelId, panel?.pick?.judgedAt]);

  const dirty = useMemo(() => {
    if (!panel) return false;
    const saved = panel.pick;
    if (!saved) return picked != null;
    const savedMarks = new Set(saved.faceMismatchTokens);
    return saved.pickedToken !== picked || savedMarks.size !== faceMarks.size || [...faceMarks].some((t) => !savedMarks.has(t));
  }, [panel, picked, faceMarks]);

  const toggleFace = (token: string) => {
    setFaceMarks((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token); else next.add(token);
      return next;
    });
  };

  const save = async () => {
    if (!panel || !picked) return;
    setSaving(true);
    setError("");
    const r = await fetch(`/api/admin/comparison/panels/${panel.panelId}/pick`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickedToken: picked, faceMismatchTokens: panel.faceMarkable ? [...faceMarks] : [] }),
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
          {" · "}Judge how each picture looks; prompt fidelity is tuned after the pick. Engines stay hidden until{" "}
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

                {!panel.judgeable ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="judging-not-ready">
                    {panel.imagesReady} of {panel.imagesExpected} images are ready. A panel is judged only when every engine's image is in.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="judging-images">
                      {panel.images.map((img, i) => {
                        const isPicked = picked === img.token;
                        const marked = faceMarks.has(img.token);
                        return (
                          <div key={img.token} className={`rounded-sm border-2 p-1 space-y-1 ${isPicked ? "border-primary" : "border-transparent"}`}>
                            <button
                              type="button"
                              onClick={() => setPicked(img.token)}
                              aria-pressed={isPicked}
                              aria-label={`Pick image ${letter(i)}`}
                              data-testid={`judging-pick-${letter(i)}`}
                              className="block w-full aspect-square bg-muted rounded-sm overflow-hidden"
                            >
                              <img src={img.src} alt={`Image ${letter(i)}`} className="w-full h-full object-contain" />
                            </button>
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-foreground">{letter(i)}{isPicked ? " — best" : ""}</span>
                              {panel.faceMarkable && (
                                <label className="inline-flex items-center gap-1 text-muted-foreground">
                                  <input type="checkbox" checked={marked} onChange={() => toggleFace(img.token)} data-testid={`judging-face-${letter(i)}`} />
                                  not the person
                                </label>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void save()}
                        disabled={!picked || saving || !dirty}
                        data-testid="judging-save"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40"
                      >
                        {saving && <Loader2 className="w-4 h-4 animate-spin" />} {panel.pick ? "Save new pick" : "Save pick"}
                      </button>
                      {!picked && <span className="text-xs text-muted-foreground">Click the best image to pick it.</span>}
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
