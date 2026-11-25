/**
 * @purpose The admin Gags panel: every gag of one fact, each with its state in words, its male, female and pet examples, its editor and its actions; on the Test Renders step, only each gag's three render windows. Used by the moderation review (Gags and Test Renders steps) and, read-only, by the Facts editor.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md, PLAN_GAG_EXAMPLES.md and
 * PLAN_FACT_LIFECYCLE_REBUILD.md (1F). Every change here is to the fact's
 * draft set, and nothing reaches users until the whole draft is published
 * (for a submission, by "Approve for production"), which needs every gag to
 * have an approved male, female and pet render. The Test Renders step shows
 * each gag as its three render windows and nothing else from the gag setup
 * (plan item 11): every render is drawn when the admin asks for it, and none
 * starts by itself (Issue #1282, plan PLAN_RENDERS_MANUAL.md). The Facts editor
 * shows a live fact's gags read-only.
 *
 * The two views each earn their place (plan PLAN_RENDER_HISTORY.md, Issue
 * #1304): the Gags view shows only each picture's official renders, labelled
 * (D2); the Renders view shows each picture's official renders locked beside
 * its working render, and each gag's render history below (D3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, Plus, Play, RefreshCw, Save, Trash2, Users } from "lucide-react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  GAG_EXAMPLE_KINDS,
  KIND_LABEL,
  REST_KINDS,
  joinWithAnd,
  type FactGagsView,
  type GagExample,
  type GagExampleKind,
  type GagPictureRoles,
  type GagView,
  type PerKind,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
  type FactCharacter,
} from "@workspace/api-zod";
import { FactCharactersContext } from "@/components/admin/FactCharactersContext";
import { VisualConceptCard } from "@/components/admin/VisualConceptCard";
import { BubbleEditor } from "@/components/admin/BubbleEditor";
import { castIsCurrent, gagApi, prepareGag, readCast, tokenizeGag, type GagResult } from "./gagApi";
import { GagHistory, IN_FLIGHT, RemovedGagsHistory, roleWords } from "./RenderHistory";

const POLL_MS = 2000;

export function exampleWords(set: PerKind<GagExample | null>, verb = "approved"): string {
  const have = GAG_EXAMPLE_KINDS.filter((k) => set[k] != null);
  const missing = GAG_EXAMPLE_KINDS.filter((k) => set[k] == null);
  const list = (ks: GagExampleKind[]) => joinWithAnd(ks.map((k, i) => (i === 0 ? KIND_LABEL[k] : KIND_LABEL[k].toLowerCase())));
  if (missing.length === 0) return `Male, female and pet ${verb}`;
  if (have.length === 0) return `No examples ${verb} yet: male, female and pet to approve`;
  const rest = list(missing);
  return `${list(have)} ${verb}; ${rest.charAt(0).toLowerCase()}${rest.slice(1)} to approve`;
}

export interface GagsPanelProps {
  factId: number;
  /** The review the panel sits in; null on the Facts editor. */
  reviewId: number | null;
  /**
   * The Test Renders step (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 11): each
   * gag as its male, female and pet render windows, with "Approve this
   * render", and nothing else from the gag setup — no editor, no adding or
   * removing a gag (that is the Gags step's, through "Back to gags").
   */
  rendersEnabled: boolean;
  /** Names the tokenizer should recognise as the subject. */
  subjectNames: string[];
  /** The fact's effective character list — the speaker choices in every bubble editor here. */
  characters?: readonly FactCharacter[];
  /** Bump to reload the view (an action elsewhere changed the gags). */
  reloadKey?: number;
  /** Called with every view the panel loads. */
  onView?: (view: FactGagsView) => void;
  /**
   * Called when the panel starts or stops holding work that is not saved: an
   * edited gag, a save still in flight, or a new gag with text typed in, with
   * the gags it concerns named ("Gag 2", "the new gag"). An approval that acts
   * on the saved gags waits on it (Codex, PR #956 round 2), and its warning
   * names the gag (plan PLAN_GAG_EXAMPLES.md).
   */
  onUnsavedChange?: (gags: string[]) => void;
  disabled?: boolean;
  /**
   * The Gags step (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 9): with no gag
   * yet, Visual gag 1 is shown at once, empty, and the first gag idea fills it
   * when it lands (lib/gags/prefill.ts) unless the moderator saved one first.
   * Text typed into it before then stays, as an edit over the filled gag.
   */
  startWithGag1?: boolean;
  /**
   * Gag ideas are being written: the gags may be filled when they land, so
   * the panel reloads meanwhile and once more when they finish.
   */
  awaitingIdeas?: boolean;
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function GagsPanel(props: GagsPanelProps) {
  return (
    <FactCharactersContext.Provider value={props.characters ?? NO_CHARACTERS}>
      <GagsPanelBody {...props} />
    </FactCharactersContext.Provider>
  );
}

const NO_CHARACTERS: readonly FactCharacter[] = [];

function GagsPanelBody({ factId, reviewId, rendersEnabled, subjectNames, reloadKey = 0, onView, onUnsavedChange, disabled = false, startWithGag1 = false, awaitingIdeas = false }: GagsPanelProps) {
  const [view, setView] = useState<FactGagsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A new gag's draft kept from before a reload opens the new-gag card again.
  const [adding, setAdding] = useState(() => hasStoredNewGagDraft(factId));
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  // Which cards hold unsaved work; the panel reports whether any does.
  const [unsavedKeys, setUnsavedKeys] = useState<Set<string>>(() => new Set());
  const reportUnsaved = useCallback((key: string, unsaved: boolean) => {
    setUnsavedKeys((prev) => {
      if (prev.has(key) === unsaved) return prev;
      const next = new Set(prev);
      if (unsaved) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  const onUnsavedRef = useRef(onUnsavedChange);
  onUnsavedRef.current = onUnsavedChange;
  // The unsaved gags by name, in slot order, the new gag last.
  const slotOf = useMemo(() => new Map((view?.gags ?? []).map((g) => [`gag-${g.id}`, g.slot])), [view]);
  const unsavedNames = useMemo(() => [...unsavedKeys]
    .map((k) => (k === "new" ? { order: 99, name: "the new visual gag" } : { order: slotOf.get(k) ?? 98, name: slotOf.has(k) ? `Visual gag ${slotOf.get(k)}` : "a visual gag" }))
    .sort((a, b) => a.order - b.order)
    .map((x) => x.name), [unsavedKeys, slotOf]);
  const unsavedSignature = unsavedNames.join("|");
  useEffect(() => { onUnsavedRef.current?.(unsavedNames); }, [unsavedSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onUnsavedRef.current?.([]); }, []);

  const viewRef = useRef<FactGagsView | null>(null);
  const accept = useCallback((v: FactGagsView) => {
    // Gag 1 arrived from the first idea while text was typed into the empty
    // card: the typing moves onto it as an unsaved edit, before its card
    // mounts and reads its kept edit (plan item 9).
    if (viewRef.current?.gags.length === 0 && v.gags.length > 0) moveNewDraftOnto(factId, v.gags[0]!);
    viewRef.current = v;
    setView(v);
    onViewRef.current?.(v);
  }, [factId]);

  const load = useCallback(async () => {
    const r = await gagApi.load(factId);
    if (r.ok) { accept(r.view); setLoadError(null); } else setLoadError(r.error);
  }, [factId, accept]);

  useEffect(() => { if (factId > 0) void load(); }, [factId, reloadKey, load]);

  // Poll while a test render someone asked for is still drawing, while ideas
  // are being written, and while a fill is under way. Nothing draws by itself
  // (Issue #1282), so there is no render to wait for that nobody asked for.
  const drawing = !!view?.gags.some((g) => GAG_EXAMPLE_KINDS.some((k) => IN_FLIGHT.has(g.roles[k].working?.status ?? "")));
  // Ideas being written may fill the gags when they land; the view says while
  // a fill is under way (`filling`).
  // The view reads the fill's own job, so this ends when the job does,
  // however long a retry takes (async-ui-status.md: no UI deadline).
  const filling = !!view?.filling;
  const poll = drawing || awaitingIdeas || filling;
  // Ideas just finished: one more load, so a fill they started is seen.
  const wasAwaiting = useRef(awaitingIdeas);
  useEffect(() => {
    if (wasAwaiting.current && !awaitingIdeas && factId > 0) void load();
    wasAwaiting.current = awaitingIdeas;
  }, [awaitingIdeas, factId, load]);
  useEffect(() => {
    if (!poll) return;
    const h = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(h);
  }, [poll, load]);

  if (!view) {
    return loadError ? (
      <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="gags-load-error">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {loadError}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Loading gags…</p>
    );
  }

  const readOnly = disabled;
  const canAdd = !readOnly && !rendersEnabled && view.gags.length < view.maxGags;
  // On the Gags step, Visual gag 1 is always there: empty until the first idea fills it.
  const showGag1 = startWithGag1 && view.gags.length === 0 && !readOnly;

  return (
    <div className="space-y-3" data-testid="gags-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">Visual gags</p>
        <p className="text-xs text-muted-foreground">{view.gags.length} of {view.maxGags}</p>
      </div>

      {filling && (
        <p className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1.5" data-testid="gags-filling">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Filling from the gag ideas…
        </p>
      )}
      {!filling && view.fillFailed && (
        <p className="text-xs text-destructive flex items-center gap-1.5" data-testid="gags-fill-failed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Couldn't fill from the gag ideas. Use an idea below, or write the gag yourself.
        </p>
      )}

      {view.gags.length === 0 && !adding && !showGag1 && (
        <p className="text-xs text-muted-foreground" data-testid="gags-empty">No visual gags yet.</p>
      )}

      {rendersEnabled && view.gags.map((g) => (
        <GagRendersCard
          key={g.id}
          factId={factId}
          reviewId={reviewId}
          gag={g}
          readOnly={readOnly}
          factLive={view.isActive}
          onView={accept}
          onReload={() => void load()}
        />
      ))}

      {rendersEnabled && (
        <RemovedGagsHistory factId={factId} reviewId={reviewId} readOnly={readOnly} factLive={view.isActive} />
      )}

      {!rendersEnabled && view.gags.map((g) => (
        <GagCard
          key={g.id}
          factId={factId}
          reviewId={reviewId}
          gag={g}
          subjectNames={subjectNames}
          readOnly={readOnly}
          factLive={view.isActive}
          onView={accept}
          reportUnsaved={reportUnsaved}
        />
      ))}

      {!rendersEnabled && (adding || showGag1) && (
        <NewGagCard
          factId={factId}
          reviewId={reviewId}
          subjectNames={subjectNames}
          title={showGag1 ? "Visual gag 1" : "New visual gag"}
          cancellable={!showGag1}
          onCancel={() => { reportUnsaved("new", false); setAdding(false); }}
          onView={(v) => { reportUnsaved("new", false); accept(v); setAdding(false); }}
          reportUnsaved={reportUnsaved}
        />
      )}

      {canAdd && !adding && !showGag1 && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          data-testid="gag-add"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-dashed border-primary/50 text-primary rounded-sm hover:bg-primary/10"
        >
          <Plus className="w-4 h-4" /> Add a visual gag
        </button>
      )}
    </div>
  );
}

/**
 * The editor shared by an existing gag and a new one (plan
 * PLAN_GAG_DIRECT_RENDER.md, F): the scene, the bubbles, and who is in the
 * scene, read from it. The eleven "More art direction" controls are gone
 * (David, Q1: 1): the scene and its bubbles are everything that shapes the
 * picture.
 */
function GagEditor({
  value,
  onChange,
  disabled,
  fieldErrors,
  cast,
}: {
  value: VisualPromptStrategyOverride;
  onChange: (next: VisualPromptStrategyOverride) => void;
  disabled: boolean;
  fieldErrors: Record<string, string>;
  cast: CastReading;
}) {
  return (
    <div className="space-y-3">
      <VisualConceptCard value={value} disabled={disabled} tokenizeError={fieldErrors["coreSceneOverride"]} onChange={onChange} />
      <CastChips value={value} cast={cast} disabled={disabled} />
      <BubbleEditor
        firstClass
        value={value}
        disabled={disabled}
        fieldErrors={fieldErrors}
        cast={{ entries: value.cast ?? [], read: value.castExtraction != null }}
        onChange={(next) => { onChange(next); cast.onBubblesEdited(next); }}
      />
    </div>
  );
}

/** Reading a draft's cast: its state, and the trigger the bubble editor pulls. */
interface CastReading {
  reading: boolean;
  error: string | null;
  /** Read the cast of this content's scene now (the Retry button). */
  read: (content: VisualPromptStrategyOverride) => void;
  /** A bubble was added or edited: read the cast if the scene changed since it was last read. */
  onBubblesEdited: (content: VisualPromptStrategyOverride) => void;
}

/**
 * The draft's cast, read in the browser's hands and stored nowhere until the
 * save (plan PLAN_GAG_DIRECT_RENDER.md, F): when the moderator adds or edits a
 * bubble after changing the scene, the scene is tokenized and its cast read,
 * so the speaker dropdown offers who the scene now shows. Save reads it again
 * if the scene or a speaker changed since (`prepareGag`).
 */
function useCastReading(
  factId: number,
  subjectNames: string[],
  draft: VisualPromptStrategyOverride,
  setDraft: (update: (prev: VisualPromptStrategyOverride) => VisualPromptStrategyOverride) => void,
): CastReading {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scene the cast was last read (or tried) for. A failed reading records
  // its scene too, so further bubble edits do not retry it: Try again does.
  const readFrom = useRef<string | null>(null);
  const current = castIsCurrent(draft);
  const scene = draft.coreSceneOverride ?? "";
  useEffect(() => {
    if (current) readFrom.current = scene;
  }, [current, scene]);
  const inFlight = useRef(false);

  const read = useCallback((content: VisualPromptStrategyOverride) => {
    const scene = content.coreSceneOverride ?? "";
    if (!scene.trim() || factId <= 0 || inFlight.current) return;
    inFlight.current = true;
    readFrom.current = scene;
    setReading(true);
    setError(null);
    void (async () => {
      try {
        // The scene alone is tokenized here: a bubble mid-edit is left as typed.
        const t = await tokenizeGag(content, { ...content, coreSceneOverride: undefined }, subjectNames);
        if (!t.ok) { setError(t.fieldErrors["coreSceneOverride"] ?? t.error ?? "The scene could not be read."); return; }
        const tokenized = t.content.coreSceneOverride ?? "";
        const r = await readCast(factId, tokenized, content.bubbles);
        if (!r.ok) { setError(`Reading who is in the scene failed: ${r.error}`); return; }
        readFrom.current = tokenized;
        // Applied only while the scene is still the one sent (an edit since
        // wins) and the draft has no current cast of its own: a save adopted
        // meanwhile, or a discard, already carries one, and a late reading
        // written over it would mark the saved card unsaved again.
        setDraft((prev) => (prev.coreSceneOverride ?? "") !== scene || castIsCurrent(prev) ? prev : {
          ...prev,
          coreSceneOverride: tokenized,
          cast: r.view.cast,
          castExtraction: r.view.castExtraction,
        });
      } finally {
        inFlight.current = false;
        setReading(false);
      }
    })();
  }, [factId, subjectNames, setDraft]);

  const onBubblesEdited = useCallback((content: VisualPromptStrategyOverride) => {
    if ((content.coreSceneOverride ?? "") !== readFrom.current) read(content);
  }, [read]);

  return { reading, error, read, onBubblesEdited };
}

/** "In this scene: mom, the bartender" — read-only; the scene is what changes it. */
function CastChips({ value, cast, disabled }: { value: VisualPromptStrategyOverride; cast: CastReading; disabled: boolean }) {
  const read = value.castExtraction != null;
  const current = castIsCurrent(value);
  return (
    <div className="rounded-sm border border-border bg-background px-3 py-2 space-y-1" data-testid="gag-cast">
      <p className="text-xs text-foreground flex items-center gap-1.5 flex-wrap">
        <Users className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-semibold">In this scene:</span>
        {cast.reading ? (
          <span className="text-muted-foreground inline-flex items-center gap-1" data-testid="gag-cast-reading">
            <Loader2 className="w-3 h-3 animate-spin" /> Reading who is in the scene…
          </span>
        ) : !read ? (
          <span className="text-muted-foreground" data-testid="gag-cast-unread">not read yet. It is read when you add a bubble or save.</span>
        ) : (value.cast ?? []).length === 0 ? (
          <span className="text-muted-foreground" data-testid="gag-cast-empty">nobody but the subject.</span>
        ) : (
          (value.cast ?? []).map((c) => (
            <span key={c.label} title={c.description} data-testid="gag-cast-chip"
              className={`px-1.5 py-0.5 rounded-sm border text-[11px] ${current ? "border-primary/40 bg-primary/10 text-foreground" : "border-border bg-muted text-muted-foreground"}`}>
              {c.label}
            </span>
          ))
        )}
      </p>
      {read && !current && !cast.reading && (
        <p className="text-[11px] text-muted-foreground" data-testid="gag-cast-stale">Read from the scene before your edit; it is read again when you add a bubble or save.</p>
      )}
      {cast.error && (
        <p className="text-[11px] text-destructive flex items-center gap-2 flex-wrap" data-testid="gag-cast-error">
          <span>{cast.error}</span>
          <button type="button" disabled={disabled || cast.reading} onClick={() => cast.read(value)} data-testid="gag-cast-retry"
            className="px-2 py-0.5 border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">Try again</button>
        </p>
      )}
    </div>
  );
}

/** Prepare (tokenize and read the cast), then run `persist` with the prepared content; field errors stay on their fields. */
/** Busy and error state around one gag action (a draw, an approval, a removal). */
function useGagAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (fn: () => Promise<GagResult>): Promise<GagResult> => {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(r.error);
      return r;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, setBusy, error, setError, act };
}

function useGagSave(factId: number, subjectNames: string[]) {
  const { busy, setBusy, error, setError, act } = useGagAction();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = useCallback(async (
    content: VisualPromptStrategyOverride,
    baseline: VisualPromptStrategyOverride | null,
    persist: (c: VisualPromptStrategyOverride) => Promise<GagResult>,
    onTokenized: (c: VisualPromptStrategyOverride) => void,
  ): Promise<GagResult | null> => {
    setBusy(true); setError(null);
    try {
      const t = await prepareGag(factId, content, baseline, subjectNames);
      onTokenized(t.content);
      if (!t.ok) { setFieldErrors(t.fieldErrors); setError(t.error); return null; }
      setFieldErrors({});
      const r = await persist(t.content);
      if (!r.ok) setError(r.error);
      return r;
    } finally {
      setBusy(false);
    }
  }, [factId, subjectNames, setBusy, setError]);
  return { busy, error, fieldErrors, run, act, setError };
}

/** The draft's picks for a gag: its draft change's, else its published version's. */
function examplePicks(g: GagView): PerKind<GagExample | null> {
  return g.pendingContent != null ? g.pendingExamples : g.approvedExamples;
}

function stateWords(g: GagView): string {
  if (g.state === "new") return "Not offered to users yet: goes live with the fact, once every gag has its male, female and pet renders approved";
  if (g.draftRemoved) return "Removed in the unpublished changes; still offered to users until they are published";
  if (g.state === "approved_with_change") return "Offered to users as published; this gag has an unpublished change";
  return "Published";
}

/**
 * An unsaved gag edit kept in the browser, so closing the review or stepping
 * back does not lose it (the old Visual Concept editor's safety net; build
 * report, PR #956). Stored with the server version it was typed against: a
 * draft is restored only while that version is unchanged, and cleared once
 * it is saved, undone or overtaken.
 */
const draftKey = (key: string) => `gag-draft::${key}`;

function readStoredDraft(key: string, base: string, anyBase = false): VisualPromptStrategyOverride | null {
  try {
    const raw = window.localStorage.getItem(draftKey(key));
    if (!raw) return null;
    const stored = JSON.parse(raw) as { base?: string; draft?: VisualPromptStrategyOverride };
    if ((stored.base !== base && !anyBase) || !stored.draft) {
      window.localStorage.removeItem(draftKey(key));
      return null;
    }
    return stored.draft;
  } catch {
    return null;
  }
}

function clearStoredDraft(key: string): void {
  try { window.localStorage.removeItem(draftKey(key)); } catch { /* nothing kept */ }
}

function useStoredDraft(key: string, base: string, draft: VisualPromptStrategyOverride, unsaved: boolean): void {
  useEffect(() => {
    try {
      if (unsaved) window.localStorage.setItem(draftKey(key), JSON.stringify({ base, draft }));
      else window.localStorage.removeItem(draftKey(key));
    } catch {
      // Storage full or blocked: the edit simply isn't kept across a reload.
    }
  }, [key, base, draft, unsaved]);
}

function GagCard({
  factId,
  reviewId,
  gag,
  subjectNames,
  readOnly,
  factLive,
  onView,
  reportUnsaved,
}: {
  factId: number;
  reviewId: number | null;
  gag: GagView;
  subjectNames: string[];
  readOnly: boolean;
  factLive: boolean;
  onView: (v: FactGagsView) => void;
  reportUnsaved: (key: string, unsaved: boolean) => void;
}) {
  const working = gag.pendingContent ?? gag.approvedContent ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const workingKey = JSON.stringify(working);
  const storeKey = `${factId}:${gag.id}`;
  // An edit kept from before a reload or a closed review comes back, if the
  // gag is still as it was when the edit was typed.
  // A kept edit comes back over a version a fill from the gag ideas wrote
  // since, whatever version it was typed against: the moderator did not make
  // that change (Codex 4649903945, PR #1136).
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(() => readStoredDraft(storeKey, workingKey, gag.prefilledUntouched) ?? working);
  // A new server version replaces the draft (a save, an undo, an idea used on
  // this gag); a fill from the gag ideas leaves unsaved typing over it.
  const seenKey = useRef(workingKey);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (seenKey.current === workingKey) return;
    const before = JSON.parse(seenKey.current) as VisualPromptStrategyOverride;
    seenKey.current = workingKey;
    if (gag.prefilledUntouched && !sameContent(draftRef.current, before)) return;
    setDraft(JSON.parse(workingKey) as VisualPromptStrategyOverride);
  }, [workingKey, gag.prefilledUntouched]);
  const dirty = !sameContent(draft, working);
  // Kept while the edit is unsaved, locked or not: a lock (a refresh, a step
  // change in flight) is not a save (Codex, PR #958 round 2).
  useStoredDraft(storeKey, workingKey, draft, dirty);
  const s = useGagSave(factId, subjectNames);
  const castReading = useCastReading(factId, subjectNames, draft, setDraft);
  const unsavedKey = `gag-${gag.id}`;
  useEffect(() => { reportUnsaved(unsavedKey, dirty || s.busy); }, [reportUnsaved, unsavedKey, dirty, s.busy]);
  useEffect(() => () => reportUnsaved(unsavedKey, false), [reportUnsaved, unsavedKey]);
  const done = (r: GagResult | null) => { if (r?.ok) onView(r.view); };

  const save = async () => done(await s.run(draft, working, (c) => gagApi.save(factId, gag.id, c, reviewId), setDraft));
  const remove = async () => {
    if (!window.confirm(`Remove visual gag ${gag.slot}?`)) return;
    done(await s.act(() => gagApi.remove(factId, gag.id, reviewId)));
  };

  const locked = readOnly || s.busy;
  const picks = examplePicks(gag);

  return (
    <div className="rounded-sm border-2 border-border bg-card p-4 space-y-3" data-testid="gag-card" data-gag-slot={gag.slot}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-1">
          <p className="text-sm font-bold text-foreground flex items-center gap-2 flex-wrap">
            Visual gag {gag.slot}
            {gag.isDefault && (
              <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-primary/15 text-primary" data-testid="gag-default">Default</span>
            )}
            <span
              className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm ${gag.availableToUsers ? "bg-green-600/15 text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground"}`}
              data-testid="gag-availability"
            >
              {gag.availableToUsers ? "Offered to users" : "Hidden from users"}
            </span>
          </p>
          <p className="text-xs text-muted-foreground" data-testid="gag-state">{stateWords(gag)}</p>
        </div>
      </div>

      {gag.grandfathered && (
        <p className="text-xs text-muted-foreground" data-testid="gag-grandfathered">
          Approved before gags had male, female and pet examples. It stays offered to users; approving its three examples completes it.
        </p>
      )}
      <p className="text-xs text-foreground" data-testid="gag-example-words">
        {`${exampleWords(picks)}.`}
      </p>

      <OfficialExamples gag={gag} factLive={factLive} />

      <GagEditor value={draft} onChange={setDraft} disabled={locked} fieldErrors={s.fieldErrors} cast={castReading} />

      {s.error && (
        <p className="text-xs text-destructive flex items-start gap-1.5 break-words" data-testid="gag-error"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="min-w-0">{s.error}</span></p>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void save()} disabled={locked || !dirty || !draft.coreSceneOverride?.trim()} data-testid="gag-save"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-primary/50 text-primary rounded-sm hover:bg-primary/10 disabled:opacity-40">
            {s.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save change
          </button>
          {dirty && (
            <button type="button" onClick={() => setDraft(working)} disabled={locked} data-testid="gag-undo"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
              Undo edits
            </button>
          )}
          <button type="button" onClick={() => void remove()} disabled={locked} data-testid="gag-remove"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-destructive/50 text-destructive rounded-sm hover:bg-destructive/10 disabled:opacity-40">
            <Trash2 className="w-3.5 h-3.5" /> Remove gag
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Each picture's official renders on the Gags view (plan PLAN_RENDER_HISTORY.md
 * D2): its live example and, when different, the pick approved for the next
 * publish, each under its label; a picture with neither says so. Nothing else
 * of a gag's renders shows here: drafts, working renders and history are the
 * Renders view's.
 */
function OfficialExamples({ gag, factLive }: { gag: GagView; factLive: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="gag-approved-examples">
      {GAG_EXAMPLE_KINDS.map((k) => {
        const r = gag.roles[k];
        const official = officialOf(r);
        return (
          <div key={k} className="space-y-1" data-testid="gag-official" data-kind={k}>
            <p className="text-xs font-semibold text-foreground">{KIND_LABEL[k]}</p>
            {official.length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="gag-no-official">No approved example yet.</p>
            ) : official.map(({ role, example }) => (
              <figure key={role} className="space-y-1">
                {example.imageUrl ? (
                  <a href={example.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full size">
                    <img src={example.imageUrl} alt={`Visual gag ${gag.slot} ${k}: ${roleWords(role, factLive).toLowerCase()}`} className="w-28 rounded-sm border border-border" data-testid="gag-example" data-kind={k} data-role={role} />
                  </a>
                ) : <p className="text-[11px] text-muted-foreground">The picture is not available.</p>}
                <figcaption className="text-[11px] text-muted-foreground" data-testid="gag-example-label">{roleWords(role, factLive)}</figcaption>
              </figure>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A picture's official renders (D1): the live example, then the draft's pick when it differs. */
function officialOf(r: GagPictureRoles): Array<{ role: "live" | "approved_next"; example: GagExample }> {
  const out: Array<{ role: "live" | "approved_next"; example: GagExample }> = [];
  if (r.live) out.push({ role: "live", example: r.live });
  if (r.approvedNext) out.push({ role: "approved_next", example: r.approvedNext });
  return out;
}

/**
 * What changes when a gag's renders change (a draw starting or settling, an
 * approval): an open history reloads on it. Queued and drawing read as one,
 * so a draw reloads it twice, not three times.
 */
function gagRendersKey(g: GagView): string {
  return GAG_EXAMPLE_KINDS.map((k) => {
    const r = g.roles[k];
    const status = r.working ? (IN_FLIGHT.has(r.working.status) ? "drawing" : r.working.status) : "-";
    return `${r.working?.latestAttemptId ?? "-"}:${status}:${r.live?.attemptId ?? "-"}:${r.approvedNext?.attemptId ?? "-"}`;
  }).join("|");
}

/**
 * A gag on the Renders view (the Test Renders step and the fact sheet's
 * Renders tab; plan PLAN_FACT_LIFECYCLE_REBUILD.md item 11 and
 * PLAN_RENDER_HISTORY.md D3): per picture, its official renders, locked, beside
 * its working render with Approve and Draw; below, the gag's history. Every
 * render is drawn when asked (Issue #1282), and every draw asked for here makes
 * a new render (D1): "Draw again" keeps the previous one in history.
 */
function GagRendersCard({
  factId,
  reviewId,
  gag,
  readOnly,
  factLive,
  onView,
  onReload,
}: {
  factId: number;
  reviewId: number | null;
  gag: GagView;
  readOnly: boolean;
  factLive: boolean;
  onView: (v: FactGagsView) => void;
  onReload: () => void;
}) {
  const s = useGagAction();
  const done = (r: GagResult | null) => { if (r?.ok) onView(r.view); };
  const runRenders = async (kinds: GagExampleKind[]) => done(await s.act(() => gagApi.runRenders(factId, gag.id, reviewId, kinds)));
  const approve = async (card: RenderScenarioCard) => {
    if (card.latestAttemptId == null) return;
    done(await s.act(() => gagApi.approve(factId, gag.id, card.latestAttemptId!, reviewId)));
  };
  const locked = readOnly || s.busy;
  const drawing = GAG_EXAMPLE_KINDS.some((k) => IN_FLIGHT.has(gag.roles[k].working?.status ?? ""));
  const picks = examplePicks(gag);
  // A picture needs drawing with no render of the gag as it is: none at all,
  // or only one drawn from an earlier version (Issue #1277).
  const needsDrawing = (k: GagExampleKind) => {
    const w = gag.roles[k].working;
    return w == null || w.status === "missing" || w.stale;
  };
  const restMissing = REST_KINDS.filter(needsDrawing);

  return (
    <div className="rounded-sm border-2 border-border bg-card p-4 space-y-2" data-testid="gag-card" data-gag-slot={gag.slot}>
      <div className="flex items-center justify-between gap-2 flex-wrap" data-testid="gag-renders">
        <p className="text-sm font-bold text-foreground">Visual gag {gag.slot}</p>
        {!readOnly && restMissing.length > 0 && (
          <button type="button" onClick={() => void runRenders(restMissing)} disabled={locked || drawing} data-testid="gag-render-rest"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
            <Play className="w-3 h-3" /> Render {joinWithAnd(restMissing)}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {GAG_EXAMPLE_KINDS.map((k) => (
          <PictureColumn
            key={k}
            kind={k}
            roles={gag.roles[k]}
            pickId={picks[k]?.attemptId ?? null}
            factLive={factLive}
            canAct={!locked}
            readOnly={readOnly}
            onApprove={(c) => void approve(c)}
            onDraw={() => void runRenders([k])}
          />
        ))}
      </div>
      {s.error && (
        <p className="text-xs text-destructive flex items-start gap-1.5 break-words" data-testid="gag-error"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="min-w-0">{s.error}</span></p>
      )}
      <GagHistory factId={factId} gagId={gag.id} reviewId={reviewId} readOnly={readOnly} factLive={factLive}
        refreshKey={gagRendersKey(gag)} onDeleted={onReload} />
    </div>
  );
}

/**
 * A tile's state in words, when it has no image to show. An in-flight render
 * reads its progress (plan PLAN_JOB_RESUME.md §D): "Drawing…" only while the
 * image service reports the picture in progress.
 */
function statusWords(status: string, message: string | null, progress?: string | null, engineRefused = false): string {
  // The engine's content refusal is final: it is never retried, so the tile
  // says so with the engine's reason (plan PLAN_GAG_DIRECT_RENDER.md, B).
  if (status === "failed" && engineRefused) {
    return `The engine refused this picture: ${message ?? "no reason was given"}. Change the scene, then draw it again.`;
  }
  switch (progress) {
    case "queued": return "Queued…";
    case "drawing": return "Drawing…";
    case "resuming": return "Picking back up…";
    case "saving": return "Saving…";
    case "retrying": return "Retrying shortly…";
  }
  switch (status) {
    case "missing": return "Not drawn yet.";
    case "queued": return "Queued…";
    case "rendering": return "Drawing…";
    case "failed": return `Failed: ${message ?? "the render did not finish"}. Draw it again.`;
    case "blocked": return `Blocked: ${message ?? "the render was refused"}.`;
    case "done": return "Drawn, but the image is not available.";
    default: return message ?? status;
  }
}

/**
 * One picture on the Renders view (D3): its official renders, locked, then its
 * working render. A render holding several roles is shown once, under its
 * working render, with each role named (D1).
 */
function PictureColumn({ kind, roles, pickId, factLive, canAct, readOnly, onApprove, onDraw }: {
  kind: GagExampleKind;
  roles: GagPictureRoles;
  /** The draft's pick for this picture: approving the working render makes it this. */
  pickId: number | null;
  factLive: boolean;
  canAct: boolean;
  readOnly: boolean;
  onApprove: (card: RenderScenarioCard) => void;
  onDraw: () => void;
}) {
  const card = roles.working;
  const workingId = card?.latestAttemptId ?? null;
  const official = officialOf(roles);
  const workingOfficial = official.filter((o) => o.example.attemptId === workingId);
  const separate = official.filter((o) => o.example.attemptId !== workingId);
  const status = card?.status ?? "missing";
  const inFlight = IN_FLIGHT.has(status);
  const picked = pickId != null && pickId === workingId;
  const approvable = !!card && status === "done" && workingId != null && !!card.imageUrl && !picked;
  // The official roles the working render holds, named once; a pick with no role of its own reads "Approved".
  const officialLabel = workingOfficial.map((o) => roleWords(o.role, factLive)).join(" · ") || (picked ? "Approved" : "");
  return (
    <div className="rounded-sm border border-border bg-background p-2 space-y-2" data-testid="gag-render" data-kind={kind}>
      <p className="text-xs font-semibold text-foreground">{KIND_LABEL[kind]}</p>
      {separate.map(({ role, example }) => (
        <div key={role} className="rounded-sm border border-green-600/30 bg-green-600/5 p-1.5 space-y-1" data-testid="gag-render-official" data-role={role}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-green-700 dark:text-green-400 flex items-center gap-1">
            <Lock className="w-3 h-3" /> {roleWords(role, factLive)}
          </p>
          {example.imageUrl ? (
            <a href={example.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full size">
              <img src={example.imageUrl} alt={`${KIND_LABEL[kind]}: ${roleWords(role, factLive).toLowerCase()}`} className="w-full rounded-sm border border-border" />
            </a>
          ) : <p className="text-[11px] text-muted-foreground">The picture is not available.</p>}
          {role === "live" && <p className="text-[10px] text-muted-foreground" data-testid="gag-render-members-see">Members see this until you publish</p>}
          <p className="text-[10px] text-muted-foreground">Locked. Approving a newer render replaces it.</p>
        </div>
      ))}
      <div className="space-y-1.5" data-testid="gag-render-working">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex items-center justify-between gap-1 flex-wrap">
          Working render
          {officialLabel && (
            <span className="px-1.5 py-0.5 rounded-sm bg-green-600/15 text-green-700 dark:text-green-400" data-testid={picked ? "gag-render-picked" : "gag-render-official-role"}>
              {officialLabel}
            </span>
          )}
        </p>
        {card?.imageUrl ? (
          <>
            <a href={card.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full size" data-testid="gag-render-open">
              <img src={card.imageUrl} alt={`${KIND_LABEL[kind]} working render`} className="w-full rounded-sm border border-border" />
            </a>
            {card.stale && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="gag-render-stale">
                Drawn from an earlier version of this gag. Draw it again to see the gag as it is now.
              </p>
            )}
            {card.engineFallback && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="gag-render-fallback">
                GPT Image refused this picture; Nano Banana drew it.
              </p>
            )}
          </>
        ) : (
          <p className={`text-[11px] flex items-center gap-1 ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`} data-testid="gag-render-status" data-refused={card?.engineRefused ? "true" : undefined}>
            {inFlight && <Loader2 className="w-3 h-3 animate-spin" />}
            {statusWords(status, card?.message ?? null, card?.progress ?? null, card?.engineRefused ?? false)}
          </p>
        )}
        {approvable && (
          <button type="button" onClick={() => onApprove(card!)} disabled={!canAct} data-testid="gag-approve-render"
            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-bold border border-green-600/50 text-green-700 dark:text-green-400 rounded-sm hover:bg-green-600/10 disabled:opacity-40">
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve this render
          </button>
        )}
        {!readOnly && !inFlight && (
          <button type="button" onClick={onDraw} disabled={!canAct} data-testid="gag-redraw-render"
            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px] border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
            {card != null && status !== "missing" ? <><RefreshCw className="w-3 h-3" /> Draw again</> : <><Play className="w-3 h-3" /> Draw this render</>}
          </button>
        )}
      </div>
    </div>
  );
}

/** A new gag's draft has no server version to be typed against. */
const NEW_BASE = "new";

/** Whether a new gag's draft is kept from before, so the panel opens it again. */
export function hasStoredNewGagDraft(factId: number): boolean {
  return readStoredDraft(`${factId}:new`, NEW_BASE) != null;
}

/**
 * Move the empty card's kept typing onto the gag the first idea filled: kept
 * against that gag's current version, so its card opens with the typing as
 * an unsaved edit over it (plan item 9).
 */
function moveNewDraftOnto(factId: number, gag: GagView): void {
  const typed = readStoredDraft(`${factId}:new`, NEW_BASE);
  if (!typed) return;
  const working = gag.pendingContent ?? gag.approvedContent ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  try {
    window.localStorage.setItem(draftKey(`${factId}:${gag.id}`), JSON.stringify({ base: JSON.stringify(working), draft: typed }));
  } catch { /* not kept: the filled gag shows as it is */ }
  clearStoredDraft(`${factId}:new`);
}

function NewGagCard({
  factId,
  reviewId,
  subjectNames,
  title,
  cancellable,
  onCancel,
  onView,
  reportUnsaved,
}: {
  factId: number;
  reviewId: number | null;
  subjectNames: string[];
  title: string;
  cancellable: boolean;
  onCancel: () => void;
  onView: (v: FactGagsView) => void;
  reportUnsaved: (key: string, unsaved: boolean) => void;
}) {
  const storeKey = `${factId}:new`;
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(() => readStoredDraft(storeKey, NEW_BASE) ?? EMPTY_VISUAL_STRATEGY_OVERRIDE);
  const s = useGagSave(factId, subjectNames);
  const castReading = useCastReading(factId, subjectNames, draft, setDraft);
  const save = async () => {
    const r = await s.run(draft, null, (c) => gagApi.create(factId, c, reviewId), setDraft);
    // Cleared here, before the parent closes this card: an effect would not
    // run once the card is gone (Codex, PR #958 round 1). A failed save keeps it.
    if (r?.ok) { clearStoredDraft(storeKey); onView(r.view); }
  };
  const hasScene = useMemo(() => !!draft.coreSceneOverride?.trim(), [draft]);
  const typed = !sameContent(draft, EMPTY_VISUAL_STRATEGY_OVERRIDE);
  useStoredDraft(storeKey, NEW_BASE, draft, typed);
  useEffect(() => { reportUnsaved("new", typed || s.busy); }, [reportUnsaved, typed, s.busy]);
  useEffect(() => () => reportUnsaved("new", false), [reportUnsaved]);
  return (
    <div className="rounded-sm border-2 border-dashed border-primary/40 bg-card p-4 space-y-3" data-testid="gag-new">
      <p className="text-sm font-bold text-foreground">{title}</p>
      <GagEditor value={draft} onChange={setDraft} disabled={s.busy} fieldErrors={s.fieldErrors} cast={castReading} />
      {s.error && <p className="text-xs text-destructive flex items-start gap-1.5 break-words" data-testid="gag-error"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="min-w-0">{s.error}</span></p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={s.busy || !hasScene} data-testid="gag-new-save"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-primary/50 text-primary rounded-sm hover:bg-primary/10 disabled:opacity-40">
          {s.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save gag
        </button>
        {cancellable && (
          <button type="button" onClick={() => { clearStoredDraft(storeKey); onCancel(); }} disabled={s.busy}
            className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">Cancel</button>
        )}
      </div>
    </div>
  );
}
