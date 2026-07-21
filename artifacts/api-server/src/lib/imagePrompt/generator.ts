/**
 * Render-time image-prompt generator (Phase 2).
 *
 * Calls OpenAI with strict Structured Outputs to produce:
 *   - visualPlan (engine-neutral)
 *   - compiledPrompt (Nano Banana 2)
 *   - subjectFactCompatibility (inline)
 *
 * Standard structured-output flow: build user message, call
 * model via `callUtilityLLM` + `zodResponseFormat(strictSchema)`, parse,
 * run business validator with mode-aware rules, retry ONCE on validation
 * failure with a corrective message, throw on second failure.
 */

import { zodResponseFormat } from "openai/helpers/zod";
import {
  imagePromptPlanWireSchema,
  validateImagePromptPlan,
  IMAGE_PROMPT_GENERATION_VERSION,
  VISUAL_PROMPT_GLOBAL_RULES,
  VISUAL_STRATEGY_VERSION,
  getVisualPromptStrategy,
  getSubtypeGuidance,
  isRetiredTextModifier,
  type ImagePromptGenerationInput,
  type PlanExpectations,
  type FactSubtype,
} from "@workspace/api-zod";
import { callUtilityLLM, UTILITY_LLM_TIMEOUT_MS } from "../utilityLLM";
import {
  getImagePromptSystem,
  composeImagePromptSystemPrompt,
  getImagePromptEngineId,
  DEFAULT_IMAGE_PROMPT_ENGINE_ID,
} from "../imagePromptConfig";
import { loadEngine } from "../engineInterpreter";
import { logger } from "../logger";
import { generationModeFromSubjectRenderMode } from "../sourceImageAnalysis";
import { stripSubjectNameSemanticEntities, renderPersonalized } from "../renderCanonical";
import type { ImagePromptGenerationOutput, PlannerProvenance } from "./types";

export const IMAGE_PROMPT_TEMPERATURE = 0.4;
export const IMAGE_PROMPT_MAX_TOKENS = 2800;

/**
 * Timeout for the DEDICATED visual-planner engine path. A frontier reasoning
 * model at xhigh effort routinely needs minutes, not the 30s utility default —
 * without this override the feature would mostly manifest as timeouts. The
 * fallback path (default llm engine) keeps the utility default.
 */
export const IMAGE_PROMPT_LLM_TIMEOUT_MS = 180_000;

export class ImagePromptError extends Error {
  /** Which planner engine produced (or failed to produce) this error — set by
   *  generateImagePromptPlan so attempt errors are attributable. */
  plannerProvenance?: PlannerProvenance;

  constructor(message: string) {
    super(message);
    this.name = "ImagePromptError";
  }
}

// ─── Planner LLM settings resolution ──────────────────────────────────────

export interface ImagePromptLLMSettings {
  /** Unset = use the default "llm" engine (current/fallback behavior). */
  model?: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  plannerProvenance: PlannerProvenance;
}

function fallbackImagePromptLLMSettings(
  configuredEngineId: string,
  fallbackReason: string,
): ImagePromptLLMSettings {
  return {
    temperature: IMAGE_PROMPT_TEMPERATURE,
    maxTokens: IMAGE_PROMPT_MAX_TOKENS,
    plannerProvenance: {
      configuredEngineId,
      resolvedEngineId: null,
      model: null,
      reasoningEffort: null,
      timeoutMs: UTILITY_LLM_TIMEOUT_MS,
      fallbackReason,
    },
  };
}

/**
 * Resolve the dedicated visual-planner engine (config key
 * `fact_image_prompt_engine_id`) into per-call LLM settings + provenance.
 * Any invalid state falls back to the pre-feature behavior (default llm
 * engine, original constants) with the reason recorded — never throws.
 * Note: `loadEngine` does NOT filter isActive/deletedAt, so we must.
 */
export async function resolveImagePromptLLMSettings(): Promise<ImagePromptLLMSettings> {
  let configuredEngineId = DEFAULT_IMAGE_PROMPT_ENGINE_ID;
  try {
    configuredEngineId = (await getImagePromptEngineId()).trim() || DEFAULT_IMAGE_PROMPT_ENGINE_ID;
    const engine = await loadEngine(configuredEngineId);
    const reason = !engine
      ? "engine_not_found"
      : engine.kind !== "llm"
        ? "engine_not_llm"
        : engine.provider !== "openai"
          ? "engine_not_openai"
          : !engine.isActive
            ? "engine_inactive"
            : engine.deletedAt != null
              ? "engine_deleted"
              : !engine.endpointId
                ? "engine_missing_model"
                : null;
    if (engine && reason === null) {
      return {
        model: engine.endpointId,
        temperature:
          engine.defaultTemperature != null ? Number(engine.defaultTemperature) : IMAGE_PROMPT_TEMPERATURE,
        maxTokens: engine.defaultMaxTokens ?? IMAGE_PROMPT_MAX_TOKENS,
        reasoningEffort: engine.defaultReasoningEffort ?? undefined,
        timeoutMs: IMAGE_PROMPT_LLM_TIMEOUT_MS,
        plannerProvenance: {
          configuredEngineId,
          resolvedEngineId: engine.id,
          model: engine.endpointId,
          reasoningEffort: engine.defaultReasoningEffort ?? null,
          timeoutMs: IMAGE_PROMPT_LLM_TIMEOUT_MS,
          fallbackReason: null,
        },
      };
    }
    logger.warn(
      { configuredEngineId, reason },
      "[imagePrompt.generator] visual planner engine fallback",
    );
    return fallbackImagePromptLLMSettings(configuredEngineId, reason ?? "unknown");
  } catch (err) {
    logger.warn(
      { configuredEngineId, err },
      "[imagePrompt.generator] visual planner engine fallback",
    );
    return fallbackImagePromptLLMSettings(configuredEngineId, "resolver_error");
  }
}

type UserMessage = { role: "user"; content: string };

// ─── User-message assembly ────────────────────────────────────────────────

/** Truncate to `max` chars on a word boundary with an ellipsis. */
function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/**
 * A cultural reference is "material" — strong enough to force into the plan and
 * the engine prompt — when it was researched with high confidence, OR the
 * enrichment was confident about it and it isn't flagged for admin review.
 * Ambiguous / review-required references are surfaced to the generator as
 * context but never forced (they may be wrong).
 */
export function isMaterialCulturalReference(r: {
  confidence: number;
  requiresAdminReview: boolean;
  researchConfidence?: "high" | "medium" | "low";
}): boolean {
  if (r.researchConfidence === "high") return true;
  return r.confidence >= 0.8 && !r.requiresAdminReview;
}

/** Identity key for a reference: its sourcePhrase, falling back to canonical. */
export function culturalReferenceKey(r: { sourcePhrase: string; canonicalReference: string }): string {
  return (r.sourcePhrase.trim() || r.canonicalReference.trim());
}

// Template tokens ({NAME}, {Subj}, {SUBJ}, etc.) appear in the TEMPLATE form
// of the fact but are resolved to concrete text before the model ever sees
// them. The model receives the RENDERED fact (e.g. "David Franklin doesn't
// read books.") and therefore cannot reliably echo back the raw template token.
// Filter them from the required echo-back list so check 14 only demands that
// the model echoes fact-specific visual entities (objects, places, characters)
// that actually appear in the rendered text. Template-token entities are still
// included in the user-message block so the model reads their visualReferent.
const TEMPLATE_TOKEN_RE = /^\{[^}]+\}$/;

export function expectationsFromInput(input: ImagePromptGenerationInput): PlanExpectations {
  // Defensive: a fact enriched before the subject-name guard shipped may still
  // carry the personalized subject (e.g. "Alex") as a semantic entity. Strip it
  // so it is never required to be echoed (validator rule 14) or baked in.
  const materialSemanticEntities = stripSubjectNameSemanticEntities(input.enrichment.semanticEntities ?? [])
    .filter((e) => e.materiallyAffectsVisualPrompt)
    .filter((e) => !TEMPLATE_TOKEN_RE.test(e.surfaceText))
    .map((e) => e.surfaceText);
  const materialCulturalReferences = (input.enrichment.culturalReferences ?? [])
    .filter(isMaterialCulturalReference)
    .map(culturalReferenceKey)
    .filter(Boolean);
  // An enabled, non-empty moderator core-scene override is the authoritative
  // scene: the compiler emits it verbatim, so the planner's additive delta
  // collections may legally be empty (no invented filler). Mirrors the
  // compiler's `activeOverride` + coreSceneOverride precedence.
  const override = input.enrichment.visualPromptStrategyOverride;
  const hasAuthoritativeCoreScene = Boolean(
    override?.enabled && (override.coreSceneOverride?.trim() ?? "") !== "",
  );
  return {
    archetype: input.enrichment.primaryArchetype,
    subtype: input.enrichment.subtype as FactSubtype,
    targetEngine: input.targetEngine,
    subjectRenderMode: input.subjectRenderMode,
    generationMode: generationModeFromSubjectRenderMode(input.subjectRenderMode),
    preserveHumanFace: input.identityPolicy.preserveHumanFace,
    preservePhysique: input.identityPolicy.preservePhysique,
    factText: input.factText,
    fallbackSubjectGender: input.renderControls.fallbackSubjectGender ?? null,
    materialSemanticEntities,
    materialCulturalReferences,
    hasAuthoritativeCoreScene,
  };
}

// ─── Granular context-block selection ─────────────────────────────────────
//
// The render planner needs the FULL context (all blocks, moderator scene as the
// AUTHORITATIVE directive). Candidate Visual-concept generation (Slice 2A) reuses
// the SAME descriptive context but must be render-mode-AGNOSTIC — a picked concept
// becomes coreSceneOverride, which has to work across every render mode/scenario —
// so it omits the runtime blocks (source-image analysis, subjectRenderMode,
// identity policy, render controls, style integration, target engine) and treats
// the moderator scene as fresh-idea seed / draft context, never an authoritative
// directive. `buildImagePromptContextBlocks` is the shared, behavior-preserving
// extraction; the planner passes PLANNER_CONTEXT_OPTS (all-true) so its message is
// byte-identical to before.

export type ModeratorCoreSceneMode = false | "authoritative" | "existing_draft_context";

export interface ImagePromptContextOpts {
  includeFactText: boolean;
  includeTaxonomy: boolean;
  includeRenderPolicy: boolean;
  includeAuthoredStrategy: boolean;
  includeExamples: boolean;
  includeCulturalReferences: boolean;
  includeSemanticEntities: boolean;
  includeSourceImageAnalysis: boolean;
  includeSubjectRenderMode: boolean;
  includeIdentityPolicy: boolean;
  includeRenderControls: boolean;
  includeStyleIntegration: boolean;
  includeTargetEngine: boolean;
  /**
   * Emit the "populate visualPlan.semanticEntitiesUsed / visualPlan.
   * culturalReferencesUsed" echo-back directives. Planner-only — they reference
   * the render planner's output schema, which the concept generator (output
   * `{ concepts: [...] }`) does not have.
   */
  includeVisualPlanEchoDirectives: boolean;
  includeModeratorCoreScene: ModeratorCoreSceneMode;
  /** For includeModeratorCoreScene="existing_draft_context": the unsaved draft. */
  moderatorDraftScene?: string;
}

/** The full-context selection the render planner uses (behavior unchanged). */
export const PLANNER_CONTEXT_OPTS: ImagePromptContextOpts = {
  includeFactText: true,
  includeTaxonomy: true,
  includeRenderPolicy: true,
  includeAuthoredStrategy: true,
  includeExamples: true,
  includeCulturalReferences: true,
  includeSemanticEntities: true,
  includeSourceImageAnalysis: true,
  includeSubjectRenderMode: true,
  includeIdentityPolicy: true,
  includeRenderControls: true,
  includeStyleIntegration: true,
  includeTargetEngine: true,
  includeVisualPlanEchoDirectives: true,
  includeModeratorCoreScene: "authoritative",
};

/**
 * The render-mode-AGNOSTIC subset used by candidate Visual-concept generation:
 * fact text + taxonomy + render policy + authored strategy + examples + cultural
 * refs + semantic entities ON; every runtime/mode-specific block OFF.
 * `includeModeratorCoreScene` is set per call site (false = fresh ideas from a
 * blank field; "existing_draft_context" = regenerate distinct alternatives).
 */
export const CANDIDATE_CONTEXT_OPTS: Omit<ImagePromptContextOpts, "includeModeratorCoreScene" | "moderatorDraftScene"> = {
  includeFactText: true,
  includeTaxonomy: true,
  includeRenderPolicy: true,
  includeAuthoredStrategy: true,
  includeExamples: true,
  includeCulturalReferences: true,
  includeSemanticEntities: true,
  includeSourceImageAnalysis: false,
  includeSubjectRenderMode: false,
  includeIdentityPolicy: false,
  includeRenderControls: false,
  includeStyleIntegration: false,
  includeTargetEngine: false,
  includeVisualPlanEchoDirectives: false,
};

/**
 * Context builder input. The planner passes a full ImagePromptGenerationInput;
 * candidate gen passes only the mode-agnostic fields, so the runtime-only fields
 * (read exclusively inside their include-guards) are optional here.
 */
export type ImagePromptContextInput = Omit<
  ImagePromptGenerationInput,
  | "sourceImageAnalysis"
  | "subjectRenderMode"
  | "userSelectedSubjectRenderMode"
  | "identityPolicy"
  | "renderControls"
  | "stylePrompt"
  | "referenceImageUrl"
  | "targetEngine"
> &
  Partial<
    Pick<
      ImagePromptGenerationInput,
      | "sourceImageAnalysis"
      | "subjectRenderMode"
      | "userSelectedSubjectRenderMode"
      | "identityPolicy"
      | "renderControls"
      | "stylePrompt"
      | "referenceImageUrl"
      | "targetEngine"
    >
  >;

/** Resolve the moderator scene text for the current mode, token-rendered when a
 *  render subject is available (matches the planner's original behavior). */
function resolveModeratorContextScene(input: ImagePromptContextInput, opts: ImagePromptContextOpts): string {
  let raw = "";
  if (opts.includeModeratorCoreScene === "authoritative") {
    const ovb = input.enrichment.visualPromptStrategyOverride;
    raw = ovb?.enabled ? (ovb.coreSceneOverride?.trim() ?? "") : "";
  } else if (opts.includeModeratorCoreScene === "existing_draft_context") {
    raw = opts.moderatorDraftScene?.trim() ?? "";
  }
  if (!raw) return "";
  return input.renderedSubject
    ? renderPersonalized(raw, input.renderedSubject.name, input.renderedSubject.pronouns)
    : raw;
}

/** The moderator-scene lines, in place between the strategy lines and examples. */
function moderatorSceneLines(input: ImagePromptContextInput, opts: ImagePromptContextOpts): string[] {
  if (opts.includeModeratorCoreScene === false) return [];
  const scene = resolveModeratorContextScene(input, opts);
  if (!scene) return [];
  if (opts.includeModeratorCoreScene === "authoritative") {
    return [
      "",
      "MODERATOR-AUTHORED CORE SCENE (AUTHORITATIVE — hard directive):",
      `"${scene}"`,
      "A human moderator has specified the exact visual concept for this fact. This scene is authoritative:",
      "- Do NOT invent a different concept, staging, or gag. Plan everything to REALIZE this exact scene.",
      "- Set visualPlan.coreScene to a faithful (optionally tightened) version of this scene — same subject, action, and key objects.",
      "- Fill subjectDetails / environment / lightingAndStyle / keyVisualElements with concrete detail that supports THIS scene.",
    ];
  }
  // existing_draft_context — offer the draft as direction, ask for DISTINCT alternatives.
  return [
    "",
    "CURRENT MODERATOR DRAFT (context only — do NOT simply repeat or reword it):",
    `"${scene}"`,
    "The moderator has a working draft of the visual concept. Propose concepts that explore genuinely DIFFERENT stagings/gags — this draft shows the direction they're leaning, it is NOT an instruction to obey or echo.",
  ];
}

/**
 * Modifiers the frontier planner is allowed to see. Drops the retired text/logo
 * suppression flags (RETIRED_TEXT_MODIFIERS) so a stored legacy value can't bias
 * a fresh plan toward suppressing intentional in-scene text. Non-mutating; every
 * other known/custom modifier is preserved as planner context.
 */
function plannerVisibleModifiers(modifiers: readonly string[]): string[] {
  return modifiers.filter((m) => !isRetiredTextModifier(m));
}

/**
 * Build the ordered CONTEXT lines (everything between the intro and the OUTPUT
 * CONTRACT) for the image-prompt generator, gated by per-block include flags.
 * Behavior-preserving: the planner passes PLANNER_CONTEXT_OPTS so the emitted
 * non-empty-line sequence is identical to the pre-refactor message. Blank ("")
 * entries are filtered by the caller's `.join`, so they are cosmetic separators.
 */
export function buildImagePromptContextBlocks(
  input: ImagePromptContextInput,
  opts: ImagePromptContextOpts,
): string[] {
  const e = input.enrichment;
  const strategy = getVisualPromptStrategy(e.primaryArchetype);
  const subtypeGuide = getSubtypeGuidance(e.primaryArchetype, e.subtype as FactSubtype);

  const culturalRefsBlock = e.culturalReferences.length
    ? e.culturalReferences
        .map((r, i) => {
          const base = `  ${i + 1}. sourcePhrase="${r.sourcePhrase}", referenceType=${r.referenceType}, canonical="${r.canonicalReference}", explanation="${r.explanation}", visualImplication="${r.visualImplication}", confidence=${r.confidence}, requiresAdminReview=${r.requiresAdminReview}, material=${isMaterialCulturalReference(r)}`;
          // Research context (only present after an admin runs "Research
          // Reference"). Compact: confidence + truncated notes + ≤3 warnings.
          const research: string[] = [];
          if (r.researchConfidence) research.push(`researchConfidence=${r.researchConfidence}`);
          if (r.researchNotes && r.researchNotes.trim()) {
            research.push(`researchNotes="${truncateText(r.researchNotes.trim(), 400)}"`);
          }
          if (r.ambiguityWarnings && r.ambiguityWarnings.length) {
            research.push(`ambiguityWarnings=[${r.ambiguityWarnings.slice(0, 3).map((w) => `"${w}"`).join(", ")}]`);
          }
          return research.length ? `${base}\n       ${research.join(", ")}` : base;
        })
        .join("\n")
    : "  (no cultural references — render the joke from the literal text + taxonomy alone)";

  const materialCulturalRefs = e.culturalReferences.filter(isMaterialCulturalReference).map(culturalReferenceKey).filter(Boolean);

  // Defensive strip (mirrors expectationsFromInput): the personalized subject is
  // never a semantic entity, even if an older enrichment stored it as one.
  const semanticEntities = stripSubjectNameSemanticEntities(e.semanticEntities ?? []);
  const materialEntities = semanticEntities.filter((s) => s.materiallyAffectsVisualPrompt);
  const semanticEntitiesBlock = semanticEntities.length
    ? semanticEntities
        .map(
          (s, i) =>
            `  ${i + 1}. surfaceText="${s.surfaceText}", entityKind=${s.entityKind}, visualReferent="${s.visualReferent}", capitalizationSignal=${s.capitalizationSignal}, materiallyAffectsVisualPrompt=${s.materiallyAffectsVisualPrompt}, requiresAdminReview=${s.requiresAdminReview}, confidence=${s.confidence}${s.notes ? `, notes="${s.notes}"` : ""}`,
        )
        .join("\n")
    : "  (no capitalization-sensitive entities flagged by enrichment)";

  const examplesBlock = strategy.visualizationExamples
    .map((ex, i) => {
      const refs = ex.culturalReferences?.length
        ? `\n     example culturalReferences:\n${ex.culturalReferences.map((r) => `       - reference="${r.reference}", type=${r.type}, meaning="${r.meaning}", visualImplication="${r.visualImplication}"`).join("\n")}`
        : "";
      return `  ${i + 1}. fact: "${ex.fact}"
     visualApproach: ${ex.visualApproach || "(authoring pending)"}
     whyItWorks: ${ex.whyItWorks || "(authoring pending)"}
     avoid: ${ex.avoid || "(authoring pending)"}${refs}`;
    })
    .join("\n");

  // RENDER POLICY — the ONLY thing that governs how much of the fact's violence /
  // consequences the CORE SCENE depicts. Placed next to the strategy context so
  // it shapes scene planning. Default is allow + strong (depict what the fact
  // requires); only an explicit moderator soften/suppress override reduces it.
  // Safe for the mode-agnostic subset — reads only input.renderPolicy.
  const renderPolicyBlock = ((): string => {
    const v = input.renderPolicy?.violence;
    const mode = v?.mode ?? "allow";
    const intensity = v?.intensity ?? "strong";
    const guidance = v?.guidance?.trim();
    let line: string;
    if (mode === "suppress") {
      line = "violence=SUPPRESS — deliberately avoid depicting violence, injury, death, or bodies; represent consequences symbolically or through environmental damage only.";
    } else if (mode === "soften") {
      line = "violence=SOFTEN — deliberately reduce explicit violent consequences; avoid graphic injury and visible death.";
    } else {
      line = `violence=ALLOW (${intensity}) — when the fact describes violence, death, weapons, casualties, or destructive aftermath, depict the required action and consequences clearly, INCLUDING the bodies/casualties the fact calls for, without gratuitous gore. Do NOT add your own sanitizing or content-suppression language.`;
    }
    return guidance ? `${line} Moderator guidance: ${guidance}` : line;
  })();

  const lines: string[] = [];

  // ── Rendered fact text ──
  if (opts.includeFactText) {
    lines.push(
      "RENDERED FACT TEXT (subject/pronouns already resolved). Inspect the EXACT spelling and capitalization — capitalization is meaningful for visual interpretation:",
      `factTextExact: ${input.factText}`,
      "",
    );
  }

  // ── Taxonomy (fixed) ──
  if (opts.includeTaxonomy) {
    lines.push(
      "TAXONOMY (FIXED — DO NOT reclassify):",
      `- primaryArchetype: ${e.primaryArchetype}`,
      `- subtype: ${e.subtype}`,
      `- modifiers: ${plannerVisibleModifiers(e.modifiers).join(", ") || "(none)"}`,
      `- visualLiteralness: ${e.visualLiteralness}`,
      `- visualComplexity: ${e.visualComplexity}`,
      `- overhypeFit: ${e.overhypeFit}`,
      `- adultSuitability: ${e.adultSuitability}`,
      `- taxonomyConfidence: ${e.taxonomyConfidence}`,
      "",
    );
  }

  // ── Render policy ──
  if (opts.includeRenderPolicy) {
    lines.push(
      "RENDER POLICY (governs how much of the fact's violence/consequences the CORE SCENE depicts — this is the ONLY layer that may suppress; do not self-censor beyond it):",
      renderPolicyBlock,
      "",
    );
  }

  // ── Authored visual strategy (strategy lines, then moderator scene, then
  //    examples, then locked rule) — kept in this exact order so the planner
  //    message is byte-identical. ──
  if (opts.includeAuthoredStrategy) {
    lines.push(
      "AUTHORED VISUAL STRATEGY (apply this — do not improvise):",
      `Strategy block: ${strategy.strategyBlock}`,
      `Core visual goal: ${strategy.coreVisualGoal}`,
      `i2i default: ${strategy.i2iDefault}`,
      strategy.t2iFallback ? `t2i fallback: ${strategy.t2iFallback}` : "",
      strategy.preservePhysique ? `Per-archetype preservePhysique: ${strategy.preservePhysique}` : "",
      subtypeGuide ? `Subtype guidance for ${e.subtype}: ${subtypeGuide.principle}${subtypeGuide.useWhen ? ` (use when: ${subtypeGuide.useWhen})` : ""}` : "",
    );
  }
  lines.push(...moderatorSceneLines(input, opts));
  if (opts.includeExamples) {
    lines.push(
      "",
      "Visualization examples:",
      examplesBlock,
    );
  }
  if (opts.includeAuthoredStrategy) {
    lines.push(
      "",
      `Locked rule: ${strategy.lockedRule}`,
      strategy.frameSelectionGuidance && strategy.frameSelectionGuidance.length
        ? `Frames: ${strategy.frameSelectionGuidance.map((f) => `${f.frame} (${f.useWhen})`).join("; ")}`
        : "",
      "",
    );
  }

  // ── Per-fact cultural references + semantic entities. The two echo
  //    instructions both sit AFTER the semantic block (original ordering). ──
  if (opts.includeCulturalReferences) {
    lines.push(
      "PER-FACT CULTURAL REFERENCES (override example annotations for THIS fact):",
      culturalRefsBlock,
      "",
    );
  }
  if (opts.includeSemanticEntities) {
    lines.push(
      "SEMANTIC ENTITY INTERPRETATION (hard visual context — DO NOT override; treat as the locked meaning of the surface term in this fact):",
      semanticEntitiesBlock,
    );
  }
  // The echo-back directives instruct the model to populate visualPlan.* /
  // compiledPrompt.* — the RENDER PLANNER's output schema. They are meaningless
  // (and schema-incompatible) for candidate concept generation, whose structured
  // output is only `{ concepts: [...] }`, so they are gated on the planner-only
  // includeVisualPlanEchoDirectives flag. The reference DATA blocks above stay —
  // they give the model the fact's locked visual interpretation, useful for both.
  if (opts.includeSemanticEntities && opts.includeVisualPlanEchoDirectives) {
    lines.push(
      materialEntities.length > 0
        ? `\nFor every entity above with materiallyAffectsVisualPrompt=true, include a matching entry in visualPlan.semanticEntitiesUsed (echo surfaceText verbatim; fill visualReferentUsed with the resolved referent; fill effectOnVisualPlan with one sentence on how this shaped the scene). Required surfaceTexts: ${materialEntities.map((s) => `"${s.surfaceText}"`).join(", ")}.`
        : "\n(semanticEntitiesUsed may be an empty array.)",
    );
  }
  if (opts.includeCulturalReferences && opts.includeVisualPlanEchoDirectives) {
    lines.push(
      materialCulturalRefs.length > 0
        ? `\nFor every MATERIAL cultural reference (material=true above), include a matching entry in visualPlan.culturalReferencesUsed (echo sourcePhrase verbatim; fill canonicalReferenceUsed + visualImplicationUsed + a one-sentence effectOnVisualPlan). Bake the reference's visual implication into keyVisualElements + the compiledPrompt.prompt, but never draw a real logo or brand mark. Required sourcePhrases: ${materialCulturalRefs.map((s) => `"${s}"`).join(", ")}.`
        : "\n(culturalReferencesUsed may be an empty array — no material references in this fact.)",
      "",
    );
  }

  // ── Runtime blocks (EXCLUDED from the mode-agnostic candidate subset) ──
  if (opts.includeSourceImageAnalysis && input.sourceImageAnalysis) {
    const sia = input.sourceImageAnalysis;
    lines.push(
      "SOURCE-IMAGE ANALYSIS:",
      `- subjectKind: ${sia.subjectKind}`,
      `- confidence: ${sia.confidence}`,
      `- hasUsableHumanFace: ${sia.hasUsableHumanFace}`,
      `- hasUsableSubject: ${sia.hasUsableSubject}`,
      `- subjectCount: ${sia.subjectCount}`,
      sia.subjectDescription ? `- subjectDescription: "${sia.subjectDescription}"` : "",
      sia.warnings.length ? `- warnings: ${sia.warnings.join("; ")}` : "",
      `- classificationMethod: ${sia.classificationMethod}`,
      "",
    );
  }

  if (opts.includeSubjectRenderMode && input.subjectRenderMode) {
    lines.push(
      `RESOLVED subjectRenderMode: ${input.subjectRenderMode}`,
      input.userSelectedSubjectRenderMode ? `(user explicitly overrode suggestedRenderMode to ${input.userSelectedSubjectRenderMode})` : "",
      `RESOLVED generationMode: ${generationModeFromSubjectRenderMode(input.subjectRenderMode)}`,
      `Reference image present: ${input.referenceImageUrl ? "yes" : "no"}`,
      "",
      buildModeRuleExcerpt(input),
      "",
    );
  }

  if (opts.includeIdentityPolicy && input.identityPolicy) {
    const ip = input.identityPolicy;
    lines.push(
      "IDENTITY POLICY:",
      `- preserveHumanFace: ${ip.preserveHumanFace}`,
      `- preserveNonhumanSubjectIdentity: ${ip.preserveNonhumanSubjectIdentity}`,
      `- preservePhysique: ${ip.preservePhysique}`,
      `- allowBodyExaggeration: ${ip.allowBodyExaggeration}`,
      `- allowCostumeTransformation: ${ip.allowCostumeTransformation}`,
      `- allowAnthropomorphicTransformation: ${ip.allowAnthropomorphicTransformation}`,
      `- ageAndLifeStagePolicy: ${ip.ageAndLifeStagePolicy}`,
      "",
    );
  }

  if (opts.includeRenderControls && input.renderControls) {
    const rc = input.renderControls;
    const fallbackGender = rc.fallbackSubjectGender ?? null;
    lines.push(
      "RENDER CONTROLS:",
      `- aspectRatio: ${rc.aspectRatio}`,
      `- negativeSpacePreference: ${rc.negativeSpacePreference ?? "auto"}`,
      `- contentMode: ${rc.contentMode}`,
      `- fallbackSubjectGender: ${fallbackGender ?? "(unset)"} ${input.subjectRenderMode === "t2i_fallback" ? "(REQUIRED for t2i_fallback — reference this in the prompt)" : "(ignore unless t2i_fallback)"}`,
      "",
    );
  }

  if (opts.includeStyleIntegration) {
    lines.push(
      "STYLE INTEGRATION (weave naturally):",
      input.stylePrompt || "(no style suffix configured)",
      "",
    );
  }

  if (opts.includeTargetEngine && input.targetEngine) {
    lines.push(
      `TARGET ENGINE: ${input.targetEngine} (use t2i variant when generationMode=t2i, edit/i2i variant otherwise)`,
      "",
    );
  }

  return lines;
}

/** Per-mode identity global-rule excerpt (runtime block; needs subjectRenderMode). */
function buildModeRuleExcerpt(input: ImagePromptContextInput): string {
  if (input.subjectRenderMode === "human_identity_i2i") {
    const physique = input.identityPolicy?.preservePhysique
      ? VISUAL_PROMPT_GLOBAL_RULES.preservePhysiqueOverride
      : "";
    return [
      "Identity rule (human i2i):",
      VISUAL_PROMPT_GLOBAL_RULES.identityBaseline,
      physique ? `\nPreserve-physique override:\n${physique}` : "",
      `\nAge / life-stage policy:\n${VISUAL_PROMPT_GLOBAL_RULES.ageAndLifeStagePolicy}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (input.subjectRenderMode === "nonhuman_subject_i2i") {
    return [
      "Identity rule (non-human i2i):",
      VISUAL_PROMPT_GLOBAL_RULES.nonhumanSubjectIdentityPolicy,
      `\nAnthropomorphic treatment policy:\n${VISUAL_PROMPT_GLOBAL_RULES.anthropomorphicTreatmentPolicy}`,
      `\nAge / life-stage policy:\n${VISUAL_PROMPT_GLOBAL_RULES.ageAndLifeStagePolicy}`,
    ].join("\n");
  }
  return [
    "Identity rule (t2i fallback):",
    VISUAL_PROMPT_GLOBAL_RULES.textToImageFallbackPolicy,
  ].join("\n");
}

/**
 * The render planner's full user message: intro + full context (all blocks,
 * moderator scene AUTHORITATIVE) + the OUTPUT CONTRACT. Byte-identical to the
 * pre-refactor message — the generator tests pin this.
 */
export function buildImagePromptUserMessage(input: ImagePromptGenerationInput): string {
  const e = input.enrichment;
  const semanticEntities = stripSubjectNameSemanticEntities(e.semanticEntities ?? []);
  const materialEntities = semanticEntities.filter((s) => s.materiallyAffectsVisualPrompt);
  const materialCulturalRefs = e.culturalReferences.filter(isMaterialCulturalReference).map(culturalReferenceKey).filter(Boolean);
  const fallbackGender = input.renderControls.fallbackSubjectGender ?? null;

  return [
    "Generate the engine-neutral visualPlan + Nano Banana 2 compiledPrompt + subjectFactCompatibility for this render.",
    "",
    ...buildImagePromptContextBlocks(input, PLANNER_CONTEXT_OPTS),
    "OUTPUT CONTRACT:",
    "- Echo input targetEngine, generationMode, archetype, subtype, subjectRenderMode verbatim.",
    "- The engine prompt is a labeled contract assembled by the compiler, and the VISUAL CONCEPT (CORE SCENE) LEADS it: CORE SCENE · IDENTITY/RENDER TASK · SUBJECT BINDING · ROLE DETAILS · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns identity/reference + BINDING + STRICT CONSTRAINTS; you fill the concrete visual fields (coreScene carries the scene).",
    "- visualGoal / visualApproach: INTERNAL reasoning only (NOT sent to the image model). ONE short clause each — payoff and staging logic. Do NOT pack scene detail here.",
    "- coreScene: REQUIRED, non-empty. ONE tight paragraph of what is literally happening (subject + action + key objects). Concrete visuals only.",
    "- subjectDetails: REQUIRED, ≥1 concrete entry — pose, expression, apparent age/body presentation, wardrobe, distinctive features. For an age transform, visibly describe the transformed life stage (proportions, skin, hair).",
    "- subjectTreatment.roleInScene: a CONCRETE visible role/action — what the subject visibly is and does in the image (\"the newborn baby gripping the steering wheel and driving\"), NOT an abstract label (\"protagonist\", \"the hero\").",
    "- secondaryCharacters: list each non-subject person, animal, crowd, or entity that must appear, as { label, visualRole }. label = short relationship/name/type (\"mother\", \"referee\", \"crowd\", \"sharks\"). visualRole = the CONCRETE visible role — position, action/reaction, and relationship to the subject — NOT a bare relationship word: write \"adult woman seated in the front passenger seat, looking surprised at the baby driver\", not \"his mother\". Empty array when the subject is alone or no secondary entity must appear.",
    "- Central action / role relationship: when the taxonomy/frame indicates the subject is the sole active agent, the subject performs the central action and secondary characters do NOT take over that role. For co-action, crowd-reaction, role-reversal, causal, or symbolic scenes, preserve the intended role relationship instead of forcing sole-agent behavior. The hospital-baby example is only a diagnostic — apply the same role/action reasoning to ALL multi-character, active-action, role-reversal, crowd, nonhuman, and subject-as-object facts; do not overfit to babies, cars, mothers, or hospitals.",
    "- environment: REQUIRED, ≥1 concrete entry — setting, background, props, scale.",
    "- lightingAndStyle: light, mood, palette, aesthetic. The resolved stylePrompt is appended by the compiler — do not repeat it verbatim.",
    "- ageLifeStageTransform: { applies, targetState }. applies=true with a concrete targetState noun (\"a baby/infant\", \"a school-age child\", \"an elderly man\") when the fact implies a life stage other than the reference person's current one; otherwise applies=false and targetState=\"\". The reference person IS the transformed subject — one entity, never an adult plus a separate baby/child.",
    "- DESCRIBE THE PICTURE, NOT THE JOKE: coreScene/subjectDetails/environment/lightingAndStyle must map to visible pixels. Do NOT write authorial-intent commentary (\"showcasing the absurdity\", \"emphasizing the humor\", \"creating a humorous contrast\", \"comedic effect\", \"the absurdity of the situation\"). Show the humor through concrete visuals.",
    "- Tone: when a scene is both serious and funny, state the hierarchy explicitly (e.g. \"serious cinematic staging; the humor comes from the visual contrast\") rather than mixing competing tone words like \"grounded\" and \"playful\" without relating them.",
    "- keyVisualElements: 3-12 entries; concrete visible elements only (no abstract joke explanation, no policy language). Gap-fill safety net — the compiler injects any not already covered by the concrete fields.",
    "- compiledPrompt.prompt OWNERSHIP: legacy CORE-SCENE fallback (the compiler prefers coreScene). Write ONLY the concrete scene. The compiler injects identity, reference-image, de-aging/binding, token, and text-policy language itself, so do NOT author any of these — they are stripped before the engine sees them: (a) face/identity/likeness preservation or de-aging (\"preserve the … face\", \"recognizable face\", \"same person\", \"de-age\", \"do not replace … with a human\"); (b) mentions of the uploaded/reference/source image or i2i/t2i; (c) NAME/SUBJ-style identity template tokens or \"interpret these terms\" clauses; (d) readable-text/logo/watermark policy. Describe what SHOULD be in the frame; the compiler owns the rest.",
    "- supportingTextPolicy.forbiddenTextTypes MUST include all 7 mandatory entries (full meme captions, full fact text, hashtags, watermarks, real logos, brand marks, long explanatory paragraphs).",
    "- If allowSupportingText is false, supportingTextElements MUST be an empty array.",
    "- supportingTextElements (when present) MUST have shape { content, purpose, placement } per element.",
    `- nonhumanSubjectTreatment.applicable MUST be ${input.subjectRenderMode === "nonhuman_subject_i2i" ? "true" : "false"}.`,
    `- subjectTreatment.fallbackSubjectGender MUST be ${input.subjectRenderMode === "t2i_fallback" ? `"${fallbackGender ?? "neutral"}"` : '"not_applicable"'}.`,
    "- subjectFactCompatibility: rate strong/workable/risky/poor with a reason. recommendedFallback is advisory only; \"none\" is valid for every rating, including poor. This field never blocks rendering.",
    materialEntities.length > 0
      ? `- semanticEntitiesUsed: MUST include an entry for each of [${materialEntities.map((s) => `"${s.surfaceText}"`).join(", ")}]; each entry needs surfaceText + visualReferentUsed + effectOnVisualPlan all non-empty.`
      : "- semanticEntitiesUsed: may be an empty array (no material entities in this fact).",
    materialCulturalRefs.length > 0
      ? `- culturalReferencesUsed: MUST include an entry for each of [${materialCulturalRefs.map((s) => `"${s}"`).join(", ")}]; each entry needs sourcePhrase + canonicalReferenceUsed + visualImplicationUsed + effectOnVisualPlan all non-empty.`
      : "- culturalReferencesUsed: may be an empty array (no material references in this fact).",
    `- compiledPrompt.negativePrompt: Nano Banana 2 has NO negative-prompt parameter — leave it as an empty string ("") and express every exclusion as positive scene language inside compiledPrompt.prompt (describe what SHOULD be there, e.g. "a clean bare wall" rather than "no posters").`,
    "- Return ONLY the JSON object.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function buildCorrective(error: string, hint?: string): string {
  if (hint && hint !== error) {
    return `The previous response failed validation: ${error}\n\nFix: ${hint}\n\nReturn the full JSON object again with all fields correct.`;
  }
  return `The previous response failed validation: ${error}\n\nReturn the full JSON object again with all fields correct.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────

export async function generateImagePromptPlanWithModel(
  input: ImagePromptGenerationInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
): Promise<ImagePromptGenerationOutput> {
  const expectations = expectationsFromInput(input);
  const firstUser: UserMessage = { role: "user", content: buildImagePromptUserMessage(input) };

  let raw = await callModel([firstUser]);
  let parsed = safeJsonParse(raw);
  let result = validateImagePromptPlan(parsed, expectations);

  if (!result.ok) {
    raw = await callModel([firstUser, { role: "user", content: buildCorrective(result.error, result.correctableHint) }]);
    parsed = safeJsonParse(raw);
    result = validateImagePromptPlan(parsed, expectations);
  }

  if (!result.ok) {
    throw new ImagePromptError(result.error);
  }

  const data = result.data;
  return {
    visualPlan: data.visualPlan,
    compiledPrompt: data.compiledPrompt,
    promptVersion: IMAGE_PROMPT_GENERATION_VERSION,
    archetypeStrategyVersion: VISUAL_STRATEGY_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: "openai",
  };
}

// ─── Live wrapper ─────────────────────────────────────────────────────────

function makeOpenAIImagePromptCaller(
  settings: ImagePromptLLMSettings,
): (userMessages: UserMessage[]) => Promise<string> {
  return async (userMessages: UserMessage[]): Promise<string> => {
    // Append the non-configurable platform hard rules so the no-self-censoring rule
    // holds even when admin_config carries a stale base prompt.
    const systemPrompt = composeImagePromptSystemPrompt(await getImagePromptSystem());
    const response = await callUtilityLLM({
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: settings.timeoutMs,
      responseFormat: zodResponseFormat(imagePromptPlanWireSchema, "image_prompt_plan"),
      messages: [{ role: "system", content: systemPrompt }, ...userMessages],
    });
    return response.choices[0]?.message?.content ?? "{}";
  };
}

/**
 * Generate the image-prompt plan via the dedicated visual-planner engine
 * (falling back to the default utility LLM — see
 * `resolveImagePromptLLMSettings`). Throws `ImagePromptError` on unrecoverable
 * failure, with `plannerProvenance` attached so callers (the async-jobs
 * handler + admin route) can attribute the failure to planner vs. fallback
 * when they surface `error` on the attempt row.
 */
export async function generateImagePromptPlan(
  input: ImagePromptGenerationInput,
): Promise<ImagePromptGenerationOutput> {
  const settings = await resolveImagePromptLLMSettings();
  try {
    const output = await generateImagePromptPlanWithModel(input, makeOpenAIImagePromptCaller(settings));
    return { ...output, plannerProvenance: settings.plannerProvenance };
  } catch (err) {
    if (err instanceof ImagePromptError) {
      err.plannerProvenance ??= settings.plannerProvenance;
      throw err;
    }
    logger.error({ err, plannerProvenance: settings.plannerProvenance }, "[imagePrompt.generator] unexpected failure");
    const wrapped = new ImagePromptError(err instanceof Error ? err.message : String(err));
    wrapped.plannerProvenance = settings.plannerProvenance;
    throw wrapped;
  }
}
