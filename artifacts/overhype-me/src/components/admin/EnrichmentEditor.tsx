import { useState, useRef, type ChangeEvent, type FocusEvent } from "react";
import {
  PRIMARY_ARCHETYPES,
  SUBTYPES_BY_ARCHETYPE,
  VISUAL_LITERALNESS_VALUES,
  VISUAL_COMPLEXITY_VALUES,
  OVERHYPE_FIT_VALUES,
  ADULT_SUITABILITY_VALUES,
  KNOWN_FACT_MODIFIERS,
  REFERENCE_TYPE_VALUES,
  isKnownModifier,
  normalizeHashtag,
  validateEnrichment,
  computeEnrichmentVersionStatus,
  type EnrichmentVersionStatus,
  type FactEnrichment,
  type CulturalReference,
  type ReferenceType,
  type PrimaryArchetype,
  type SemanticEntity,
  type SemanticEntityKind,
  type CapitalizationSignal,
  SEMANTIC_ENTITY_KIND_VALUES,
  CAPITALIZATION_SIGNAL_VALUES,
  SUBJECT_REALIZATION_MODE_VALUES,
  SUPPORTING_TEXT_MODE_VALUES,
  VIOLENCE_MODE_VALUES,
  VIOLENCE_INTENSITY_VALUES,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  canonicalizeNameToken,
  firstOverrideTokenError,
  hasRenderableVisualStrategyOverrideContent,
  type VisualPromptStrategyOverride,
  type VisualStrategyRoleBinding,
  type SubjectRealizationMode,
  OVERRIDABLE_PATHS,
  type OverridablePath,
} from "@workspace/api-zod";
import { AlertTriangle, RefreshCw, Save, X, Plus, Trash2, Search, Loader2, Sparkles, ExternalLink, CheckCircle2 } from "lucide-react";
import { OverrideMark } from "./OverrideMark";
import { FieldInfo, FieldLabel, ADMIN_LABEL_CLASS } from "./FieldInfo";
import { fieldLabel, PATH_TO_DOC_KEY, type FieldDocKey } from "./fieldDocs";

/**
 * Optional override decoration context. Provided only on the live Facts page
 * (where a fact has an AI baseline + a manual-override map); omitted in the
 * review/approval flow (no fact exists yet) so the editor behaves as before.
 * When present, tracked fields write through PUT/DELETE override endpoints
 * instead of the whole-blob draft + PATCH save.
 */
export interface EnrichmentOverrideContext {
  aiDerived: FactEnrichment | null;
  overrides: Record<string, { value: unknown; overriddenFrom: unknown }>;
  summary: {
    overriddenPaths: string[];
    baselineChangedPaths: string[];
    hasVisualStrategyOverride: boolean;
  };
  /** Per-path live save status. */
  pending: Record<string, "saving" | "error">;
  onOverride: (path: OverridablePath, value: unknown) => void;
  onReset: (path: OverridablePath) => void;
  onAcknowledge: (path: OverridablePath, value: unknown) => void;
}

/** Blank scaffold used when an admin fills enrichment manually (AI failed). */
export const EMPTY_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

/**
 * True ONLY for the exact, path-specific `visualPromptStrategyOverride`
 * schema issue that rejects a personalization token in a role binding's
 * `entity` field (see `visualStrategyOverrideSchema`'s superRefine) — the one
 * validity error `tokenizeAndSaveVisualOverride` can fix by itself (it blocks
 * persistence and red-borders that row on its own if the token survives
 * tokenizing). Deliberately narrow: does NOT match unknown/malformed tokens in
 * prose fields, VSO length/cap/enum errors, or any non-VSO enrichment
 * failure — those must still hard-disable Save. Never broaden this to a
 * `startsWith("visualPromptStrategyOverride:")` catch-all.
 */
export function isFixableRoleEntityTokenIssue(error: string): boolean {
  return /^visualPromptStrategyOverride\.roleBindings\.\d+\.entity: personalization tokens are not allowed/.test(error);
}

/** Sentinel `fieldErrors` key for a whole-batch tokenize failure (network/HTTP
 *  error) not attributable to any one field. Mirrors
 *  `VSO_TOKENIZE_GENERAL_ERROR_KEY` in useFactEnrichmentEditing.ts (kept as a
 *  literal, not an import, to avoid a cycle between the two files). */
const VSO_GENERAL_TOKENIZE_ERROR_KEY = "";

const SELECT_CLASS =
  "w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";
// Label styling now lives in FieldInfo (shared with FieldLabel); this alias
// covers the remaining plain repeater-row labels that have no adjacent icon.
const LABEL_CLASS = ADMIN_LABEL_CLASS;

function Warnings({ e }: { e: FactEnrichment }) {
  const warnings: string[] = [];
  if (e.taxonomyConfidence < 0.75) warnings.push("Low confidence — review classification");
  if (e.overhypeFit === "questionable") warnings.push("Check Overhype fit");
  if (e.overhypeFit === "reject") warnings.push("Likely reject or rewrite");
  if (e.adultSuitability === "requires_review") warnings.push("Review adult eligibility");
  if (e.visualComplexity === "high") warnings.push("Hard to visualize");
  const customMods = e.modifiers.filter((m) => !isKnownModifier(m));
  if (customMods.length) warnings.push(`New modifier(s): ${customMods.join(", ")}`);

  // Phase 2A: cultural-reference and visual-preview signals.
  const flaggedRefs = e.culturalReferences.filter((r) => r.requiresAdminReview);
  if (flaggedRefs.length) {
    warnings.push(`Cultural reference needs admin review: ${flaggedRefs.map((r) => r.sourcePhrase).join(", ")}`);
  }
  const lowConfRefs = e.culturalReferences.filter((r) => r.confidence < 0.75);
  if (lowConfRefs.length) {
    warnings.push(`Low-confidence cultural reference(s): ${lowConfRefs.map((r) => r.sourcePhrase).join(", ")}`);
  }

  // CLASSIFICATION_PROMPT_VERSION v3: capitalization-aware visual referents.
  const entities = e.semanticEntities ?? [];
  const sentenceInitial = entities.filter((s) => s.capitalizationSignal === "sentence_initial_ambiguous");
  if (sentenceInitial.length) {
    warnings.push(
      `Ambiguous sentence-initial entity: ${sentenceInitial.map((s) => `"${s.surfaceText}"`).join(", ")} — confirm interpretation.`,
    );
  }
  const ambiguousEntities = entities.filter((s) => s.entityKind === "ambiguous");
  if (ambiguousEntities.length) {
    warnings.push(`Ambiguous semantic entity: ${ambiguousEntities.map((s) => `"${s.surfaceText}"`).join(", ")}`);
  }
  const brandEntities = entities.filter((s) => s.entityKind === "brand_or_cultural_reference");
  if (brandEntities.length) {
    warnings.push(`Brand / cultural reference entity: ${brandEntities.map((s) => `"${s.surfaceText}"`).join(", ")} — confirm rendering policy.`);
  }
  const reviewEntities = entities.filter((s) => s.requiresAdminReview && !sentenceInitial.includes(s) && !ambiguousEntities.includes(s) && !brandEntities.includes(s));
  if (reviewEntities.length) {
    warnings.push(`Semantic entity flagged for review: ${reviewEntities.map((s) => `"${s.surfaceText}"`).join(", ")}`);
  }
  const lowConfEntities = entities.filter((s) => s.confidence < 0.75);
  if (lowConfEntities.length) {
    warnings.push(`Low-confidence semantic entity: ${lowConfEntities.map((s) => `"${s.surfaceText}"`).join(", ")}`);
  }

  if (!warnings.length) return null;
  return (
    <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
      {warnings.map((w) => (
        <p key={w} className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {w}
        </p>
      ))}
    </div>
  );
}

function emptyCulturalRef(): CulturalReference {
  return {
    sourcePhrase: "",
    referenceType: "cultural_reference",
    canonicalReference: "",
    explanation: "",
    visualImplication: "",
    confidence: 0.7,
    requiresAdminReview: false,
  };
}

// ─── Research Reference panel ──────────────────────────────────────────────
//
// Per-row "Research Reference" button. POSTs to /api/admin/references/research
// with the cultural reference fields + the surrounding fact text, then renders
// a result panel with Apply / Replace / Dismiss. Auto-applies when both target
// fields are empty AND the service flagged canAutoApplyToEmptyFields=true
// (high/medium confidence + no ambiguity warnings + sources present for
// public references).

type ResearchSource = {
  title: string;
  url: string;
  sourceType: "official" | "encyclopedic" | "news" | "community" | "search_result" | "admin_context" | "other";
  summary: string;
};
type ResearchResult = {
  explanation: string;
  visualImplication: string;
  confidence: "high" | "medium" | "low";
  sources: ResearchSource[];
  researchNotes: string;
  ambiguityWarnings: string[];
  canAutoApplyToEmptyFields: boolean;
  researchedAt: string;
  researchedBy: "ai_reference_research";
};
type ResearchPhase = "idle" | "researching" | "result" | "applied" | "error";

function ResearchReferencePanel({
  factText,
  reference,
  onApplyPatch,
}: {
  factText: string;
  reference: CulturalReference;
  onApplyPatch: (patch: Partial<CulturalReference>) => void;
}) {
  const [phase, setPhase] = useState<ResearchPhase>("idle");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [autoApplied, setAutoApplied] = useState(false);

  const buttonEnabled =
    !!factText.trim() &&
    (!!reference.sourcePhrase || !!reference.canonicalReference) &&
    !!reference.referenceType;
  const disabledReason = !factText.trim()
    ? "Need fact text to research."
    : !reference.sourcePhrase && !reference.canonicalReference
      ? "Add a source phrase or canonical reference before researching."
      : !reference.referenceType
        ? "Pick a reference type before researching."
        : "";

  const applyPatchFromResult = (mode: "empty_only" | "replace_all", r: ResearchResult) => {
    const patch: Partial<CulturalReference> = {
      researchConfidence: r.confidence,
      researchSources: r.sources,
      researchNotes: r.researchNotes,
      ambiguityWarnings: r.ambiguityWarnings,
      researchedAt: r.researchedAt,
      researchedBy: r.researchedBy,
    };
    const explanationEmpty = !reference.explanation.trim();
    const visualEmpty = !reference.visualImplication.trim();
    if (mode === "replace_all") {
      patch.explanation = r.explanation;
      patch.visualImplication = r.visualImplication;
    } else {
      if (explanationEmpty) patch.explanation = r.explanation;
      if (visualEmpty) patch.visualImplication = r.visualImplication;
    }
    onApplyPatch(patch);
  };

  const handleResearch = async (forceRefresh = false) => {
    setPhase("researching");
    setError(null);
    setAutoApplied(false);
    try {
      const res = await fetch("/api/admin/references/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          factText,
          sourcePhrase: reference.sourcePhrase,
          referenceType: reference.referenceType,
          canonicalReference: reference.canonicalReference,
          existingExplanation: reference.explanation || undefined,
          existingVisualImplication: reference.visualImplication || undefined,
          ...(forceRefresh ? { forceRefresh: true } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "research_failed" })) as { error?: string; details?: string };
        throw new Error(body.details ?? body.error ?? "research_failed");
      }
      const body = (await res.json()) as { result: ResearchResult; fromCache: boolean };
      setResult(body.result);
      setFromCache(body.fromCache);
      const explanationEmpty = !reference.explanation.trim();
      const visualEmpty = !reference.visualImplication.trim();
      if (
        body.result.canAutoApplyToEmptyFields &&
        explanationEmpty &&
        visualEmpty &&
        body.result.confidence !== "low"
      ) {
        applyPatchFromResult("empty_only", body.result);
        setAutoApplied(true);
        setPhase("applied");
      } else {
        setPhase("result");
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  };

  const handleDismiss = () => {
    setPhase("idle");
    setResult(null);
    setError(null);
    setAutoApplied(false);
  };

  return (
    <div className="rounded-sm border border-border bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> Research reference
        </p>
        <button
          type="button"
          onClick={() => handleResearch()}
          disabled={!buttonEnabled || phase === "researching"}
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline disabled:text-muted-foreground disabled:cursor-not-allowed disabled:no-underline"
          title={!buttonEnabled ? disabledReason : "Look up this reference and propose explanation + visual implication"}
        >
          {phase === "researching" ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> Researching…
            </>
          ) : (
            <>
              <Search className="w-3 h-3" /> Research reference
            </>
          )}
        </button>
      </div>

      {phase === "idle" && !buttonEnabled && (
        <p className="text-xs text-muted-foreground italic">{disabledReason}</p>
      )}

      {phase === "applied" && autoApplied && result && (
        <div className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-1">
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Auto-applied to empty fields ({result.confidence} confidence{fromCache ? " · from cache" : ""}).
          </p>
          <div className="flex items-center gap-3">
            {fromCache && (
              <button
                type="button"
                onClick={() => handleResearch(true)}
                className="text-xs text-primary hover:underline"
                title="Bypass cache and re-run the AI research"
              >
                Re-fetch
              </button>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-muted-foreground hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span
              className={
                result.confidence === "high"
                  ? "px-1.5 py-0.5 rounded-sm bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                  : result.confidence === "medium"
                    ? "px-1.5 py-0.5 rounded-sm bg-amber-500/20 text-amber-700 dark:text-amber-400"
                    : "px-1.5 py-0.5 rounded-sm bg-red-500/20 text-red-600 dark:text-red-400"
              }
            >
              {result.confidence} confidence
            </span>
            {fromCache && (
              <>
                <span className="text-muted-foreground">from cache</span>
                <button
                  type="button"
                  onClick={() => handleResearch(true)}
                  className="text-xs text-primary hover:underline"
                  title="Bypass cache and re-run the AI research"
                >
                  Re-fetch
                </button>
              </>
            )}
          </div>

          {result.ambiguityWarnings.length > 0 && (
            <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 space-y-0.5">
              {result.ambiguityWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {w}
                </p>
              ))}
            </div>
          )}

          <div className="space-y-0.5">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Proposed explanation</p>
            <p className="text-xs text-foreground whitespace-pre-wrap">{result.explanation}</p>
          </div>

          <div className="space-y-0.5">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Proposed visual implication</p>
            <p className="text-xs text-foreground whitespace-pre-wrap">{result.visualImplication}</p>
          </div>

          {result.sources.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Sources ({result.sources.length})
              </summary>
              <ul className="mt-1 space-y-1 pl-3">
                {result.sources.map((s, i) => (
                  <li key={i} className="text-xs text-foreground">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {s.title} <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ) : (
                      <span>{s.title}</span>
                    )}
                    <span className="text-muted-foreground"> · {s.sourceType}</span>
                    {s.summary && <p className="text-muted-foreground pl-2">{s.summary}</p>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {result.researchNotes && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Research notes</summary>
              <p className="mt-1 text-xs text-foreground whitespace-pre-wrap pl-3">{result.researchNotes}</p>
            </details>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              type="button"
              onClick={() => {
                applyPatchFromResult("empty_only", result);
                setPhase("applied");
              }}
              className="px-2 py-1 text-xs rounded-sm bg-primary text-primary-foreground hover:opacity-90"
            >
              Apply to empty fields
            </button>
            <button
              type="button"
              onClick={() => {
                if (!confirm("Replace existing explanation + visual implication with the researched values?")) return;
                applyPatchFromResult("replace_all", result);
                setPhase("applied");
              }}
              className="px-2 py-1 text-xs rounded-sm border border-border hover:bg-muted"
            >
              Replace existing fields
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="px-2 py-1 text-xs rounded-sm text-muted-foreground hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {phase === "applied" && !autoApplied && (
        <p className="text-xs text-muted-foreground">Applied. <button type="button" onClick={handleDismiss} className="underline">Dismiss</button></p>
      )}

      {phase === "error" && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 space-y-1">
          <p className="text-xs text-destructive">{error ?? "Research failed."}</p>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-muted-foreground hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Free-text field for tracked-override editors. With `commitOnBlur` (override
 * mode) edits buffer locally while the field is focused and commit ONCE on
 * blur — so per-field override persistence, and the server's
 * trim/canonicalization round-trip that would clobber the focused input, never
 * fires mid-typing. While unfocused it always renders `value`, so external
 * updates (override reset, server fold-back) flow through; while focused the
 * local buffer wins. Without `commitOnBlur` (the review/approval flow, where
 * commits are draft-only) it is a plain controlled input committing every
 * keystroke, preserving the per-keystroke localStorage draft autosave.
 */
function DraftTextField({
  value,
  onCommit,
  commitOnBlur,
  multiline = false,
  rows = 2,
  maxLength,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  commitOnBlur: boolean;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
}) {
  // null = not editing; the committed `value` shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const shared = {
    value: commitOnBlur ? (draft ?? value) : value,
    maxLength,
    placeholder,
    onChange: (ev: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (commitOnBlur) setDraft(ev.target.value);
      else onCommit(ev.target.value);
    },
    onBlur: () => {
      if (!commitOnBlur) return;
      if (draft !== null && draft !== value) onCommit(draft);
      setDraft(null);
    },
  };
  return multiline ? (
    <textarea className={`${SELECT_CLASS} resize-none`} rows={rows} {...shared} />
  ) : (
    <input className={SELECT_CLASS} {...shared} />
  );
}

/**
 * Cultural references editor (Phase 2A). Admins can edit `explanation` and
 * `visualImplication` directly per the addendum; `sourcePhrase` and
 * `canonicalReference` are also editable so a manual-fill workflow can author
 * the whole entry. `referenceType` and `confidence` are selectable;
 * `requiresAdminReview` is a checkbox.
 */
function CulturalReferencesEditor({
  refs,
  factText,
  onChange,
  commitTextOnBlur,
}: {
  refs: CulturalReference[];
  factText: string;
  onChange: (next: CulturalReference[]) => void;
  /** Override mode: free-text edits commit on blur (see DraftTextField). */
  commitTextOnBlur: boolean;
}) {
  const update = (i: number, patch: Partial<CulturalReference>) => {
    const next = refs.slice();
    next[i] = { ...next[i]!, ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(refs.filter((_, idx) => idx !== i));
  const add = () => onChange([...refs, emptyCulturalRef()]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <FieldLabel docKey="culturalReferences" className="mb-0" />
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="w-3 h-3" /> Add reference
        </button>
      </div>
      {refs.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No outside-context dependencies — the joke is intelligible from the literal text alone.</p>
      ) : (
        <div className="space-y-3">
          {refs.map((r, i) => (
            <div key={i} className="rounded-sm border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 flex-1">
                  <div>
                    <label className={LABEL_CLASS}>Source phrase</label>
                    <DraftTextField
                      value={r.sourcePhrase}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { sourcePhrase: v })}
                    />
                  </div>
                  <div>
                    <FieldLabel docKey="ref.referenceType" />
                    <select
                      className={SELECT_CLASS}
                      value={r.referenceType}
                      onChange={(ev) => update(i, { referenceType: ev.target.value as ReferenceType })}
                    >
                      {REFERENCE_TYPE_VALUES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Canonical reference</label>
                    <DraftTextField
                      value={r.canonicalReference}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { canonicalReference: v })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Explanation</label>
                    <DraftTextField
                      multiline
                      rows={2}
                      maxLength={800}
                      value={r.explanation}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { explanation: v })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Visual implication</label>
                    <DraftTextField
                      multiline
                      rows={2}
                      maxLength={800}
                      value={r.visualImplication}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { visualImplication: v })}
                    />
                  </div>
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <label className="text-xs text-muted-foreground">
                      Confidence:{" "}
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        className="w-20 px-2 py-0.5 bg-background border border-border rounded-sm text-sm text-foreground"
                        value={r.confidence}
                        onChange={(ev) => update(i, { confidence: Math.max(0, Math.min(1, Number(ev.target.value) || 0)) })}
                      />
                    </label>
                    <label className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={r.requiresAdminReview}
                        onChange={(ev) => update(i, { requiresAdminReview: ev.target.checked })}
                      />
                      Requires admin review
                    </label>
                  </div>
                  <div className="sm:col-span-2">
                    <ResearchReferencePanel
                      factText={factText}
                      reference={r}
                      onApplyPatch={(patch) => update(i, patch)}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="p-1 text-muted-foreground hover:text-destructive"
                  aria-label="Remove cultural reference"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function emptySemanticEntity(): SemanticEntity {
  return {
    surfaceText: "",
    normalizedText: "",
    entityKind: "common_noun",
    visualReferent: "",
    capitalizationSignal: "lowercase_common_noun",
    materiallyAffectsVisualPrompt: true,
    requiresAdminReview: false,
    confidence: 0.8,
    notes: "",
  };
}

/**
 * Semantic entities editor (CLASSIFICATION_PROMPT_VERSION v3).
 * Surfaces capitalization-aware visual referent decisions made during
 * enrichment so an admin can sanity-check them before approval. All fields
 * are editable; the admin can add/remove entries manually.
 */
function SemanticEntitiesEditor({
  entities,
  onChange,
  commitTextOnBlur,
}: {
  entities: SemanticEntity[];
  onChange: (next: SemanticEntity[]) => void;
  /** Override mode: free-text edits commit on blur (see DraftTextField). */
  commitTextOnBlur: boolean;
}) {
  const update = (i: number, patch: Partial<SemanticEntity>) => {
    const next = entities.slice();
    next[i] = { ...next[i]!, ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(entities.filter((_, idx) => idx !== i));
  const add = () => onChange([...entities, emptySemanticEntity()]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <FieldLabel docKey="semanticEntities" className="mb-0" />
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="w-3 h-3" /> Add entity
        </button>
      </div>
      {entities.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No capitalization-sensitive terms flagged. Add an entry when a term's interpretation (e.g. "Earth" the planet vs "earth" the soil) materially affects the image.
        </p>
      ) : (
        <div className="space-y-3">
          {entities.map((s, i) => (
            <div key={i} className="rounded-sm border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 flex-1">
                  <div>
                    <label className={LABEL_CLASS}>Surface text (verbatim case)</label>
                    <DraftTextField
                      value={s.surfaceText}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { surfaceText: v })}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Normalized text</label>
                    <DraftTextField
                      value={s.normalizedText}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { normalizedText: v })}
                    />
                  </div>
                  <div>
                    <FieldLabel docKey="ent.entityKind" />
                    <select
                      className={SELECT_CLASS}
                      value={s.entityKind}
                      onChange={(ev) => update(i, { entityKind: ev.target.value as SemanticEntityKind })}
                    >
                      {SEMANTIC_ENTITY_KIND_VALUES.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <FieldLabel docKey="ent.capitalizationSignal" />
                    <select
                      className={SELECT_CLASS}
                      value={s.capitalizationSignal}
                      onChange={(ev) => update(i, { capitalizationSignal: ev.target.value as CapitalizationSignal })}
                    >
                      {CAPITALIZATION_SIGNAL_VALUES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Visual referent</label>
                    <DraftTextField
                      value={s.visualReferent}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { visualReferent: v })}
                      placeholder="e.g. the planet Earth, or: ground/dirt/soil beneath the subject"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Notes</label>
                    <DraftTextField
                      multiline
                      rows={2}
                      maxLength={800}
                      value={s.notes}
                      commitOnBlur={commitTextOnBlur}
                      onCommit={(v) => update(i, { notes: v })}
                    />
                  </div>
                  <div className="flex items-center gap-3 sm:col-span-2 flex-wrap text-xs">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={s.materiallyAffectsVisualPrompt}
                        onChange={(ev) => update(i, { materiallyAffectsVisualPrompt: ev.target.checked })}
                      />
                      Materially affects visual prompt
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={s.requiresAdminReview}
                        onChange={(ev) => update(i, { requiresAdminReview: ev.target.checked })}
                      />
                      Requires admin review
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      Confidence
                      <input
                        type="number"
                        className="w-16 px-1 py-0.5 bg-background border border-border rounded-sm"
                        min={0}
                        max={1}
                        step={0.05}
                        value={s.confidence}
                        onChange={(ev) => update(i, { confidence: Math.max(0, Math.min(1, parseFloat(ev.target.value) || 0)) })}
                      />
                    </label>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  aria-label="Remove semantic entity"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chips({
  items,
  onRemove,
  known,
}: {
  items: string[];
  onRemove: (item: string) => void;
  known?: (item: string) => boolean;
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground italic">None</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const isCustom = known ? !known(item) : false;
        return (
          <span
            key={item}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${
              isCustom
                ? "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400"
                : "bg-primary/15 border-primary/40 text-primary"
            }`}
          >
            {item}
            <button type="button" onClick={() => onRemove(item)} className="hover:opacity-70">
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Compact read-only view for already-decided reviews. */
/**
 * Per-fact enrichment staleness badge. Shows whether the stored enrichment was
 * produced under the CURRENT taxonomy/classification version — and, when stale,
 * the exact stored→current discrepancy so the admin knows a re-enrich is due.
 * Uses the shared `computeEnrichmentVersionStatus` so it agrees with the
 * Taxonomy Health evaluator. `status` can be injected for testing.
 */
export function EnrichmentStalenessBadge({
  e,
  status,
}: {
  e: Pick<FactEnrichment, "classificationPromptVersion">;
  status?: EnrichmentVersionStatus;
}) {
  const s = status ?? computeEnrichmentVersionStatus(e);
  const fields = s.fields;
  const showStale = s.enrichmentStale;

  if (!showStale) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"
        data-testid="enrichment-staleness"
        data-stale="false"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        Enrichment up to date (taxonomy {s.fields[0]?.current})
      </span>
    );
  }

  return (
    <div
      className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 space-y-1"
      data-testid="enrichment-staleness"
      data-stale="true"
    >
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
        <AlertTriangle className="w-3.5 h-3.5" />
        Enrichment is stale — re-enrich to refresh
      </span>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {fields
          .filter((f) => f.stale)
          .map((f) => (
            <span key={f.field} className="text-[10px] text-amber-700/90 dark:text-amber-300/90">
              {f.label}:{" "}
              <span className="font-mono">{f.missing ? "unversioned" : f.stored}</span>
              {" → "}
              <span className="font-mono font-semibold">{f.current}</span>
            </span>
          ))}
      </div>
    </div>
  );
}

/**
 * Provenance of the prompt that actually produced this enrichment. A "taxonomy
 * vN" badge proves the version CONSTANT, not WHICH prompt text ran — a stale or
 * debug-overridden `admin_config` prompt can diverge from the code default. This
 * line surfaces that divergence so it can't hide behind the version badge.
 */
export function PromptProvenanceLine({
  diagnostics,
}: {
  diagnostics?: FactEnrichment["classificationPromptDiagnostics"];
}) {
  if (!diagnostics) return null;
  const { source, hash, matchesCodeDefault } = diagnostics;
  const warn = source === "admin_config_debug_value" || !matchesCodeDefault;
  const label =
    source === "admin_config_debug_value"
      ? "Debug enrichment prompt active"
      : !matchesCodeDefault
        ? "Enrichment prompt differs from current code default"
        : "Enrichment prompt matches code default";
  return (
    <p
      className={`text-[11px] inline-flex items-center gap-1 ${warn ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      data-testid="enrichment-prompt-provenance"
      data-prompt-source={source}
      data-matches-code-default={String(matchesCodeDefault)}
    >
      {warn ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
      {label} <span className="font-mono">({source}, {hash})</span>
    </p>
  );
}

export function EnrichmentSummary({ e }: { e: FactEnrichment }) {
  const rows: [string, string][] = [
    ["Archetype", e.primaryArchetype],
    ["Subtype", e.subtype],
    ["Literalness", e.visualLiteralness],
    ["Complexity", e.visualComplexity],
    ["Overhype fit", e.overhypeFit],
    ["Adult", e.adultSuitability],
    ["Confidence", e.taxonomyConfidence.toFixed(2)],
  ];
  return (
    <div className="rounded-sm border border-border bg-muted/40 p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Visual Taxonomy Enrichment</p>
        <EnrichmentStalenessBadge e={e} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground">{k}: </span><span className="text-foreground font-medium">{v}</span></div>
        ))}
      </div>
      {(e.modifiers ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground">Modifiers: <span className="text-foreground">{e.modifiers.join(", ")}</span></p>
      )}
      <PromptProvenanceLine diagnostics={e.classificationPromptDiagnostics} />
      {(e.suggestedHashtags ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground">Hashtags: <span className="text-foreground">{e.suggestedHashtags.join(", ")}</span></p>
      )}
      {(e.culturalReferences ?? []).length > 0 && (
        <div className="border-t border-border pt-2 mt-2 space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Cultural references</p>
          {e.culturalReferences.map((r, i) => (
            <p key={i} className="text-xs text-foreground">
              <span className="text-muted-foreground">"{r.sourcePhrase}"</span> ({r.referenceType})
              {r.canonicalReference && <> → <span className="font-medium">{r.canonicalReference}</span></>}
              {r.requiresAdminReview && <span className="text-amber-600 dark:text-amber-400"> · review</span>}
            </p>
          ))}
        </div>
      )}
      {(e.semanticEntities ?? []).length > 0 && (
        <div className="border-t border-border pt-2 mt-2 space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Semantic entities</p>
          {(e.semanticEntities ?? []).map((s, i) => (
            <p key={i} className="text-xs text-foreground">
              <span className="text-muted-foreground">"{s.surfaceText}"</span> ({s.entityKind})
              {s.visualReferent && <> → <span className="font-medium">{s.visualReferent}</span></>}
              {s.requiresAdminReview && <span className="text-amber-600 dark:text-amber-400"> · review</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Visual Strategy Override (Phase 2) ─────────────────────────────────────

/** Small editable list of free-text rows (add / edit / remove). */
/**
 * Personalization tokens offered as one-click chips in the Visual Strategy
 * Override panel. Kept in lock-step with the api-zod allowlist
 * (`ALLOWED_SIMPLE_TOKENS` / `canonicalizeNameToken`); legend order = display
 * order. A unit test (overrideTokenChips.test) pins this to the intended set so
 * the duplicated list can't silently drift from the validator.
 */
export const OVERRIDE_TOKEN_CHIPS = [
  "{NAME}",
  "{NAME_POSSESSIVE}",
  "{SUBJ}",
  "{OBJ}",
  "{POSS}",
  "{POSS_PRO}",
  "{REFL}",
] as const;

/**
 * Insert `token` into a controlled <input>/<textarea> at the caret, replacing
 * any selected range. Writes through the element's native value setter and
 * dispatches a bubbling `input` event so React's controlled `onChange` fires
 * (running the field's existing `canonicalizeNameToken`). Restores the caret to
 * just after the inserted token on the next frame, so a re-render can't clobber
 * it. Returns false if the element can't be written (no native setter).
 */
export function insertTokenIntoTextControl(
  el: HTMLInputElement | HTMLTextAreaElement,
  token: string,
): boolean {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setValue) return false;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + token + el.value.slice(end);
  setValue.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + token.length;
  requestAnimationFrame(() => {
    try {
      el.focus();
      el.setSelectionRange(caret, caret);
    } catch {
      /* element unmounted between click and frame — nothing to restore */
    }
  });
  return true;
}

/** A tokenize-error line, styled like the other field-level warnings. */
function FieldTokenizeError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive flex items-center gap-1.5 mt-1">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {message}
    </p>
  );
}

function StringListEditor({
  docKey,
  items,
  placeholder,
  onChange,
  /** Path prefix (e.g. "requiredVisualDetails") matching
   *  `collectRenderedTextEntries`' `${pathPrefix}[i]` paths, used to look up
   *  this item's tokenize error in `fieldErrors`. */
  pathPrefix,
  fieldErrors,
  disabled = false,
}: {
  docKey: FieldDocKey;
  items: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
  pathPrefix?: string;
  fieldErrors?: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <div>
      <FieldLabel docKey={docKey} />
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i}>
            <div className="flex gap-2">
              <input
                className={SELECT_CLASS}
                data-token-insert-target="true"
                value={item}
                placeholder={placeholder}
                disabled={disabled}
                onChange={(ev) => {
                  const next = items.slice();
                  next[i] = canonicalizeNameToken(ev.target.value);
                  onChange(next);
                }}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                className="px-2 border border-border rounded-sm hover:bg-muted text-muted-foreground disabled:opacity-50"
                aria-label="Remove"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {pathPrefix && <FieldTokenizeError message={fieldErrors?.[`${pathPrefix}[${i}]`]} />}
          </div>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...items, ""])}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
    </div>
  );
}

/** Max chars for the moderator-authored core scene (mirrors the zod cap). */
export const CORE_SCENE_MAX_CHARS = 1500;

/** Max chars for a roleBindings entity label (mirrors the zod cap). */
export const ROLE_ENTITY_MAX_CHARS = 60;

/**
 * Max chars for a roleBindings visualRole (mirrors the zod cap). Up to 20
 * roles can combine, so the compiler additionally caps ROLE DETAILS' own
 * contribution (ROLE_DETAILS_MAX_CHARS in nanoBanana2.ts) so a full set of
 * near-max roles can never itself push STRICT CONSTRAINTS off the prompt.
 */
export const ROLE_VISUAL_ROLE_MAX_CHARS = 300;

/**
 * Apply a moderator-typed visual concept (core scene) to the override blob.
 * Canonicalizes name tokens and AUTO-ENABLES the override when the scene is
 * non-empty (typing a picture description must take effect without hunting for
 * the toggle) — but never auto-disables on clear, since other override fields
 * may be in use. Shared by the prominent VisualConceptCard and the panel so
 * the two surfaces can't drift.
 */
export function withCoreSceneOverride(
  ov: VisualPromptStrategyOverride | undefined,
  text: string,
): VisualPromptStrategyOverride {
  const base = ov ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const canonical = canonicalizeNameToken(text);
  return {
    ...base,
    coreSceneOverride: canonical,
    enabled: base.enabled || canonical.trim().length > 0,
  };
}

/**
 * Moderator visual-strategy override editor (Phase 2). Reads/writes
 * `enrichment.visualPromptStrategyOverride` via `onChange`. Style-agnostic,
 * token-aware (use {NAME}, {NAME_POSSESSIVE}, and pronoun tokens — one-click
 * chips insert at the caret of the focused field); the runtime compiler merges
 * these fields into the labeled prompt sections and renders tokens per render.
 */
export function VisualStrategyOverridePanel({
  value,
  onChange,
  disabled = false,
  fieldErrors,
}: {
  value: VisualPromptStrategyOverride | undefined;
  onChange: (next: VisualPromptStrategyOverride | undefined) => void;
  /** Disables every input/chip/button while a tokenize-and-save round trip is
   *  in flight, so no edit can race the batch tokenize request. */
  disabled?: boolean;
  /** Path → tokenize error for the current draft (from
   *  `useFactEnrichmentEditing`'s `vsoTokenizeErrors`), shown as a first-class
   *  red-bordered field error beside the existing token-validation warnings. */
  fieldErrors?: Record<string, string>;
}) {
  const ov: VisualPromptStrategyOverride = value ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const set = (patch: Partial<VisualPromptStrategyOverride>) => onChange({ ...ov, ...patch });

  // Token-chip insertion: track the last-focused token-capable field so a chip
  // click inserts at its caret. Excludes admin-only/non-rendered fields (they
  // never set data-token-insert-target).
  const lastFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [chipNote, setChipNote] = useState<string | null>(null);
  const onFieldFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    const t = e.target;
    if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.dataset.tokenInsertTarget === "true") {
      lastFieldRef.current = t;
      setChipNote(null);
    }
  };
  const handleChip = (token: string) => {
    const el = lastFieldRef.current;
    if (el && el.isConnected && el.dataset.tokenInsertTarget === "true") {
      insertTokenIntoTextControl(el, token);
      return;
    }
    // No token-capable field focused — copy as a graceful fallback (never a
    // silent no-op, never a thrown rejection).
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clip?.writeText) {
      clip.writeText(token).then(
        () => setChipNote(`Copied ${token} — click into a token-capable field to paste it.`),
        () => setChipNote(`Click into a token-capable field first, then click ${token}.`),
      );
    } else {
      setChipNote(`Click into a token-capable field first, then click ${token}.`);
    }
  };

  // Advisory client-side warnings (approval is the hard gate).
  const warnings: string[] = [];
  if (ov.enabled) {
    const tokenErr = firstOverrideTokenError(ov);
    if (tokenErr) warnings.push(`Invalid token: ${tokenErr}. Use {NAME}, {NAME_POSSESSIVE}, and pronoun tokens only.`);
    if (ov.roleBindings.some((b) => !b.entity.trim() || !b.visualRole.trim())) {
      warnings.push("A role binding is missing an entity or a visual role.");
    }
    if (ov.subjectRealizationOverride && ov.subjectRealizationOverride.mode !== "use_ai_plan" && !ov.subjectRealizationOverride.description.trim()) {
      warnings.push("Subject realization mode is set but its description is empty.");
    }
    if (ov.supportingTextPolicyOverride?.mode === "require" && !ov.supportingTextPolicyOverride.guidance?.trim()) {
      warnings.push('Supporting-text "require" needs guidance describing the required text.');
    }
    if (!hasRenderableVisualStrategyOverrideContent(ov)) {
      warnings.push("Override is enabled but has no renderable content — it will have no effect on the prompt.");
    }
  }

  return (
    <div className="rounded-sm border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-foreground flex items-center gap-1">
            Visual Strategy Override
            <FieldInfo docKey="vso.panel" />
          </p>
          <p className="text-xs text-muted-foreground">Moderator art-direction merged into the runtime prompt. Use {"{NAME}"}, {"{NAME_POSSESSIVE}"}, and pronoun tokens — never a real name.</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(value ? { ...ov, enabled: !ov.enabled } : { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true })}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${ov.enabled ? "bg-green-500" : "bg-muted-foreground/30"}`}
          aria-label="Toggle override"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${ov.enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>

      {ov.enabled && (
        <div className="space-y-3" onFocusCapture={onFieldFocusCapture}>
          {warnings.length > 0 && (
            <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}
          {fieldErrors?.[VSO_GENERAL_TOKENIZE_ERROR_KEY] && (
            <FieldTokenizeError message={fieldErrors[VSO_GENERAL_TOKENIZE_ERROR_KEY]} />
          )}

          {/* Token legend — click a chip to insert at the caret of the
              token-capable field you last focused (onMouseDown.preventDefault
              keeps that field focused). Admin-only fields are not targets. */}
          <div data-testid="vso-token-bar" className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">Insert token:</span>
            {OVERRIDE_TOKEN_CHIPS.map((token) => (
              <button
                key={token}
                type="button"
                data-testid="vso-token-chip"
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleChip(token)}
                className="px-1.5 py-0.5 text-[11px] font-mono rounded-sm border border-border bg-background hover:bg-muted text-foreground disabled:opacity-50"
              >
                {token}
              </button>
            ))}
          </div>
          {chipNote && <p className="text-[11px] text-muted-foreground" data-testid="vso-token-note">{chipNote}</p>}

          <div>
            <FieldLabel docKey="vso.coreSceneOverride" />
            <textarea
              className={`${SELECT_CLASS} resize-none`}
              rows={3}
              data-token-insert-target="true"
              data-testid="vso-core-scene"
              maxLength={CORE_SCENE_MAX_CHARS}
              disabled={disabled}
              value={ov.coreSceneOverride ?? ""}
              onChange={(ev) => set({ coreSceneOverride: canonicalizeNameToken(ev.target.value) })}
            />
            <p className="text-[10px] text-muted-foreground text-right">
              {(ov.coreSceneOverride ?? "").length}/{CORE_SCENE_MAX_CHARS}
            </p>
            <FieldTokenizeError message={fieldErrors?.["coreSceneOverride"]} />
          </div>

          <div>
            <FieldLabel docKey="vso.moderatorIntent" />
            <textarea
              className={`${SELECT_CLASS} resize-none`}
              rows={2}
              disabled={disabled}
              value={ov.moderatorIntent ?? ""}
              onChange={(ev) => set({ moderatorIntent: ev.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <FieldLabel docKey="vso.subjectRealization" />
              <select
                className={SELECT_CLASS}
                disabled={disabled}
                value={ov.subjectRealizationOverride?.mode ?? "use_ai_plan"}
                onChange={(ev) => {
                  const mode = ev.target.value as SubjectRealizationMode;
                  set({ subjectRealizationOverride: mode === "use_ai_plan" ? undefined : { mode, description: ov.subjectRealizationOverride?.description ?? "" } });
                }}
              >
                {SUBJECT_REALIZATION_MODE_VALUES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          {ov.subjectRealizationOverride && ov.subjectRealizationOverride.mode !== "use_ai_plan" && (
            <div>
              <FieldLabel docKey="vso.subjectRealizationDescription" />
              <textarea
                className={`${SELECT_CLASS} resize-none`}
                data-token-insert-target="true"
                rows={2}
                disabled={disabled}
                value={ov.subjectRealizationOverride.description}
                onChange={(ev) => set({ subjectRealizationOverride: { mode: ov.subjectRealizationOverride!.mode, description: canonicalizeNameToken(ev.target.value) } })}
              />
              <FieldTokenizeError message={fieldErrors?.["subjectRealizationOverride.description"]} />
            </div>
          )}

          <StringListEditor docKey="vso.requiredVisualDetails" items={ov.requiredVisualDetails} placeholder="e.g. {NAME}'s recognizable face on a newborn body" onChange={(next) => set({ requiredVisualDetails: next })} pathPrefix="requiredVisualDetails" fieldErrors={fieldErrors} disabled={disabled} />
          <StringListEditor docKey="vso.forbiddenVisualDetails" items={ov.forbiddenVisualDetails} placeholder="e.g. a separate adult version of the subject" onChange={(next) => set({ forbiddenVisualDetails: next })} pathPrefix="forbiddenVisualDetails" fieldErrors={fieldErrors} disabled={disabled} />

          <div>
            <FieldLabel docKey="vso.roleBindings" />
            <div className="space-y-1.5">
              {ov.roleBindings.map((b, i) => (
                <div key={i}>
                  <div className="flex gap-2 items-start">
                    <div className="max-w-[8rem]">
                      <input
                        className={SELECT_CLASS}
                        value={b.entity}
                        placeholder="subject or role label"
                        maxLength={ROLE_ENTITY_MAX_CHARS}
                        disabled={disabled}
                        onChange={(ev) => {
                          // Deliberately NOT a chip target and NOT canonicalized —
                          // entity is a plain "subject"/role label; a typed
                          // personalization token is an error Save surfaces
                          // (tokenizeAndSaveVisualOverride → normalizeRoleEntity),
                          // not something to silently rewrite here.
                          const next = ov.roleBindings.slice(); next[i] = { ...b, entity: ev.target.value }; set({ roleBindings: next });
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <input
                        className={SELECT_CLASS}
                        data-token-insert-target="true"
                        value={b.visualRole}
                        placeholder="concrete visible role"
                        maxLength={ROLE_VISUAL_ROLE_MAX_CHARS}
                        disabled={disabled}
                        onChange={(ev) => {
                          const next = ov.roleBindings.slice(); next[i] = { ...b, visualRole: canonicalizeNameToken(ev.target.value) }; set({ roleBindings: next });
                        }}
                      />
                      <p className="text-[10px] text-muted-foreground text-right">
                        {b.visualRole.length}/{ROLE_VISUAL_ROLE_MAX_CHARS}
                      </p>
                    </div>
                    <button type="button" disabled={disabled} onClick={() => set({ roleBindings: ov.roleBindings.filter((_, idx) => idx !== i) })} className="px-2 border border-border rounded-sm hover:bg-muted text-muted-foreground disabled:opacity-50" aria-label="Remove"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <FieldTokenizeError message={fieldErrors?.[`roleBindings[${i}].entity`]} />
                  <FieldTokenizeError message={fieldErrors?.[`roleBindings[${i}].visualRole`]} />
                </div>
              ))}
              <button type="button" disabled={disabled} onClick={() => set({ roleBindings: [...ov.roleBindings, { entity: "", visualRole: "" } as VisualStrategyRoleBinding] })} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"><Plus className="w-3 h-3" /> Add role</button>
            </div>
          </div>

          <StringListEditor docKey="vso.compositionGuidance" items={ov.compositionGuidance} onChange={(next) => set({ compositionGuidance: next })} pathPrefix="compositionGuidance" fieldErrors={fieldErrors} disabled={disabled} />
          <StringListEditor docKey="vso.styleAgnosticPromptAdditions" items={ov.styleAgnosticPromptAdditions} onChange={(next) => set({ styleAgnosticPromptAdditions: next })} pathPrefix="styleAgnosticPromptAdditions" fieldErrors={fieldErrors} disabled={disabled} />
          <StringListEditor docKey="vso.negativePromptAdditions" items={ov.negativePromptAdditions} placeholder='becomes a "Do not …" constraint' onChange={(next) => set({ negativePromptAdditions: next })} pathPrefix="negativePromptAdditions" fieldErrors={fieldErrors} disabled={disabled} />

          {/* Supporting-text policy override */}
          <div className="rounded-sm border border-border p-2 space-y-2">
            <div className="flex items-center gap-1">
              <label className="text-xs font-semibold inline-flex items-center gap-1.5">
                <input type="checkbox" disabled={disabled} checked={!!ov.supportingTextPolicyOverride} onChange={(ev) => set({ supportingTextPolicyOverride: ev.target.checked ? { mode: "allow" } : undefined })} />
                Override supporting-text policy
              </label>
              <FieldInfo docKey="vso.supportingTextPolicy" />
            </div>
            {ov.supportingTextPolicyOverride && (
              <div className="space-y-2">
                <select className={SELECT_CLASS} disabled={disabled} value={ov.supportingTextPolicyOverride.mode} onChange={(ev) => set({ supportingTextPolicyOverride: { ...ov.supportingTextPolicyOverride!, mode: ev.target.value as (typeof SUPPORTING_TEXT_MODE_VALUES)[number] } })}>
                  {SUPPORTING_TEXT_MODE_VALUES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input className={SELECT_CLASS} data-token-insert-target="true" disabled={disabled} placeholder='guidance (e.g. a TV title reading "{NAME} Week")' value={ov.supportingTextPolicyOverride.guidance ?? ""} onChange={(ev) => set({ supportingTextPolicyOverride: { ...ov.supportingTextPolicyOverride!, guidance: canonicalizeNameToken(ev.target.value) } })} />
                <FieldTokenizeError message={fieldErrors?.["supportingTextPolicyOverride.guidance"]} />
              </div>
            )}
          </div>

          {/* Violence policy override */}
          <div className="rounded-sm border border-border p-2 space-y-2">
            <div className="flex items-center gap-1">
              <label className="text-xs font-semibold inline-flex items-center gap-1.5">
                <input type="checkbox" disabled={disabled} checked={!!ov.violencePolicyOverride} onChange={(ev) => set({ violencePolicyOverride: ev.target.checked ? { mode: "allow", intensity: "strong" } : undefined })} />
                Override violence policy
              </label>
              <FieldInfo docKey="vso.violencePolicy" />
            </div>
            {ov.violencePolicyOverride && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <select className={SELECT_CLASS} disabled={disabled} value={ov.violencePolicyOverride.mode} onChange={(ev) => set({ violencePolicyOverride: { ...ov.violencePolicyOverride!, mode: ev.target.value as (typeof VIOLENCE_MODE_VALUES)[number] } })}>
                    {VIOLENCE_MODE_VALUES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select className={SELECT_CLASS} disabled={disabled} value={ov.violencePolicyOverride.intensity} onChange={(ev) => set({ violencePolicyOverride: { ...ov.violencePolicyOverride!, intensity: ev.target.value as (typeof VIOLENCE_INTENSITY_VALUES)[number] } })}>
                    {VIOLENCE_INTENSITY_VALUES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <input className={SELECT_CLASS} data-token-insert-target="true" disabled={disabled} placeholder="guidance (e.g. visible bodies, non-gratuitous)" value={ov.violencePolicyOverride.guidance ?? ""} onChange={(ev) => set({ violencePolicyOverride: { ...ov.violencePolicyOverride!, guidance: canonicalizeNameToken(ev.target.value) } })} />
                <FieldTokenizeError message={fieldErrors?.["violencePolicyOverride.guidance"]} />
              </div>
            )}
          </div>

          {(ov.updatedBy || ov.updatedAt) && (
            <p className="text-xs text-muted-foreground">Last edited{ov.updatedBy ? ` by ${ov.updatedBy}` : ""}{ov.updatedAt ? ` · ${new Date(ov.updatedAt).toLocaleString()}` : ""}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function EnrichmentEditor({
  value,
  status,
  factText,
  onChange,
  onSave,
  onRerun,
  busy = false,
  rerunBusy = false,
  finalHashtags,
  onFinalHashtagsChange,
  hideHashtags = false,
  overrideContext,
  vsoTokenizing = false,
  vsoTokenizeErrors,
}: {
  value: FactEnrichment | null;
  status: string | null;
  /** Source fact text — used by the per-row "Research Reference" tool. */
  factText?: string;
  onChange: (next: FactEnrichment) => void;
  onSave?: () => void;
  onRerun?: () => void;
  busy?: boolean;
  rerunBusy?: boolean;
  /** Review mode only: the moderator's curated FINAL discovery-tag list (what
   * ships on approval), seeded by the caller from the submitter's tags. When
   * `onFinalHashtagsChange` is provided the hashtag UI becomes the final-list
   * editor + AI source chips; otherwise the editable AI suggestedHashtags editor
   * is shown (the live Facts page). */
  finalHashtags?: string[];
  onFinalHashtagsChange?: (tags: string[]) => void;
  /** Suppress the hashtag section entirely. The moderation panel now renders the
   * final-hashtags editor as its own first-class section (FinalHashtagsEditor in
   * the Visual review step), so it hides this editor's copy to avoid a second,
   * redundant hashtag control. */
  hideHashtags?: boolean;
  overrideContext?: EnrichmentOverrideContext;
  /** True while a Visual-Concept-authoring batch tokenize round trip is in
   *  flight — disables the Visual Strategy Override panel on top of `busy`. */
  vsoTokenizing?: boolean;
  /** Path → tokenize error for the current draft (from
   *  `useFactEnrichmentEditing`'s `vsoTokenizeErrors`). */
  vsoTokenizeErrors?: Record<string, string>;
}) {
  const e = value ? { ...EMPTY_ENRICHMENT, ...value } : EMPTY_ENRICHMENT;
  const [modifierInput, setModifierInput] = useState("");
  const [hashtagInput, setHashtagInput] = useState("");
  const [finalHashtagInput, setFinalHashtagInput] = useState("");

  // Review mode = the moderator curates the final list; the AI suggestedHashtags
  // become a source to pull from, not the thing that ships.
  const reviewMode = !!onFinalHashtagsChange;
  const finalTags = finalHashtags ?? [];
  const addFinalHashtag = (raw: string) => {
    const h = normalizeHashtag(raw);
    if (h && !finalTags.includes(h)) onFinalHashtagsChange?.([...finalTags, h]);
    setFinalHashtagInput("");
  };
  const removeFinalHashtag = (h: string) => onFinalHashtagsChange?.(finalTags.filter((x) => x !== h));
  const aiSuggestionsNotInFinal = e.suggestedHashtags.filter((t) => !finalTags.includes(t));

  const update = (patch: Partial<FactEnrichment>) => onChange({ ...e, ...patch });

  // Override mode is active only when a baseline is available (live Facts page).
  const oc = overrideContext && overrideContext.aiDerived ? overrideContext : null;

  /** Tracked-field write: optimistically reflect the change in the local draft
   * for instant feedback, and (in override mode) persist it through the override
   * endpoints. Free-text inputs inside the array editors buffer locally and
   * commit on blur (DraftTextField), so in override mode this fires once per
   * completed edit — never mid-typing. Structural edits (selects, checkboxes,
   * add/remove row) persist immediately. In the review/approval flow it is just
   * a normal draft edit. */
  const setTracked = (path: OverridablePath, value: unknown, patch: Partial<FactEnrichment>) => {
    update(patch);
    if (oc) oc.onOverride(path, value);
  };

  /** Render the per-field override decoration (nothing in review mode). */
  const mark = (path: OverridablePath) => {
    if (!oc) return null;
    const field = path.slice(1) as keyof FactEnrichment;
    return (
      <OverrideMark
        path={path}
        aiNow={(oc.aiDerived as FactEnrichment)[field]}
        override={oc.overrides[path]}
        baselineChanged={oc.summary.baselineChangedPaths.includes(path)}
        decoration={OVERRIDABLE_PATHS[path].decoration}
        status={oc.pending[path]}
        onReset={() => oc.onReset(path)}
        onAcknowledge={() => oc.onAcknowledge(path, oc.overrides[path]?.value)}
      />
    );
  };

  const setArchetype = (archetype: PrimaryArchetype) => {
    const allowed = SUBTYPES_BY_ARCHETYPE[archetype];
    const nextSubtype = (allowed as readonly string[]).includes(e.subtype) ? e.subtype : allowed[0];
    // Optimistic local update; in override mode the server auto-links a
    // compatible subtype and the reconciled effective is folded back in.
    onChange({ ...e, primaryArchetype: archetype, subtype: nextSubtype });
    if (oc) oc.onOverride("/primaryArchetype", archetype);
  };

  const addModifier = () => {
    const m = modifierInput.trim();
    if (m && !e.modifiers.includes(m)) {
      const next = [...e.modifiers, m];
      update({ modifiers: next });
      if (oc) oc.onOverride("/modifiers", next);
    }
    setModifierInput("");
  };
  const addHashtag = () => {
    const h = normalizeHashtag(hashtagInput);
    if (h && !e.suggestedHashtags.includes(h)) update({ suggestedHashtags: [...e.suggestedHashtags, h] });
    setHashtagInput("");
  };

  const validity = validateEnrichment(e);
  // The schema's role-entity token backstop (`roleBindings[i].entity` carrying
  // a `{…}` token) is the ONE validity error that Save can fix by itself — it
  // routes through tokenizeAndSaveVisualOverride, which blocks persistence and
  // red-borders that row on its own if the token is still there after
  // tokenizing. Save must NOT hard-disable on it, or the "click Save → shown
  // as blocked" flow could never run. Every other error (unknown/malformed
  // tokens in prose, VSO caps/enums, any non-VSO enrichment failure) still
  // disables Save — this filter is intentionally narrow, matching only this
  // exact schema issue, never a broad `visualPromptStrategyOverride:` prefix.
  const nonFixableValidityErrors = validity.ok
    ? []
    : validity.error.split("; ").filter((err) => !isFixableRoleEntityTokenIssue(err));
  const subtypeOptions = SUBTYPES_BY_ARCHETYPE[e.primaryArchetype] as readonly string[];

  return (
    <div className="rounded-sm border-2 border-border bg-background p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">AI Visual Classification</p>
        <div className="flex items-center gap-2 flex-wrap">
          {value && <EnrichmentStalenessBadge e={value} />}
          {status === "pending" || rerunBusy ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              Classifying…
            </span>
          ) : status ? (
            <span className="text-xs text-muted-foreground">
              status: <strong className={status === "failed" ? "text-destructive" : "text-foreground"}>{status}</strong>
            </span>
          ) : null}
          {onRerun && (
            <button
              type="button"
              onClick={onRerun}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${rerunBusy ? "animate-spin" : ""}`} />
              {rerunBusy ? "Running…" : "Re-run classification"}
            </button>
          )}
        </div>
      </div>

      {!value && status !== "ok" && (
        <div className="rounded-sm border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {status === "pending"
            ? "AI enrichment is still running — refresh in a moment, or fill the fields below manually."
            : "No AI enrichment available. Re-run it, or fill the fields below manually before approving."}
        </div>
      )}

      <Warnings e={e} />

      {oc && (oc.summary.overriddenPaths.length > 0 || oc.summary.hasVisualStrategyOverride) && (
        <div className="rounded-sm border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground flex items-center gap-x-2 gap-y-1 flex-wrap">
          <span className="font-semibold text-primary">Overridden:</span>
          <span>
            {[
              ...oc.summary.overriddenPaths.map((p) => {
                const key = PATH_TO_DOC_KEY[p as OverridablePath];
                return key ? fieldLabel(key) : p;
              }),
              ...(oc.summary.hasVisualStrategyOverride ? ["Visual Strategy"] : []),
            ].join(", ")}
          </span>
          {oc.summary.baselineChangedPaths.length > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold">
              · {oc.summary.baselineChangedPaths.length} need{oc.summary.baselineChangedPaths.length === 1 ? "s" : ""} review
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel docKey="primaryArchetype" />
          <select className={SELECT_CLASS} value={e.primaryArchetype} onChange={(ev) => setArchetype(ev.target.value as PrimaryArchetype)}>
            {PRIMARY_ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {mark("/primaryArchetype")}
        </div>
        <div>
          <FieldLabel docKey="subtype" />
          <select className={SELECT_CLASS} value={e.subtype} onChange={(ev) => setTracked("/subtype", ev.target.value, { subtype: ev.target.value as FactEnrichment["subtype"] })}>
            {subtypeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {mark("/subtype")}
        </div>
        <div>
          <FieldLabel docKey="visualLiteralness" />
          <select className={SELECT_CLASS} value={e.visualLiteralness} onChange={(ev) => setTracked("/visualLiteralness", ev.target.value, { visualLiteralness: ev.target.value as FactEnrichment["visualLiteralness"] })}>
            {VISUAL_LITERALNESS_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {mark("/visualLiteralness")}
        </div>
        <div>
          <FieldLabel docKey="visualComplexity" />
          <select className={SELECT_CLASS} value={e.visualComplexity} onChange={(ev) => setTracked("/visualComplexity", ev.target.value, { visualComplexity: ev.target.value as FactEnrichment["visualComplexity"] })}>
            {VISUAL_COMPLEXITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {mark("/visualComplexity")}
        </div>
        <div>
          <FieldLabel docKey="overhypeFit" />
          <select className={SELECT_CLASS} value={e.overhypeFit} onChange={(ev) => setTracked("/overhypeFit", ev.target.value, { overhypeFit: ev.target.value as FactEnrichment["overhypeFit"] })}>
            {OVERHYPE_FIT_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {mark("/overhypeFit")}
        </div>
        <div>
          <FieldLabel docKey="adultSuitability" />
          <select className={SELECT_CLASS} value={e.adultSuitability} onChange={(ev) => setTracked("/adultSuitability", ev.target.value, { adultSuitability: ev.target.value as FactEnrichment["adultSuitability"] })}>
            {ADULT_SUITABILITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {mark("/adultSuitability")}
        </div>
      </div>

      <div>
        <FieldLabel docKey="adultSuitabilityNotes" />
        <DraftTextField
          multiline
          rows={2}
          maxLength={500}
          value={e.adultSuitabilityNotes}
          commitOnBlur={!!oc}
          onCommit={(v) => setTracked("/adultSuitabilityNotes", v, { adultSuitabilityNotes: v })}
        />
        {mark("/adultSuitabilityNotes")}
      </div>

      <div>
        <FieldLabel docKey="modifiers" />
        <Chips items={e.modifiers} known={isKnownModifier} onRemove={(m) => setTracked("/modifiers", e.modifiers.filter((x) => x !== m), { modifiers: e.modifiers.filter((x) => x !== m) })} />
        {mark("/modifiers")}
        <div className="flex gap-2 mt-2">
          <input
            list="known-modifiers"
            className={SELECT_CLASS}
            placeholder="Add modifier…"
            value={modifierInput}
            onChange={(ev) => setModifierInput(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addModifier(); } }}
          />
          <datalist id="known-modifiers">
            {KNOWN_FACT_MODIFIERS.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button type="button" onClick={addModifier} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
        </div>
      </div>

      {hideHashtags ? null : reviewMode ? (
        <div className="space-y-3">
          {/* Final hashtags — the moderator-curated list that ships on approval. */}
          <div>
            <FieldLabel docKey="finalHashtags" />
            {finalTags.length === 0 ? (
              <p className="text-xs text-destructive flex items-center gap-1.5 mb-2" data-testid="final-hashtags-empty-warning">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Add at least one hashtag — a fact can't be approved without tags. Clearing them all is usually a mistake.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mb-2">
                The submitter's edited tags, ready for review. Remove or add as you see fit.
              </p>
            )}
            <Chips items={finalTags} onRemove={removeFinalHashtag} />
            <div className="flex gap-2 mt-2">
              <input
                className={SELECT_CLASS}
                placeholder="Add hashtag…"
                value={finalHashtagInput}
                onChange={(ev) => setFinalHashtagInput(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addFinalHashtag(finalHashtagInput); } }}
              />
              <button type="button" onClick={() => addFinalHashtag(finalHashtagInput)} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-1.5">
              Subject names and the app's own tag are removed automatically on approval. At least one tag is required.
            </p>
          </div>

          {/* AI suggested — a source the moderator can pull from (not what ships). */}
          {aiSuggestionsNotInFinal.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <FieldLabel docKey="aiSuggestedHashtags" className="mb-0" />
                <button
                  type="button"
                  onClick={() => onFinalHashtagsChange?.(Array.from(new Set([...finalTags, ...aiSuggestionsNotInFinal])))}
                  className="text-xs text-primary hover:underline"
                >
                  Add all
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {aiSuggestionsNotInFinal.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border bg-muted/60 border-border text-muted-foreground">
                    {tag}
                    <button
                      type="button"
                      title="Add to final hashtags"
                      onClick={() => addFinalHashtag(tag)}
                      className="hover:text-primary transition-colors"
                    >
                      +
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <FieldLabel docKey="suggestedHashtags" />
          <Chips items={e.suggestedHashtags} onRemove={(h) => update({ suggestedHashtags: e.suggestedHashtags.filter((x) => x !== h) })} />
          <div className="flex gap-2 mt-2">
            <input
              className={SELECT_CLASS}
              placeholder="Add hashtag…"
              value={hashtagInput}
              onChange={(ev) => setHashtagInput(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addHashtag(); } }}
            />
            <button type="button" onClick={addHashtag} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
          </div>
          {!validity.ok && validity.error.split("; ").filter((err) => err.startsWith("suggestedHashtags:")).map((err) => (
            <p key={err} className="text-xs text-destructive flex items-center gap-1.5 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {err.replace(/^suggestedHashtags: /, "")}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel docKey="taxonomyConfidence" />
          <p className="text-sm text-foreground">{e.taxonomyConfidence.toFixed(2)}</p>
        </div>
      </div>

      <div>
        <FieldLabel docKey="adminReviewNotes" />
        <DraftTextField
          multiline
          rows={2}
          maxLength={800}
          value={e.adminReviewNotes}
          commitOnBlur={!!oc}
          onCommit={(v) => setTracked("/adminReviewNotes", v, { adminReviewNotes: v })}
        />
        {mark("/adminReviewNotes")}
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">Visual Strategy Overrides</p>
        <VisualStrategyOverridePanel
          value={e.visualPromptStrategyOverride}
          onChange={(next) => update({ visualPromptStrategyOverride: next })}
          disabled={busy || vsoTokenizing}
          fieldErrors={vsoTokenizeErrors}
        />
      </div>

      <p className="text-sm font-bold text-foreground uppercase tracking-wide border-t border-border pt-4">
        References &amp; Scene Entities
      </p>
      <div>
        <CulturalReferencesEditor
          refs={e.culturalReferences}
          factText={factText ?? ""}
          onChange={(next) => setTracked("/culturalReferences", next, { culturalReferences: next })}
          commitTextOnBlur={!!oc}
        />
        {mark("/culturalReferences")}
      </div>

      <div>
        <SemanticEntitiesEditor
          entities={e.semanticEntities ?? []}
          onChange={(next) => setTracked("/semanticEntities", next, { semanticEntities: next })}
          commitTextOnBlur={!!oc}
        />
        {mark("/semanticEntities")}
      </div>

      <div className="rounded-sm border border-border bg-muted/20 p-3 text-xs text-muted-foreground leading-snug">
        This editor sets the <span className="font-semibold text-foreground">meaning</span> (taxonomy, cultural
        references, semantic entities) and optional <span className="font-semibold text-foreground">art direction</span>{" "}
        (Visual Strategy Override). To see what the image will actually be, use the{" "}
        <span className="font-semibold text-foreground">Prompt Diagnostics</span> panel and the visual-review test renders —
        it is the single source of truth for the rendered prompt and reflects this enrichment and any override. Approval
        requires those required test renders to be fresh and successful (or explicitly waived) — that is the renderability gate.
      </div>

      {nonFixableValidityErrors.filter((err) => !err.startsWith("suggestedHashtags:")).length > 0 && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {nonFixableValidityErrors.filter((err) => !err.startsWith("suggestedHashtags:")).join("; ")}
        </p>
      )}

      {onSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={busy || vsoTokenizing || nonFixableValidityErrors.length > 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" /> {vsoTokenizing ? "Tokenizing and saving…" : "Save enrichment"}
        </button>
      )}
    </div>
  );
}

/**
 * True when an enrichment is ready to approve — used by the moderation page
 * to gate the Approve / Approve-as-Variant buttons. Renderability is gated
 * SERVER-side by the required-render check at approval time (the required test
 * renders must be fresh + successful, or waived); the client gate here only
 * requires a valid enrichment.
 */
export function isApprovable(enrichment: FactEnrichment | null | undefined): boolean {
  if (!enrichment) return false;
  return validateEnrichment(enrichment).ok;
}
