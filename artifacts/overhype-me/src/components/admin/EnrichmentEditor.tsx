import { useState } from "react";
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
  hasUsableVisualPreview,
  PREVIEW_GENERATION_MODE,
  PREVIEW_STYLE,
  type FactEnrichment,
  type CulturalReference,
  type VisualPromptPreview,
  type ReferenceType,
  type PrimaryArchetype,
  type SemanticEntity,
  type SemanticEntityKind,
  type CapitalizationSignal,
  SEMANTIC_ENTITY_KIND_VALUES,
  CAPITALIZATION_SIGNAL_VALUES,
} from "@workspace/api-zod";
import { AlertTriangle, RefreshCw, Save, X, Eye, Plus, Trash2, Search, Loader2, Sparkles, ExternalLink } from "lucide-react";

// ─── Forbidden-text heuristic ───────────────────────────────────────────────
//
// Per the Phase 2A supporting-text policy, ALL readable text isn't forbidden —
// only specific categories (full captions, full fact text, hashtags, watermarks,
// logos, brand marks, long paragraphs) are. This regex flags only the forbidden
// signals so the admin sees a warning when the preview leans on something it
// shouldn't.
const FORBIDDEN_TEXT_RE = /\b(watermark|logo|brand[\s-]?(?:name|mark)|full[\s-]?(?:caption|fact|text)|hashtag|paragraph|prose)\b/i;

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

const SELECT_CLASS =
  "w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";
const LABEL_CLASS = "block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1";

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
  const preview = e.visualPromptPreview;
  if (preview) {
    const promptBody = [preview.exampleI2iPrompt, preview.exampleT2iPrompt, preview.engineNeutralVisualPlan].join(" ");
    if (FORBIDDEN_TEXT_RE.test(promptBody)) {
      warnings.push("Preview may render forbidden text (logos / watermarks / hashtags / full text / long paragraphs)");
    }
    // Generic-vs-reference: if cultural refs exist, at least one of them should
    // surface in the preview's culturalReferencesUsed OR in the scene text.
    if (e.culturalReferences.length > 0) {
      const referenceMentions = new Set((preview.culturalReferencesUsed ?? []).map((s) => s.toLowerCase()));
      const sceneText = `${preview.sceneConcept} ${preview.archetypeApplication} ${preview.visualApproach}`.toLowerCase();
      const anyMatched = e.culturalReferences.some((r) =>
        referenceMentions.has(r.sourcePhrase.toLowerCase()) ||
        (r.sourcePhrase && sceneText.includes(r.sourcePhrase.toLowerCase())) ||
        (r.canonicalReference && sceneText.includes(r.canonicalReference.toLowerCase()))
      );
      if (!anyMatched) warnings.push("Preview seems generic — none of the cultural references appear in the scene");
    }
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

function emptyVisualPreview(): VisualPromptPreview {
  return {
    archetypeApplication: "",
    selectedFrame: "",
    sceneConcept: "",
    visualGoal: "",
    visualApproach: "",
    keyVisualElements: [],
    engineNeutralVisualPlan: "",
    exampleI2iPrompt: "",
    exampleT2iPrompt: "",
    promptGuardrailsPreview: "",
    supportingTextPolicy: { allowed: [], forbidden: [], notes: "" },
    culturalReferencesUsed: [],
    interpretationWarnings: [],
    previewAssumptions: {
      sampleName: "David",
      generationMode: PREVIEW_GENERATION_MODE,
      style: PREVIEW_STYLE,
      preserveFace: true,
      preservePhysique: false,
    },
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
}: {
  refs: CulturalReference[];
  factText: string;
  onChange: (next: CulturalReference[]) => void;
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
        <label className={LABEL_CLASS}>Cultural / Inside References</label>
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
                    <input
                      className={SELECT_CLASS}
                      value={r.sourcePhrase}
                      onChange={(ev) => update(i, { sourcePhrase: ev.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Reference type</label>
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
                    <input
                      className={SELECT_CLASS}
                      value={r.canonicalReference}
                      onChange={(ev) => update(i, { canonicalReference: ev.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Explanation</label>
                    <textarea
                      className={`${SELECT_CLASS} resize-none`}
                      rows={2}
                      maxLength={800}
                      value={r.explanation}
                      onChange={(ev) => update(i, { explanation: ev.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Visual implication</label>
                    <textarea
                      className={`${SELECT_CLASS} resize-none`}
                      rows={2}
                      maxLength={800}
                      value={r.visualImplication}
                      onChange={(ev) => update(i, { visualImplication: ev.target.value })}
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
}: {
  entities: SemanticEntity[];
  onChange: (next: SemanticEntity[]) => void;
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
        <label className={LABEL_CLASS}>Semantic Entities / Visual Referents</label>
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
                    <input
                      className={SELECT_CLASS}
                      value={s.surfaceText}
                      onChange={(ev) => update(i, { surfaceText: ev.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Normalized text</label>
                    <input
                      className={SELECT_CLASS}
                      value={s.normalizedText}
                      onChange={(ev) => update(i, { normalizedText: ev.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Entity kind</label>
                    <select
                      className={SELECT_CLASS}
                      value={s.entityKind}
                      onChange={(ev) => update(i, { entityKind: ev.target.value as SemanticEntityKind })}
                    >
                      {SEMANTIC_ENTITY_KIND_VALUES.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Capitalization signal</label>
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
                    <input
                      className={SELECT_CLASS}
                      value={s.visualReferent}
                      onChange={(ev) => update(i, { visualReferent: ev.target.value })}
                      placeholder="e.g. the planet Earth, or: ground/dirt/soil beneath the subject"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={LABEL_CLASS}>Notes</label>
                    <textarea
                      className={`${SELECT_CLASS} resize-none`}
                      rows={2}
                      maxLength={800}
                      value={s.notes}
                      onChange={(ev) => update(i, { notes: ev.target.value })}
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

/**
 * Visual interpretation preview editor (Phase 2A). Narrative fields are
 * editable; previewAssumptions stays literal (the generator owns those).
 * The list editors (keyVisualElements, supportingTextPolicy.allowed/forbidden,
 * culturalReferencesUsed, interpretationWarnings) are stored as
 * newline-separated text in textareas for ease of editing.
 */
function VisualPreviewPanel({
  preview,
  onChange,
  onRegenerate,
  busy,
  previewBusy,
}: {
  preview: VisualPromptPreview | undefined;
  onChange: (next: VisualPromptPreview) => void;
  onRegenerate?: () => void;
  busy?: boolean;
  previewBusy?: boolean;
}) {
  const p = preview ?? emptyVisualPreview();
  const update = (patch: Partial<VisualPromptPreview>) => onChange({ ...p, ...patch });
  const linesOf = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  return (
    <div className="rounded-sm border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5" /> Visual Interpretation Preview
        </p>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${previewBusy ? "animate-spin" : ""}`} />
            {previewBusy ? "Regenerating…" : "Regenerate preview"}
          </button>
        )}
      </div>

      {!preview && (
        <p className="text-xs text-muted-foreground italic">
          No preview yet. Click "Regenerate preview" once enrichment is saved, or fill the fields below by hand before approving.
        </p>
      )}

      <div>
        <label className={LABEL_CLASS}>Archetype application</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
          value={p.archetypeApplication}
          onChange={(ev) => update({ archetypeApplication: ev.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Selected frame</label>
          <input className={SELECT_CLASS}
            value={p.selectedFrame}
            onChange={(ev) => update({ selectedFrame: ev.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>Scene concept</label>
          <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
            value={p.sceneConcept}
            onChange={(ev) => update({ sceneConcept: ev.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Visual goal</label>
          <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
            value={p.visualGoal}
            onChange={(ev) => update({ visualGoal: ev.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>Visual approach</label>
          <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
            value={p.visualApproach}
            onChange={(ev) => update({ visualApproach: ev.target.value })}
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Key visual elements (one per line)</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={3}
          value={(p.keyVisualElements ?? []).join("\n")}
          onChange={(ev) => update({ keyVisualElements: linesOf(ev.target.value) })}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Engine-neutral visual plan</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={3}
          value={p.engineNeutralVisualPlan}
          onChange={(ev) => update({ engineNeutralVisualPlan: ev.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Preview-only example I2I prompt</label>
          <textarea className={`${SELECT_CLASS} resize-none font-mono text-xs`} rows={4}
            value={p.exampleI2iPrompt}
            onChange={(ev) => update({ exampleI2iPrompt: ev.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>Preview-only example T2I prompt</label>
          <textarea className={`${SELECT_CLASS} resize-none font-mono text-xs`} rows={4}
            value={p.exampleT2iPrompt}
            onChange={(ev) => update({ exampleT2iPrompt: ev.target.value })}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        This is an admin preview generated during taxonomy enrichment. It is not the final image-engine prompt.
        Use <span className="font-semibold">Runtime Compiled Prompt Preview</span> (on the Facts admin page) to inspect
        the actual prompt that would be sent to Nano Banana for a selected render context.
      </p>

      <div>
        <label className={LABEL_CLASS}>Prompt guardrails preview</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
          value={p.promptGuardrailsPreview}
          onChange={(ev) => update({ promptGuardrailsPreview: ev.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Supporting text — allowed (one per line)</label>
          <textarea className={`${SELECT_CLASS} resize-none`} rows={3}
            value={(p.supportingTextPolicy?.allowed ?? []).join("\n")}
            onChange={(ev) =>
              update({ supportingTextPolicy: { ...p.supportingTextPolicy, allowed: linesOf(ev.target.value) } })
            }
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>Supporting text — forbidden (one per line)</label>
          <textarea className={`${SELECT_CLASS} resize-none`} rows={3}
            value={(p.supportingTextPolicy?.forbidden ?? []).join("\n")}
            onChange={(ev) =>
              update({ supportingTextPolicy: { ...p.supportingTextPolicy, forbidden: linesOf(ev.target.value) } })
            }
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Cultural references used (sourcePhrases, one per line)</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
          value={(p.culturalReferencesUsed ?? []).join("\n")}
          onChange={(ev) => update({ culturalReferencesUsed: linesOf(ev.target.value) })}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Interpretation warnings (one per line)</label>
        <textarea className={`${SELECT_CLASS} resize-none`} rows={2}
          value={(p.interpretationWarnings ?? []).join("\n")}
          onChange={(ev) => update({ interpretationWarnings: linesOf(ev.target.value) })}
        />
      </div>
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
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Visual Taxonomy Enrichment</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground">{k}: </span><span className="text-foreground font-medium">{v}</span></div>
        ))}
      </div>
      {(e.modifiers ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground">Modifiers: <span className="text-foreground">{e.modifiers.join(", ")}</span></p>
      )}
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
      {e.visualPromptPreview && (
        <div className="border-t border-border pt-2 mt-2 space-y-1">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Eye className="w-3 h-3" /> Visual preview
          </p>
          <p className="text-xs text-foreground"><span className="text-muted-foreground">Scene: </span>{e.visualPromptPreview.sceneConcept}</p>
          <p className="text-xs text-foreground"><span className="text-muted-foreground">Frame: </span>{e.visualPromptPreview.selectedFrame}</p>
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">Preview-only example I2I / T2I prompts</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-foreground bg-background border border-border rounded-sm p-2">
{`i2i: ${e.visualPromptPreview.exampleI2iPrompt}\n\nt2i: ${e.visualPromptPreview.exampleT2iPrompt}`}
            </pre>
          </details>
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
  onRegeneratePreview,
  busy = false,
  rerunBusy = false,
  previewBusy = false,
  submittedHashtags = [],
}: {
  value: FactEnrichment | null;
  status: string | null;
  /** Source fact text — used by the per-row "Research Reference" tool. */
  factText?: string;
  onChange: (next: FactEnrichment) => void;
  onSave?: () => void;
  onRerun?: () => void;
  onRegeneratePreview?: () => void;
  busy?: boolean;
  rerunBusy?: boolean;
  previewBusy?: boolean;
  submittedHashtags?: string[];
}) {
  const e = value ? { ...EMPTY_ENRICHMENT, ...value } : EMPTY_ENRICHMENT;
  const [modifierInput, setModifierInput] = useState("");
  const [hashtagInput, setHashtagInput] = useState("");

  const update = (patch: Partial<FactEnrichment>) => onChange({ ...e, ...patch });

  const setArchetype = (archetype: PrimaryArchetype) => {
    const allowed = SUBTYPES_BY_ARCHETYPE[archetype];
    const nextSubtype = (allowed as readonly string[]).includes(e.subtype) ? e.subtype : allowed[0];
    onChange({ ...e, primaryArchetype: archetype, subtype: nextSubtype });
  };

  const addModifier = () => {
    const m = modifierInput.trim();
    if (m && !e.modifiers.includes(m)) update({ modifiers: [...e.modifiers, m] });
    setModifierInput("");
  };
  const addHashtag = () => {
    const h = normalizeHashtag(hashtagInput);
    if (h && !e.suggestedHashtags.includes(h)) update({ suggestedHashtags: [...e.suggestedHashtags, h] });
    setHashtagInput("");
  };

  const validity = validateEnrichment(e);
  const subtypeOptions = SUBTYPES_BY_ARCHETYPE[e.primaryArchetype] as readonly string[];

  return (
    <div className="rounded-sm border-2 border-border bg-background p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">Visual Taxonomy Enrichment</p>
        <div className="flex items-center gap-2">
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Primary Archetype</label>
          <select className={SELECT_CLASS} value={e.primaryArchetype} onChange={(ev) => setArchetype(ev.target.value as PrimaryArchetype)}>
            {PRIMARY_ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Subtype</label>
          <select className={SELECT_CLASS} value={e.subtype} onChange={(ev) => update({ subtype: ev.target.value as FactEnrichment["subtype"] })}>
            {subtypeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Visual Literalness</label>
          <select className={SELECT_CLASS} value={e.visualLiteralness} onChange={(ev) => update({ visualLiteralness: ev.target.value as FactEnrichment["visualLiteralness"] })}>
            {VISUAL_LITERALNESS_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Visual Complexity</label>
          <select className={SELECT_CLASS} value={e.visualComplexity} onChange={(ev) => update({ visualComplexity: ev.target.value as FactEnrichment["visualComplexity"] })}>
            {VISUAL_COMPLEXITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Overhype Fit</label>
          <select className={SELECT_CLASS} value={e.overhypeFit} onChange={(ev) => update({ overhypeFit: ev.target.value as FactEnrichment["overhypeFit"] })}>
            {OVERHYPE_FIT_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Adult Suitability</label>
          <select className={SELECT_CLASS} value={e.adultSuitability} onChange={(ev) => update({ adultSuitability: ev.target.value as FactEnrichment["adultSuitability"] })}>
            {ADULT_SUITABILITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Adult Suitability Notes</label>
        <textarea
          className={`${SELECT_CLASS} resize-none`}
          rows={2}
          maxLength={500}
          value={e.adultSuitabilityNotes}
          onChange={(ev) => update({ adultSuitabilityNotes: ev.target.value })}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Modifiers</label>
        <Chips items={e.modifiers} known={isKnownModifier} onRemove={(m) => update({ modifiers: e.modifiers.filter((x) => x !== m) })} />
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

      <div>
        <label className={LABEL_CLASS}>Suggested Hashtags (3–8)</label>
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

      {submittedHashtags.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className={LABEL_CLASS} style={{ marginBottom: 0 }}>User-Submitted Hashtags</label>
            {submittedHashtags.some((tag) => !e.suggestedHashtags.includes(tag)) && (
              <button
                type="button"
                onClick={() => {
                  const toAdd = submittedHashtags.filter((tag) => !e.suggestedHashtags.includes(tag));
                  update({ suggestedHashtags: [...e.suggestedHashtags, ...toAdd] });
                }}
                className="text-xs text-primary hover:underline"
              >
                Add all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {submittedHashtags.map((tag) => {
              const already = e.suggestedHashtags.includes(tag);
              return (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border bg-muted/60 border-border text-muted-foreground">
                  {tag}
                  {!already && (
                    <button
                      type="button"
                      title="Copy to suggested hashtags"
                      onClick={() => update({ suggestedHashtags: [...e.suggestedHashtags, tag] })}
                      className="hover:text-primary transition-colors"
                    >
                      +
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Taxonomy Confidence</label>
          <p className="text-sm text-foreground">{e.taxonomyConfidence.toFixed(2)}</p>
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Admin Review Notes</label>
        <textarea
          className={`${SELECT_CLASS} resize-none`}
          rows={2}
          maxLength={800}
          value={e.adminReviewNotes}
          onChange={(ev) => update({ adminReviewNotes: ev.target.value })}
        />
      </div>

      <CulturalReferencesEditor
        refs={e.culturalReferences}
        factText={factText ?? ""}
        onChange={(next) => update({ culturalReferences: next })}
      />

      <SemanticEntitiesEditor
        entities={e.semanticEntities ?? []}
        onChange={(next) => update({ semanticEntities: next })}
      />

      <VisualPreviewPanel
        preview={e.visualPromptPreview}
        onChange={(next) => update({ visualPromptPreview: next })}
        onRegenerate={onRegeneratePreview}
        busy={busy}
        previewBusy={previewBusy}
      />

      {!validity.ok && validity.error.split("; ").filter((err) => !err.startsWith("suggestedHashtags:")).length > 0 && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {validity.error.split("; ").filter((err) => !err.startsWith("suggestedHashtags:")).join("; ")}
        </p>
      )}

      {validity.ok && !hasUsableVisualPreview(e) && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Generate a visual preview before approving — Approve is disabled without one.
        </p>
      )}

      {onSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !validity.ok}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" /> Save enrichment
        </button>
      )}
    </div>
  );
}

/**
 * True when an enrichment is ready to approve — used by the moderation page
 * to gate the Approve / Approve-as-Variant buttons in lockstep with the
 * server-side hard gate.
 */
export function isApprovable(enrichment: FactEnrichment | null | undefined): boolean {
  if (!enrichment) return false;
  return validateEnrichment(enrichment).ok && hasUsableVisualPreview(enrichment);
}
