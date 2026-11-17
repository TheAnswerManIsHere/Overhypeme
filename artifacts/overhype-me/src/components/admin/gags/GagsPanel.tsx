/**
 * @purpose The admin Gags panel: every gag of one fact, each with its state in words, its male, female and pet examples, its editor, its test renders and its actions. Used by the moderation review (Gags and Test Renders steps) and the Facts editor.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md and PLAN_GAG_EXAMPLES.md. Every gag
 * follows the same rules: a saved change waits as the gag's pending version,
 * and it reaches users only once a male, a female and a pet render of it are
 * approved as its examples. Saving draws one male render to iterate on; "Render
 * female and pet" draws the other two once the gag works. Inside a refresh, the
 * panel is scoped to that refresh's review and its picks apply at promotion;
 * outside one, a fact with an open refresh is read-only here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Play, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  GAG_EXAMPLE_KINDS,
  KIND_LABEL,
  REST_KINDS,
  joinWithAnd,
  type FactGagsView,
  type GagExample,
  type GagExampleKind,
  type GagView,
  type PerKind,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
  type FactCharacter,
} from "@workspace/api-zod";
import { FactCharactersContext } from "@/components/admin/FactCharactersContext";
import { VisualConceptCard } from "@/components/admin/VisualConceptCard";
import { BubbleEditor } from "@/components/admin/BubbleEditor";
import { VisualStrategyOverridePanel } from "@/components/admin/EnrichmentEditor";
import { gagApi, tokenizeGag, type GagResult } from "./gagApi";

const IN_FLIGHT = new Set(["queued", "rendering"]);
const POLL_MS = 2000;
/**
 * How long after an action (or opening at Test Renders) the panel keeps
 * reloading while a gag has no male render yet: the iteration render a save
 * asks for is created by a background job a few seconds later (Codex, PR #956
 * round 1).
 */
const PREPARE_WINDOW_MS = 60_000;

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
  /** Test renders and "Approve this render" (the Test Renders step and the Facts editor). */
  rendersEnabled: boolean;
  /**
   * The server queues iteration renders without being asked here (a review
   * arriving at Test Renders): keep reloading for a short window after opening
   * while a gag has no male render yet. Every save in the panel opens the same
   * window on its own.
   */
  rendersExpected?: boolean;
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

function GagsPanelBody({ factId, reviewId, rendersEnabled, rendersExpected = false, subjectNames, reloadKey = 0, onView, onUnsavedChange, disabled = false }: GagsPanelProps) {
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
    .map((k) => (k === "new" ? { order: 99, name: "the new gag" } : { order: slotOf.get(k) ?? 98, name: slotOf.has(k) ? `Gag ${slotOf.get(k)}` : "a gag" }))
    .sort((a, b) => a.order - b.order)
    .map((x) => x.name), [unsavedKeys, slotOf]);
  const unsavedSignature = unsavedNames.join("|");
  useEffect(() => { onUnsavedRef.current?.(unsavedNames); }, [unsavedSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onUnsavedRef.current?.([]); }, []);

  const accept = useCallback((v: FactGagsView) => {
    setView(v);
    onViewRef.current?.(v);
  }, []);
  /** A view an action answered with: its iteration render may still be on its way. */
  const acceptAction = useCallback((v: FactGagsView) => {
    accept(v);
    setWindowKick((n) => n + 1);
  }, [accept]);

  const load = useCallback(async () => {
    const r = await gagApi.load(factId);
    if (r.ok) { accept(r.view); setLoadError(null); } else setLoadError(r.error);
  }, [factId, accept]);

  useEffect(() => { if (factId > 0) void load(); }, [factId, reloadKey, load]);

  // Poll while any test render is still drawing, and through a short window
  // after opening at Test Renders or after any action here while a gag has no
  // male render yet (its iteration render is queued by a background job).
  const [windowKick, setWindowKick] = useState(0);
  // A reload asked for from outside (an idea used on a gag elsewhere on the
  // page) may have queued an iteration render too, so it opens the window as an
  // action here does; the first load does not (Codex, PR #972 round 1).
  const firstReloadKey = useRef(reloadKey);
  const reloadedFromOutside = reloadKey !== firstReloadKey.current;
  const [prepareWindowOpen, setPrepareWindowOpen] = useState(rendersExpected);
  useEffect(() => {
    if (!rendersExpected && windowKick === 0 && !reloadedFromOutside) { setPrepareWindowOpen(false); return; }
    setPrepareWindowOpen(true);
    const t = setTimeout(() => setPrepareWindowOpen(false), PREPARE_WINDOW_MS);
    return () => clearTimeout(t);
  }, [rendersExpected, factId, reloadKey, windowKick, reloadedFromOutside]);
  const drawing = !!view?.gags.some((g) => GAG_EXAMPLE_KINDS.some((k) => IN_FLIGHT.has(g.renders[k]?.status ?? "")));
  const awaitingMale = !!view?.gags.some((g) => g.renders.male == null || g.renders.male.status === "missing");
  const poll = drawing || (prepareWindowOpen && awaitingMale);
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

  const readOnly = disabled || (view.frozenOutsideReview && reviewId == null);
  const canAdd = !readOnly && view.gags.length < view.maxGags;

  return (
    <div className="space-y-3" data-testid="gags-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">Gags</p>
        <p className="text-xs text-muted-foreground">
          {view.gags.length} of {view.maxGags}. A gag reaches users once its male, female and pet renders are approved as its examples.
        </p>
      </div>

      {view.frozenOutsideReview && reviewId == null && (
        <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-testid="gags-frozen-note">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          This fact is being refreshed. Its gags can only be changed inside that refresh's review, as its last step.
        </p>
      )}

      {view.gags.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground" data-testid="gags-empty">No gags yet. Add one, or use one of the visual ideas.</p>
      )}

      {view.gags.map((g) => (
        <GagCard
          key={g.id}
          factId={factId}
          reviewId={reviewId}
          gag={g}
          rendersEnabled={rendersEnabled}
          subjectNames={subjectNames}
          readOnly={readOnly}
          onView={acceptAction}
          reportUnsaved={reportUnsaved}
        />
      ))}

      {adding && (
        <NewGagCard
          factId={factId}
          reviewId={reviewId}
          subjectNames={subjectNames}
          onCancel={() => { reportUnsaved("new", false); setAdding(false); }}
          onView={(v) => { reportUnsaved("new", false); acceptAction(v); setAdding(false); }}
          reportUnsaved={reportUnsaved}
        />
      )}

      {canAdd && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          data-testid="gag-add"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-dashed border-primary/50 text-primary rounded-sm hover:bg-primary/10"
        >
          <Plus className="w-4 h-4" /> Add a gag
        </button>
      )}
    </div>
  );
}

/** The editor shared by an existing gag and a new one: the scene, the bubbles, and the rest of the art direction. */
function GagEditor({
  value,
  onChange,
  disabled,
  fieldErrors,
}: {
  value: VisualPromptStrategyOverride;
  onChange: (next: VisualPromptStrategyOverride) => void;
  disabled: boolean;
  fieldErrors: Record<string, string>;
}) {
  return (
    <div className="space-y-3">
      <VisualConceptCard value={value} disabled={disabled} tokenizeError={fieldErrors["coreSceneOverride"]} onChange={onChange} />
      <BubbleEditor firstClass value={value} disabled={disabled} fieldErrors={fieldErrors} onChange={onChange} />
      <details className="rounded-sm border border-border bg-background px-3 py-2">
        <summary className="text-xs font-semibold text-muted-foreground cursor-pointer">More art direction</summary>
        <div className="pt-3">
          <VisualStrategyOverridePanel
            value={value}
            disabled={disabled}
            fieldErrors={fieldErrors}
            onChange={(next) => onChange(next ?? EMPTY_VISUAL_STRATEGY_OVERRIDE)}
          />
        </div>
      </details>
    </div>
  );
}

/** Tokenize, then run `persist` with the tokenized content; field errors stay on their fields. */
function useGagSave(subjectNames: string[]) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = useCallback(async (
    content: VisualPromptStrategyOverride,
    baseline: VisualPromptStrategyOverride | null,
    persist: (c: VisualPromptStrategyOverride) => Promise<GagResult>,
    onTokenized: (c: VisualPromptStrategyOverride) => void,
  ): Promise<GagResult | null> => {
    setBusy(true); setError(null);
    try {
      const t = await tokenizeGag(content, baseline, subjectNames);
      onTokenized(t.content);
      if (!t.ok) { setFieldErrors(t.fieldErrors); setError(t.error); return null; }
      setFieldErrors({});
      const r = await persist(t.content);
      if (!r.ok) setError(r.error);
      return r;
    } finally {
      setBusy(false);
    }
  }, [subjectNames]);
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
  return { busy, error, fieldErrors, run, act, setError };
}

function stateWords(g: GagView): string {
  if (g.state === "new") return "New: hidden from users until its male, female and pet examples are approved";
  if (g.state === "approved_with_change") return "Approved, with a change waiting for its male, female and pet examples";
  return "Approved";
}

/**
 * An unsaved gag edit kept in the browser, so closing the review or stepping
 * back does not lose it (the old Visual Concept editor's safety net; build
 * report, PR #956). Stored with the server version it was typed against: a
 * draft is restored only while that version is unchanged, and cleared once
 * it is saved, undone or overtaken.
 */
const draftKey = (key: string) => `gag-draft::${key}`;

function readStoredDraft(key: string, base: string): VisualPromptStrategyOverride | null {
  try {
    const raw = window.localStorage.getItem(draftKey(key));
    if (!raw) return null;
    const stored = JSON.parse(raw) as { base?: string; draft?: VisualPromptStrategyOverride };
    if (stored.base !== base || !stored.draft) {
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
  rendersEnabled,
  subjectNames,
  readOnly,
  onView,
  reportUnsaved,
}: {
  factId: number;
  reviewId: number | null;
  gag: GagView;
  rendersEnabled: boolean;
  subjectNames: string[];
  readOnly: boolean;
  onView: (v: FactGagsView) => void;
  reportUnsaved: (key: string, unsaved: boolean) => void;
}) {
  const working = gag.pendingContent ?? gag.approvedContent ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const workingKey = JSON.stringify(working);
  const storeKey = `${factId}:${gag.id}`;
  // An edit kept from before a reload or a closed review comes back, if the
  // gag is still as it was when the edit was typed.
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(() => readStoredDraft(storeKey, workingKey) ?? working);
  // A new server version replaces the draft (a save, a discard, an idea used on this gag).
  const seenKey = useRef(workingKey);
  useEffect(() => {
    if (seenKey.current === workingKey) return;
    seenKey.current = workingKey;
    setDraft(JSON.parse(workingKey) as VisualPromptStrategyOverride);
  }, [workingKey]);
  const dirty = !sameContent(draft, working);
  // Kept while the edit is unsaved, locked or not: a lock (a refresh, a step
  // change in flight) is not a save (Codex, PR #958 round 2).
  useStoredDraft(storeKey, workingKey, draft, dirty);
  const s = useGagSave(subjectNames);
  const unsavedKey = `gag-${gag.id}`;
  useEffect(() => { reportUnsaved(unsavedKey, dirty || s.busy); }, [reportUnsaved, unsavedKey, dirty, s.busy]);
  useEffect(() => () => reportUnsaved(unsavedKey, false), [reportUnsaved, unsavedKey]);
  const done = (r: GagResult | null) => { if (r?.ok) onView(r.view); };

  const save = async () => done(await s.run(draft, working, (c) => gagApi.save(factId, gag.id, c, reviewId), setDraft));
  const discard = async () => done(await s.act(() => gagApi.discard(factId, gag.id, reviewId)));
  const remove = async () => {
    if (!window.confirm(`Remove gag ${gag.slot}? Users will no longer be offered it.`)) return;
    done(await s.act(() => gagApi.remove(factId, gag.id, reviewId)));
  };
  // Cancel a refresh's removal of this gag: only the mark goes; its change and pick stay.
  const keep = async () => done(await s.act(() => gagApi.keep(factId, gag.id, reviewId)));
  const runRenders = async (kinds: GagExampleKind[], redraw = false) => done(await s.act(() => gagApi.runRenders(factId, gag.id, reviewId, kinds, redraw)));
  const approve = async (card: RenderScenarioCard) => {
    if (card.latestAttemptId == null) return;
    done(await s.act(() => gagApi.approve(factId, gag.id, card.latestAttemptId!, reviewId)));
  };

  const locked = readOnly || s.busy;
  const drawing = GAG_EXAMPLE_KINDS.some((k) => IN_FLIGHT.has(gag.renders[k]?.status ?? ""));
  // The set being built: picks for the pending change, else the approved version's.
  const building = gag.pendingContent != null;
  const picks = building ? gag.pendingExamples : gag.approvedExamples;
  const notDrawn = (k: GagExampleKind) => gag.renders[k] == null || gag.renders[k]!.status === "missing";
  const restMissing = REST_KINDS.filter(notDrawn);

  return (
    <div className="rounded-sm border-2 border-border bg-card p-4 space-y-3" data-testid="gag-card" data-gag-slot={gag.slot}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-1">
          <p className="text-sm font-bold text-foreground flex items-center gap-2 flex-wrap">
            Gag {gag.slot}
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
      {gag.refreshedSinceApproval && (
        <p className="text-xs text-muted-foreground" data-testid="gag-refreshed-note">Approved before the fact's latest refresh. It stays offered to users.</p>
      )}
      {gag.pendingRemove && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="gag-pending-remove">Will be removed when this refresh is promoted.</p>
      )}
      <p className="text-xs text-foreground" data-testid="gag-example-words">
        {building ? `This change: ${exampleWords(gag.pendingExamples, "picked")}.` : `${exampleWords(gag.approvedExamples)}.`}
        {building && gag.pendingReviewId != null && " The picks take effect when this refresh is promoted."}
        {building && gag.pendingReviewId == null && " The change reaches users when all three are approved."}
      </p>

      {GAG_EXAMPLE_KINDS.some((k) => gag.approvedExamples[k]?.imageUrl) && (
        <div className="flex gap-3 flex-wrap" data-testid="gag-approved-examples">
          {GAG_EXAMPLE_KINDS.map((k) => gag.approvedExamples[k]?.imageUrl ? (
            <figure key={k} className="space-y-1">
              <img src={gag.approvedExamples[k]!.imageUrl!} alt={`Gag ${gag.slot} ${k} example`} className="w-28 rounded-sm border border-border" data-testid="gag-example" data-kind={k} />
              <figcaption className="text-[11px] text-muted-foreground">{KIND_LABEL[k]} example{building ? " (users see this now)" : ""}</figcaption>
            </figure>
          ) : null)}
        </div>
      )}

      <GagEditor value={draft} onChange={setDraft} disabled={locked} fieldErrors={s.fieldErrors} />

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
          {gag.pendingContent != null && gag.approvedContent != null && (
            <button type="button" onClick={() => void discard()} disabled={locked} data-testid="gag-discard"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
              <RotateCcw className="w-3.5 h-3.5" /> Discard the saved change
            </button>
          )}
          {gag.pendingRemove && (
            <button type="button" onClick={() => void keep()} disabled={locked} data-testid="gag-keep"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
              <RotateCcw className="w-3.5 h-3.5" /> Keep this gag
            </button>
          )}
          {!gag.pendingRemove && (
            <button type="button" onClick={() => void remove()} disabled={locked} data-testid="gag-remove"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-destructive/50 text-destructive rounded-sm hover:bg-destructive/10 disabled:opacity-40">
              <Trash2 className="w-3.5 h-3.5" /> Remove gag
            </button>
          )}
        </div>
      )}

      {rendersEnabled && (
        <div className="space-y-2 border-t border-border pt-3" data-testid="gag-renders">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Test renders</p>
            {!readOnly && restMissing.length > 0 && (
              <button type="button" onClick={() => void runRenders([...REST_KINDS])} disabled={locked || dirty || drawing} data-testid="gag-render-rest"
                title={dirty ? "Save your change first: renders draw the saved version." : "Once the gag works on the male render, draw its female and pet renders."}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
                <Play className="w-3 h-3" /> Render {joinWithAnd(restMissing)}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {GAG_EXAMPLE_KINDS.map((k) => (
              <RenderTile
                key={k}
                kind={k}
                card={gag.renders[k]}
                picked={picks[k] != null && picks[k]!.attemptId === gag.renders[k]?.latestAttemptId}
                canAct={!readOnly && !locked && !dirty}
                readOnly={readOnly}
                onApprove={(c) => void approve(c)}
                onDraw={(redraw) => void runRenders([k], redraw)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A tile's state in words, when it has no image to show. */
function statusWords(status: string, message: string | null): string {
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

function RenderTile({ kind, card, picked, canAct, readOnly, onApprove, onDraw }: {
  kind: GagExampleKind;
  card: RenderScenarioCard | null;
  picked: boolean;
  canAct: boolean;
  readOnly: boolean;
  onApprove: (card: RenderScenarioCard) => void;
  onDraw: (redraw: boolean) => void;
}) {
  const status = card?.status ?? "missing";
  const inFlight = IN_FLIGHT.has(status);
  const approvable = !!card && status === "done" && card.latestAttemptId != null && !!card.imageUrl && !picked;
  const hint = canAct ? undefined : "Save or undo your edits first.";
  return (
    <div className="rounded-sm border border-border bg-background p-2 space-y-1.5" data-testid="gag-render" data-kind={kind}>
      <p className="text-xs font-semibold text-foreground flex items-center justify-between gap-1">
        {KIND_LABEL[kind]}
        {picked && (
          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-green-600/15 text-green-700 dark:text-green-400" data-testid="gag-render-picked">Approved</span>
        )}
      </p>
      {card?.imageUrl ? (
        <img src={card.imageUrl} alt={`${KIND_LABEL[kind]} render`} className="w-full rounded-sm border border-border" />
      ) : (
        <p className={`text-[11px] flex items-center gap-1 ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`} data-testid="gag-render-status">
          {inFlight && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusWords(status, card?.message ?? null)}
        </p>
      )}
      {approvable && (
        <button type="button" onClick={() => onApprove(card!)} disabled={!canAct} data-testid="gag-approve-render" title={hint}
          className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-bold border border-green-600/50 text-green-700 dark:text-green-400 rounded-sm hover:bg-green-600/10 disabled:opacity-40">
          <CheckCircle2 className="w-3.5 h-3.5" /> Approve this render
        </button>
      )}
      {!readOnly && !inFlight && (
        <button type="button" onClick={() => onDraw(card != null && status !== "missing")} disabled={!canAct} data-testid="gag-redraw-render" title={hint}
          className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px] border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
          {card != null && status !== "missing" ? <><RefreshCw className="w-3 h-3" /> Draw again</> : <><Play className="w-3 h-3" /> Draw this render</>}
        </button>
      )}
    </div>
  );
}

/** A new gag's draft has no server version to be typed against. */
const NEW_BASE = "new";

/** Whether a new gag's draft is kept from before, so the panel opens it again. */
export function hasStoredNewGagDraft(factId: number): boolean {
  return readStoredDraft(`${factId}:new`, NEW_BASE) != null;
}

function NewGagCard({
  factId,
  reviewId,
  subjectNames,
  onCancel,
  onView,
  reportUnsaved,
}: {
  factId: number;
  reviewId: number | null;
  subjectNames: string[];
  onCancel: () => void;
  onView: (v: FactGagsView) => void;
  reportUnsaved: (key: string, unsaved: boolean) => void;
}) {
  const storeKey = `${factId}:new`;
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(() => readStoredDraft(storeKey, NEW_BASE) ?? EMPTY_VISUAL_STRATEGY_OVERRIDE);
  const s = useGagSave(subjectNames);
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
      <p className="text-sm font-bold text-foreground">New gag</p>
      <GagEditor value={draft} onChange={setDraft} disabled={s.busy} fieldErrors={s.fieldErrors} />
      {s.error && <p className="text-xs text-destructive flex items-start gap-1.5 break-words" data-testid="gag-error"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="min-w-0">{s.error}</span></p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={s.busy || !hasScene} data-testid="gag-new-save"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-primary/50 text-primary rounded-sm hover:bg-primary/10 disabled:opacity-40">
          {s.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save gag
        </button>
        <button type="button" onClick={() => { clearStoredDraft(storeKey); onCancel(); }} disabled={s.busy}
          className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">Cancel</button>
      </div>
    </div>
  );
}
