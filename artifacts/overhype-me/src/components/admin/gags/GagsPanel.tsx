/**
 * @purpose The admin Gags panel: every gag of one fact, each with its state in words, its example, its editor, its test renders and its actions. Used by the moderation review (Gags and Test Renders steps) and the Facts editor.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md. Every gag follows the same rules: a saved
 * change waits as the gag's pending version, and it reaches users only once a
 * test render of it is approved as its example. Inside a refresh, the panel is
 * scoped to that refresh's review; outside one, a fact with an open refresh is
 * read-only here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Play, RotateCcw, Save, Trash2 } from "lucide-react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type FactGagsView,
  type GagView,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { VisualConceptCard } from "@/components/admin/VisualConceptCard";
import { BubbleEditor } from "@/components/admin/BubbleEditor";
import { VisualStrategyOverridePanel } from "@/components/admin/EnrichmentEditor";
import { gagApi, tokenizeGag, type GagResult } from "./gagApi";

const IN_FLIGHT = new Set(["queued", "rendering"]);
const POLL_MS = 2000;
/**
 * How long after the panel opens at Test Renders it keeps reloading even with
 * nothing visibly drawing: the batch the server queues on arrival is created by
 * a background job a few seconds later, and until then the cards read
 * `missing`, or show a previous batch's finished renders (Codex, PR #956 round 1).
 */
const PREPARE_WINDOW_MS = 60_000;

export interface GagsPanelProps {
  factId: number;
  /** The review the panel sits in; null on the Facts editor. */
  reviewId: number | null;
  /** Test renders and "Approve this render" (the Test Renders step and the Facts editor). */
  rendersEnabled: boolean;
  /**
   * The server queues renders without being asked (a review arriving at Test
   * Renders): keep reloading while a required render has not appeared, and for
   * a short window after opening. Never set where `missing` just means nobody
   * asked (the Facts editor, the Gags step), or the panel would poll forever.
   */
  rendersExpected?: boolean;
  /** Names the tokenizer should recognise as the subject. */
  subjectNames: string[];
  /** Bump to reload the view (an action elsewhere changed the gags). */
  reloadKey?: number;
  /** Called with every view the panel loads. */
  onView?: (view: FactGagsView) => void;
  /**
   * Called when the panel starts or stops holding work that is not saved: an
   * edited gag, a save still in flight, or a new gag with text typed in. An
   * approval that acts on the saved gags waits on it (Codex, PR #956 round 2).
   */
  onUnsavedChange?: (unsaved: boolean) => void;
  disabled?: boolean;
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function GagsPanel({ factId, reviewId, rendersEnabled, rendersExpected = false, subjectNames, reloadKey = 0, onView, onUnsavedChange, disabled = false }: GagsPanelProps) {
  const [view, setView] = useState<FactGagsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
  const anyUnsaved = unsavedKeys.size > 0;
  const onUnsavedRef = useRef(onUnsavedChange);
  onUnsavedRef.current = onUnsavedChange;
  useEffect(() => { onUnsavedRef.current?.(anyUnsaved); }, [anyUnsaved]);
  useEffect(() => () => { onUnsavedRef.current?.(false); }, []);

  const accept = useCallback((v: FactGagsView) => {
    setView(v);
    onViewRef.current?.(v);
  }, []);

  const load = useCallback(async () => {
    const r = await gagApi.load(factId);
    if (r.ok) { accept(r.view); setLoadError(null); } else setLoadError(r.error);
  }, [factId, accept]);

  useEffect(() => { if (factId > 0) void load(); }, [factId, reloadKey, load]);

  // Poll while any test render is still drawing. Where the server queues renders
  // itself, also while a required render has not appeared yet (the review grid's
  // rule, useFactRenderScenarios) and through the prepare window after opening.
  const [prepareWindowOpen, setPrepareWindowOpen] = useState(rendersExpected);
  useEffect(() => {
    if (!rendersExpected) { setPrepareWindowOpen(false); return; }
    setPrepareWindowOpen(true);
    const t = setTimeout(() => setPrepareWindowOpen(false), PREPARE_WINDOW_MS);
    return () => clearTimeout(t);
  }, [rendersExpected, factId, reloadKey]);
  const drawing = !!view?.gags.some((g) => g.renders.cards.some((c) => IN_FLIGHT.has(c.status)));
  const awaitingPrepared = rendersExpected && !!view?.gags.some((g) => g.renders.cards.some((c) => c.required && c.status === "missing"));
  const poll = drawing || awaitingPrepared || (rendersExpected && prepareWindowOpen);
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
          {view.gags.length} of {view.maxGags}. A gag reaches users once a test render of it is approved as its example.
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
          onView={accept}
          reportUnsaved={reportUnsaved}
        />
      ))}

      {adding && (
        <NewGagCard
          factId={factId}
          reviewId={reviewId}
          subjectNames={subjectNames}
          onCancel={() => { reportUnsaved("new", false); setAdding(false); }}
          onView={(v) => { reportUnsaved("new", false); accept(v); setAdding(false); }}
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
  if (g.state === "new") return "New: hidden from users until a test render is approved as its example";
  if (g.state === "approved_with_change") return "Approved, with a change waiting for its example";
  return "Approved";
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
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(working);
  // A new server version replaces the draft (a save, a discard, an idea used on this gag).
  const workingKey = JSON.stringify(working);
  useEffect(() => { setDraft(JSON.parse(workingKey) as VisualPromptStrategyOverride); }, [workingKey]);
  const dirty = !sameContent(draft, working);
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
  const runRenders = async () => done(await s.act(() => gagApi.runRenders(factId, gag.id, reviewId)));
  const approve = async (card: RenderScenarioCard) => {
    if (card.latestAttemptId == null) return;
    done(await s.act(() => gagApi.approve(factId, gag.id, card.latestAttemptId!, reviewId)));
  };

  const locked = readOnly || s.busy;
  const drawing = gag.renders.cards.some((c) => IN_FLIGHT.has(c.status));

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

      {(gag.carriedOver && !gag.approvedExample) && (
        <p className="text-xs text-muted-foreground" data-testid="gag-no-example">No example yet: this gag was approved before gags had examples.</p>
      )}
      {gag.refreshedSinceApproval && (
        <p className="text-xs text-muted-foreground" data-testid="gag-refreshed-note">Approved before the fact's latest refresh. It stays offered to users.</p>
      )}
      {gag.pendingRemove && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="gag-pending-remove">Will be removed when this refresh is promoted.</p>
      )}
      {gag.pendingExample && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="gag-pending-example">A render is picked as this change's example. It takes effect when this refresh is promoted.</p>
      )}

      {(gag.approvedExample?.imageUrl || gag.pendingExample?.imageUrl) && (
        <div className="flex gap-3 flex-wrap">
          {gag.approvedExample?.imageUrl && (
            <figure className="space-y-1">
              <img src={gag.approvedExample.imageUrl} alt={`Gag ${gag.slot} example`} className="w-40 rounded-sm border border-border" data-testid="gag-example" />
              <figcaption className="text-[11px] text-muted-foreground">Example</figcaption>
            </figure>
          )}
          {gag.pendingExample?.imageUrl && (
            <figure className="space-y-1">
              <img src={gag.pendingExample.imageUrl} alt={`Gag ${gag.slot} new example`} className="w-40 rounded-sm border border-amber-500/50" />
              <figcaption className="text-[11px] text-muted-foreground">New example, at promotion</figcaption>
            </figure>
          )}
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
            {!readOnly && (
              <button type="button" onClick={() => void runRenders()} disabled={locked || dirty || drawing} data-testid="gag-run-renders"
                title={dirty ? "Save your change first: renders draw the saved version." : undefined}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">
                {drawing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} {drawing ? "Drawing…" : "Run test renders"}
              </button>
            )}
          </div>
          {gag.renders.cards.length === 0 ? (
            <p className="text-xs text-muted-foreground">No test renders yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {gag.renders.cards.map((c) => (
                <RenderTile key={c.key} card={c} canApprove={!readOnly && !locked && !dirty} onApprove={() => void approve(c)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RenderTile({ card, canApprove, onApprove }: { card: RenderScenarioCard; canApprove: boolean; onApprove: () => void }) {
  const approvable = card.status === "done" && !card.stale && card.latestAttemptId != null && card.imageUrl;
  return (
    <div className="rounded-sm border border-border bg-background p-2 space-y-1.5" data-testid="gag-render" data-scenario={card.key}>
      <p className="text-xs font-semibold text-foreground truncate">{card.label}</p>
      {card.imageUrl ? (
        <img src={card.imageUrl} alt={card.label} className="w-full rounded-sm border border-border" />
      ) : (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
          {IN_FLIGHT.has(card.status) && <Loader2 className="w-3 h-3 animate-spin" />} {card.message ?? card.status}
        </p>
      )}
      {card.stale && <p className="text-[11px] text-amber-700 dark:text-amber-300">Drawn from an earlier version: run again.</p>}
      {approvable && (
        <button type="button" onClick={onApprove} disabled={!canApprove} data-testid="gag-approve-render"
          title={canApprove ? undefined : "Save or undo your edits first."}
          className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-bold border border-green-600/50 text-green-700 dark:text-green-400 rounded-sm hover:bg-green-600/10 disabled:opacity-40">
          <CheckCircle2 className="w-3.5 h-3.5" /> Approve this render
        </button>
      )}
    </div>
  );
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
  const [draft, setDraft] = useState<VisualPromptStrategyOverride>(EMPTY_VISUAL_STRATEGY_OVERRIDE);
  const s = useGagSave(subjectNames);
  const save = async () => {
    const r = await s.run(draft, null, (c) => gagApi.create(factId, c, reviewId), setDraft);
    if (r?.ok) onView(r.view);
  };
  const hasScene = useMemo(() => !!draft.coreSceneOverride?.trim(), [draft]);
  const typed = !sameContent(draft, EMPTY_VISUAL_STRATEGY_OVERRIDE);
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
        <button type="button" onClick={onCancel} disabled={s.busy}
          className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-40">Cancel</button>
      </div>
    </div>
  );
}
