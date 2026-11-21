import { useEffect, useRef, useState } from "react";
import { Beaker, ChevronDown, ChevronRight, Copy, Check, RefreshCw, AlertTriangle, Layers } from "lucide-react";

/**
 * Prompt Diagnostics (Phase 2C).
 *
 * Calls the REAL image-prompt service via POST /api/admin/image-prompt/preview
 * and shows the `compiledPrompt` an image engine would actually receive under
 * the chosen test assumptions. Since the switch (plan
 * PLAN_GAG_DIRECT_RENDER.md, D) the prompt is compiled straight from the
 * chosen gag with no model call, so this is exactly the prompt a render of
 * the same gag, photo, look and controls sends.
 *
 * Diagnostics-only: this panel no longer triggers renders (the Step-2 visual-
 * review scenario grid owns rendering now). It is read-only / non-mutating: it
 * never overwrites fact enrichment unless the admin explicitly opts into
 * persisting an image-prompt attempt row.
 */

/** Every picture starts from a photo (compiler review, Phase 2): the no-photo mode is gone. */
type SubjectRenderMode = "human_identity_i2i" | "nonhuman_subject_i2i";
type SourceSubjectKind =
  | "human_face"
  | "animal_subject"
  | "human_subject_no_usable_face"
  | "multiple_subjects"
  | "scene_no_clear_subject"
  | "ambiguous"
  | "detection_failed";
type NegativeSpacePreference = "top" | "bottom" | "left" | "right" | "auto" | "none";
type ContentMode = "sfw" | "suggestive" | "spicy";
type AspectRatio = "landscape" | "square" | "portrait";

interface LookStyle {
  id: string;
  label: string;
}

type PromptSectionStatus = "included" | "compressed" | "dropped" | "deduped" | "empty";

interface PromptSection {
  id: string;
  label: string;
  priority: "required" | "high" | "medium";
  status: PromptSectionStatus;
  text: string;
  rawText: string;
  /** Content authored by a human moderator (visual-concept core scene). */
  moderatorAuthored?: boolean;
}

interface RemovedProseSentence {
  sentence: string;
  reason: string;
}

interface PromptWarning {
  code: string;
  message: string;
  severity: "info" | "warning";
}

interface CompiledPromptDiagnostics {
  removedPlannerProseSentences?: RemovedProseSentence[];
  warnings?: PromptWarning[];
}

interface CompiledPrompt {
  prompt: string;
  imagePrompt?: string;
  negativePrompt?: string;
  engineNotes?: string;
  referenceImageUrl?: string;
  promptBreakdown?: PromptSection[];
  diagnostics?: CompiledPromptDiagnostics;
}

interface PreviewResponse {
  renderedFactText: string;
  inputSummary: {
    factId: number;
    subjectRenderMode: string;
    generationMode: "i2i" | "t2i";
    targetEngine: string;
    lookStyleId: string | null;
    stylePrompt: string;
    styleSource: "selected_look_style" | "none";
    fallbackSubjectGender: string | null;
    preservePhysique: boolean;
    aspectRatio: string;
    negativeSpacePreference: string | null;
  };
  compiledPrompt: CompiledPrompt;
  attemptId?: number;
}

const inputCls =
  "w-full px-2 py-1.5 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary";
const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";


// Per-section status → label + Tailwind classes for the breakdown chips.
const STATUS_META: Record<PromptSectionStatus, { label: string; cls: string }> = {
  included: { label: "included", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  compressed: { label: "compressed", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  dropped: { label: "dropped (over budget)", cls: "bg-destructive/15 text-destructive" },
  deduped: { label: "deduped (already present)", cls: "bg-muted text-muted-foreground" },
  empty: { label: "not used for this render", cls: "bg-muted text-muted-foreground" },
};

const PRIORITY_CLS: Record<PromptSection["priority"], string> = {
  required: "bg-primary/15 text-primary",
  high: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  medium: "bg-muted text-muted-foreground",
};

// Display labels for the section priority. This is a BUDGET-survival order (how a
// section is kept/compressed/dropped against the engine char cap when it HAS
// content) — NOT whether the section is mandatory. "required" → "always kept" so
// an empty conditional section doesn't read as a missing-required-field bug.
const PRIORITY_LABEL: Record<PromptSection["priority"], string> = {
  required: "always kept",
  high: "high",
  medium: "medium",
};

// Human labels for the reasons a planner-prose clause was stripped.
const REMOVAL_REASON_LABEL: Record<string, string> = {
  "identity-preservation-owned-by-compiler": "identity preservation (compiler owns this)",
  "reference-image-owned-by-compiler": "reference-image / mode language (compiler owns this)",
  "token-interpretation-owned-by-compiler": "token interpretation (compiler owns this)",
  "text-policy-owned-by-compiler": "text/logo policy (compiler owns this)",
  "empty-or-duplicate": "empty / duplicate",
};

// ── localStorage persistence (survives page reload without recomputing) ──────

const STORAGE_PREFIX = "overhype:rpp:v1:";
// Review-render mode gets its OWN key so moderation render controls/results never
// collide with the fact-editor preview state for the same staging factId.
const storageKey = (factId: number | null, reviewId: number | null, reviewIdForRender?: number) =>
  reviewIdForRender !== undefined
    ? `${STORAGE_PREFIX}review-render:${reviewIdForRender}`
    : reviewId !== null
      ? `${STORAGE_PREFIX}review:${reviewId}`
      : `${STORAGE_PREFIX}${factId}`;

interface PersistedControls {
  subjectRenderMode: SubjectRenderMode;
  sourceSubjectKind: SourceSubjectKind;
  subjectDescription: string;
  previewName: string;
  previewPronouns: string;
  lookStyleId: string;
  preservePhysique: boolean;
  aspectRatio: AspectRatio;
  negativeSpacePreference: NegativeSpacePreference;
  contentMode: ContentMode;
}

interface PersistedState {
  result: PreviewResponse | null;
  controls: PersistedControls;
}

function loadPersisted(factId: number | null, reviewId: number | null, reviewIdForRender?: number): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(factId, reviewId, reviewIdForRender));
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

type RuntimePromptPreviewProps = (
  // Fact path (also used by the moderation modal: factId = stagingFactId).
  // `reviewIdForRender` only scopes the persisted controls to a review so the
  // moderation diagnostics state never collides with the fact-editor preview;
  // it no longer enables any render action (the scenario grid owns rendering).
  | { factId: number; reviewId?: undefined; reviewIdForRender?: number }
  | { reviewId: number; factId?: undefined; reviewIdForRender?: undefined }
) & {
  /** Fires whenever the moderator's preview name changes — lets a caller (the
   *  moderation modal) fold it into `tokenizeAndSaveVisualOverride`'s
   *  `subjectNames` hint without lifting this component's whole persisted
   *  control state. */
  onPreviewNameChange?: (name: string) => void;
};

export function RuntimePromptPreview({ factId, reviewId, reviewIdForRender, onPreviewNameChange }: RuntimePromptPreviewProps) {
  const isReviewMode = reviewId !== undefined;
  // Every preview starts from a photo; a person's photo unless the moderator picks a pet.
  const defaultMode: SubjectRenderMode = "human_identity_i2i";
  const [expanded, setExpanded] = useState(false);
  const [lookStyles, setLookStyles] = useState<LookStyle[]>([]);

  const [subjectRenderMode, setSubjectRenderMode] = useState<SubjectRenderMode>(defaultMode);
  const [sourceSubjectKind, setSourceSubjectKind] = useState<SourceSubjectKind>("human_face");
  const [subjectDescription, setSubjectDescription] = useState("");
  const [previewName, setPreviewName] = useState("");
  const [previewPronouns, setPreviewPronouns] = useState("");
  const [lookStyleId, setLookStyleId] = useState("");
  const [preservePhysique, setPreservePhysique] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("portrait");
  const [negativeSpacePreference, setNegativeSpacePreference] = useState<NegativeSpacePreference>("auto");
  const [contentMode, setContentMode] = useState<ContentMode>("sfw");
  const [persist, setPersist] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [copied, setCopied] = useState(false);

  // Skip the very first save pass after a (re)hydration so restored data isn't
  // immediately clobbered by the current (pre-restore) state in the same commit.
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    if (!expanded) return;
    fetch("/api/look-styles", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setLookStyles(Array.isArray(rows) ? rows : []))
      .catch(() => setLookStyles([]));
  }, [expanded]);

  // Restore (or reset to defaults) whenever the selected fact/review changes, so a
  // page reload — or switching back to a fact — shows the last preview without
  // recomputing it.
  useEffect(() => {
    const saved = loadPersisted(factId ?? null, reviewId ?? null, reviewIdForRender);
    const c = saved?.controls;
    // A control saved before the no-photo mode was retired reads as a person's photo.
    setSubjectRenderMode(c?.subjectRenderMode === "nonhuman_subject_i2i" ? "nonhuman_subject_i2i" : defaultMode);
    setSourceSubjectKind(c?.sourceSubjectKind ?? "human_face");
    setSubjectDescription(c?.subjectDescription ?? "");
    setPreviewName(c?.previewName ?? "");
    setPreviewPronouns(c?.previewPronouns ?? "");
    setLookStyleId(c?.lookStyleId ?? "");
    setPreservePhysique(c?.preservePhysique ?? false);
    setAspectRatio(c?.aspectRatio ?? "portrait");
    setNegativeSpacePreference(c?.negativeSpacePreference ?? "auto");
    setContentMode(c?.contentMode ?? "sfw");
    setResult(saved?.result ?? null);
    setError(null);
    skipNextSaveRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factId, reviewId, reviewIdForRender]);

  const onPreviewNameChangeRef = useRef(onPreviewNameChange);
  onPreviewNameChangeRef.current = onPreviewNameChange;
  useEffect(() => {
    onPreviewNameChangeRef.current?.(previewName);
  }, [previewName]);

  // Persist controls + the last result per fact.
  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    try {
      const payload: PersistedState = {
        result,
        controls: {
          subjectRenderMode,
          sourceSubjectKind,
          subjectDescription,
          previewName,
          previewPronouns,
          lookStyleId,
          preservePhysique,
          aspectRatio,
          negativeSpacePreference,
          contentMode,
        },
      };
      localStorage.setItem(storageKey(factId ?? null, reviewId ?? null, reviewIdForRender), JSON.stringify(payload));
    } catch {
      /* storage full / unavailable — ignore */
    }
  }, [
    factId,
    reviewId,
    reviewIdForRender,
    result,
    subjectRenderMode,
    sourceSubjectKind,
    subjectDescription,
    previewName,
    previewPronouns,
    lookStyleId,
    preservePhysique,
    aspectRatio,
    negativeSpacePreference,
    contentMode,
  ]);


  function buildSourceImageAnalysis() {
    const isHuman = sourceSubjectKind === "human_face";
    const noSubject = sourceSubjectKind === "scene_no_clear_subject" || sourceSubjectKind === "detection_failed";
    return {
      subjectKind: sourceSubjectKind,
      confidence: "high" as const,
      hasUsableHumanFace: isHuman,
      hasUsableSubject: !noSubject,
      subjectCount: 1,
      subjectDescription: subjectDescription || undefined,
      suggestedRenderMode: subjectRenderMode,
      warnings: [] as string[],
      classificationMethod: "manual_user_choice" as const,
      analyzerVersion: "v1",
    };
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const body = {
        // Send reviewId for review-mode, factId otherwise.
        ...(isReviewMode ? { reviewId } : { factId }),
        // Moderation modal: also send the review context so the server resolves
        // enrichment through the review cycle — a refresh review previews its
        // CANDIDATE version, matching what the scenario grid renders.
        ...(reviewIdForRender !== undefined ? { reviewIdForRender } : {}),
        subjectRenderMode,
        userSelectedSubjectRenderMode: subjectRenderMode,
        // Every preview starts from a photo: send the synthetic admin choice.
        sourceImageAnalysis: buildSourceImageAnalysis(),
        lookStyleId: lookStyleId || null,
        // Optional sample subject so the override (and its {NAME}/pronoun tokens)
        // can be previewed as different people. Blank → server uses the brand
        // protagonist.
        ...(previewName.trim() ? { previewName: previewName.trim() } : {}),
        ...(/^[a-z]+\/[a-z]+$/i.test(previewPronouns.trim()) ? { previewPronouns: previewPronouns.trim() } : {}),
        renderControls: {
          aspectRatio,
          contentMode,
          negativeSpacePreference,
        },
        identityPolicyOverrides: { preservePhysique },
        // persist requires a real fact row; silently omit in review mode.
        ...(isReviewMode ? {} : { persist }),
      };
      const res = await fetch(`/api/admin/image-prompt/preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = typeof data?.details === "string" ? `: ${data.details}` : "";
        if (data?.error === "fact_enrichment_invalid") {
          setError("This fact has no usable AI taxonomy yet. Re-run it from the fact's \"Gags and AI taxonomy\" panel, then try again.");
        } else {
          setError(`${data?.error ?? `Request failed (${res.status})`}${detail}`);
        }
        return;
      }
      setResult(data as PreviewResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Runtime prompt preview failed");
    } finally {
      setLoading(false);
    }
  }

  const promptText = result ? result.compiledPrompt.imagePrompt || result.compiledPrompt.prompt : "";

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="rounded-sm border border-border bg-muted/20" data-testid="runtime-prompt-preview">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Beaker className="w-3.5 h-3.5" /> Prompt Diagnostics
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-snug">
            Recomputes the Phase 2 runtime prompt under the test assumptions you choose below — the prompt an image
            engine would receive right now. This is a live diagnostic; the frozen prompt that produced a specific
            test render is shown on each visual-review tile's "Scenario diagnostics".
          </p>

          {/* Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Subject render mode</label>
              <select
                className={inputCls}
                value={subjectRenderMode}
                onChange={(e) => setSubjectRenderMode(e.target.value as SubjectRenderMode)}
                data-testid="rpp-subject-render-mode"
              >
                <option value="human_identity_i2i">human_identity_i2i</option>
                <option value="nonhuman_subject_i2i">nonhuman_subject_i2i</option>
              </select>
            </div>

            <div>
              <label className={labelCls}>Source subject kind</label>
              <select
                className={inputCls}
                value={sourceSubjectKind}
                onChange={(e) => setSourceSubjectKind(e.target.value as SourceSubjectKind)}
                data-testid="rpp-source-subject-kind"
              >
                <option value="human_face">human_face</option>
                <option value="animal_subject">animal_subject</option>
                <option value="human_subject_no_usable_face">human_subject_no_usable_face</option>
                <option value="multiple_subjects">multiple_subjects</option>
                <option value="scene_no_clear_subject">scene_no_clear_subject</option>
                <option value="ambiguous">ambiguous</option>
                <option value="detection_failed">detection_failed</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className={labelCls}>Subject description</label>
              <input
                className={inputCls}
                value={subjectDescription}
                placeholder="e.g. orange tabby cat"
                onChange={(e) => setSubjectDescription(e.target.value)}
                data-testid="rpp-subject-description"
              />
            </div>

            <div>
              <label className={labelCls}>Sample name</label>
              <input
                className={inputCls}
                value={previewName}
                placeholder="David Franklin"
                onChange={(e) => setPreviewName(e.target.value)}
                data-testid="rpp-preview-name"
              />
            </div>

            <div>
              <label className={labelCls}>Sample pronouns</label>
              <input
                className={inputCls}
                value={previewPronouns}
                placeholder="he/him"
                onChange={(e) => setPreviewPronouns(e.target.value)}
                data-testid="rpp-preview-pronouns"
              />
            </div>

            <div>
              <label className={labelCls}>Style</label>
              <select
                className={inputCls}
                value={lookStyleId}
                onChange={(e) => setLookStyleId(e.target.value)}
                data-testid="rpp-look-style"
              >
                <option value="">(no style suffix)</option>
                {lookStyles.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Aspect ratio</label>
              <select
                className={inputCls}
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                data-testid="rpp-aspect-ratio"
              >
                <option value="portrait">portrait</option>
                <option value="square">square</option>
                <option value="landscape">landscape</option>
              </select>
            </div>

            <div>
              <label className={labelCls}>Negative space</label>
              <select
                className={inputCls}
                value={negativeSpacePreference}
                onChange={(e) => setNegativeSpacePreference(e.target.value as NegativeSpacePreference)}
                data-testid="rpp-negative-space"
              >
                <option value="auto">auto</option>
                <option value="top">top</option>
                <option value="bottom">bottom</option>
                <option value="left">left</option>
                <option value="right">right</option>
                <option value="none">none</option>
              </select>
            </div>

            <div>
              <label className={labelCls}>Content mode</label>
              <select
                className={inputCls}
                value={contentMode}
                onChange={(e) => setContentMode(e.target.value as ContentMode)}
                data-testid="rpp-content-mode"
              >
                <option value="sfw">sfw</option>
                <option value="suggestive">suggestive</option>
                <option value="spicy">spicy</option>
              </select>
            </div>

            <div>
              <label className={labelCls}>Target engine</label>
              <input className={`${inputCls} opacity-70`} value="nano_banana_2" readOnly data-testid="rpp-target-engine" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={preservePhysique}
                onChange={(e) => setPreservePhysique(e.target.checked)}
                data-testid="rpp-preserve-physique"
              />
              Preserve physique
            </label>
            {!isReviewMode && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={persist}
                  onChange={(e) => setPersist(e.target.checked)}
                  data-testid="rpp-persist"
                />
                Save this as an image-prompt attempt
              </label>
            )}
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-sm bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="rpp-generate"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Generating…" : "Generate runtime prompt preview"}
          </button>

          {error && (
            <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2" data-testid="rpp-error">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {result && (
            <div className="space-y-3 border-t border-border pt-3">
              {/* Rendered fact text — the source fact sentence personalized to the
                  sample name/pronouns. Verifies FACT-TEMPLATE token substitution
                  only; moderator override-field tokens are verified in the
                  compiled prompt / breakdown below. */}
              {result.renderedFactText && (
                <div>
                  <span className={labelCls}>Rendered fact text (sample subject)</span>
                  <p
                    className="text-[12px] text-foreground bg-background border border-border rounded-sm p-2"
                    data-testid="rpp-rendered-fact"
                  >
                    {result.renderedFactText}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1 italic">
                    Fact-template tokens rendered for the sample name/pronouns. Tokens you put in
                    override fields show up in the compiled prompt below, not here.
                  </p>
                </div>
              )}

              {/* Compiled prompt */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className={labelCls}>Compiled prompt</span>
                  <button
                    type="button"
                    onClick={copyPrompt}
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    data-testid="rpp-copy"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre
                  className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-background border border-border rounded-sm p-2 max-h-72 overflow-auto"
                  data-testid="rpp-compiled-prompt"
                >
                  {promptText}
                </pre>
              </div>

              {/* Prompt components — how the final prompt was assembled */}
              {result.compiledPrompt.promptBreakdown && result.compiledPrompt.promptBreakdown.length > 0 && (
                <div data-testid="rpp-breakdown">
                  <button
                    type="button"
                    onClick={() => setShowBreakdown((v) => !v)}
                    className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide"
                    data-testid="rpp-toggle-breakdown"
                  >
                    {showBreakdown ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <Layers className="w-3 h-3" />
                    Prompt components ({result.compiledPrompt.promptBreakdown.length})
                  </button>
                  {showBreakdown && (
                    <div className="mt-1.5 space-y-1.5">
                      <p className="text-[10px] text-muted-foreground italic leading-snug">
                        The deterministic compiler concatenates these components (in order) to build the
                        final prompt above. Each shows whether it was included, compressed to fit the
                        engine budget, de-duplicated against earlier text, or not used for this render.
                        The priority chip (“always kept” / “high” / “medium”) is the budget-survival
                        order — how the section is kept vs compressed when content is present — not
                        whether it is mandatory. Conditional sections (e.g. SUBJECT BINDING, SUBJECT
                        REALIZATION, ROLE DETAILS) are simply “not used for this render”
                        when the fact doesn’t trigger them.
                      </p>
                      {result.compiledPrompt.promptBreakdown.map((s, i) => {
                        const meta = STATUS_META[s.status];
                        const body = s.status === "included" || s.status === "compressed" ? s.text : s.rawText;
                        const muted = s.status === "deduped" || s.status === "empty" || s.status === "dropped";
                        return (
                          <div
                            key={`${s.id}-${i}`}
                            className="rounded-sm border border-border bg-background p-2"
                            data-testid={`rpp-breakdown-section-${s.id}`}
                          >
                            <div className="flex flex-wrap items-center gap-1.5 mb-1">
                              <span className="text-[11px] font-semibold text-foreground">{s.label}</span>
                              <span className={`text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded-sm ${PRIORITY_CLS[s.priority]}`}>
                                {PRIORITY_LABEL[s.priority]}
                              </span>
                              <span className={`text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded-sm ${meta.cls}`}>
                                {meta.label}
                              </span>
                              {s.moderatorAuthored && (
                                <span
                                  className="text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded-sm bg-purple-500/15 text-purple-700 dark:text-purple-300"
                                  data-testid="rpp-moderator-chip"
                                  title="This section's content was authored by a moderator (Visual concept), not the planner LLM."
                                >
                                  Moderator
                                </span>
                              )}
                            </div>
                            {body ? (
                              <p className={`whitespace-pre-wrap font-mono text-[10px] leading-snug ${muted ? "text-muted-foreground line-through decoration-muted-foreground/40" : "text-foreground"}`}>
                                {body}
                              </p>
                            ) : (
                              <p className="text-[10px] text-muted-foreground italic">— no content for this render —</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Compiler diagnostics — stripped prose clauses + tone warnings */}
              {result.compiledPrompt.diagnostics &&
                ((result.compiledPrompt.diagnostics.warnings?.length ?? 0) > 0 ||
                  (result.compiledPrompt.diagnostics.removedPlannerProseSentences?.length ?? 0) > 0) && (
                  <div className="space-y-2" data-testid="rpp-diagnostics">
                    {result.compiledPrompt.diagnostics.warnings?.map((w, i) => (
                      <div
                        key={`${w.code}-${i}`}
                        className="flex items-start gap-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                        data-testid="rpp-tone-warning"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">{w.message}</p>
                      </div>
                    ))}

                    {(result.compiledPrompt.diagnostics.removedPlannerProseSentences?.length ?? 0) > 0 && (
                      <div className="rounded-sm border border-border bg-background p-2" data-testid="rpp-removed-clauses">
                        <span className={labelCls}>
                          Prompt guard removed {result.compiledPrompt.diagnostics.removedPlannerProseSentences!.length} planner/moderator
                          clause(s)
                        </span>
                        <p className="text-[10px] text-muted-foreground italic mb-1.5 leading-snug">
                          These were dropped from the planner/moderator prose because the compiler emits them itself — so the
                          engine prompt can&apos;t carry a competing or duplicate instruction. Check here for false positives.
                        </p>
                        <ul className="space-y-1">
                          {result.compiledPrompt.diagnostics.removedPlannerProseSentences!.map((r, i) => (
                            <li key={i} className="text-[10px] leading-snug">
                              <span className="font-mono text-muted-foreground line-through decoration-muted-foreground/40">
                                {r.sentence}
                              </span>
                              <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                                — {REMOVAL_REASON_LABEL[r.reason] ?? r.reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

              {result.compiledPrompt.negativePrompt && (
                <div>
                  <span className={labelCls}>Negative prompt</span>
                  <pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-background border border-border rounded-sm p-2" data-testid="rpp-negative-prompt">
                    {result.compiledPrompt.negativePrompt}
                  </pre>
                </div>
              )}

              {/* Input summary */}
              <div>
                <span className={labelCls}>Input summary</span>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]" data-testid="rpp-input-summary">
                  {Object.entries(result.inputSummary).map(([k, v]) => (
                    <div key={k} className="flex gap-1">
                      <dt className="text-muted-foreground">{k}:</dt>
                      <dd className="text-foreground font-medium break-all">{v === null || v === "" ? "—" : String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {result.inputSummary.styleSource === "none" && (
                  <p className="mt-1 text-[10px] text-muted-foreground italic">
                    styleSource = none — no style suffix is being appended. The prompt won’t include a look style unless you select one.
                  </p>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </div>
  );
}
