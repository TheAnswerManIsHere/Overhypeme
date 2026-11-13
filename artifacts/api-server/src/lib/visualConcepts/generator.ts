/**
 * The gag writer: one structured-outputs call drafts a fact's joke read and
 * three candidate visual gags (plan docs/plans/PLAN_GAG_GENERATOR.md, approved
 * by David 2026-11-13).
 *
 * - The system prompt is the text David locked (visualConceptsConfig.ts).
 * - The request is built here, for a gag writer, from the review cycle's
 *   effective enrichment: the caption with the stand-in name "Alex", the
 *   approved humor note, what references mean, the joke mechanism, the
 *   violence and text limits, the saved gag and the moderator's working draft.
 *   It no longer reuses the render planner's context blocks.
 * - The model writes "Alex"; every scene and bubble line is converted to a
 *   token template by the existing tokenizer before the existing validation,
 *   sanitizing and budget preflight run. A conversion that leaves the stand-in
 *   name in place, or a scene with no subject token, is a failed conversion,
 *   never a pickable gag.
 * - The engine is `fact_visual_concepts_engine_id` (openai-gag-writer, GPT-6
 *   Astra). There is no fallback to a weaker model: an unusable engine fails
 *   generation with its reason (David: "an admin function so doesn't need high
 *   availability").
 */

import { zodResponseFormat } from "openai/helpers/zod";
import {
  candidateConceptsWireSchema,
  validateCandidateConcepts,
  sanitizeCandidateConcept,
  isCandidateConceptPickable,
  withCandidateConceptDraft,
  getSubtypeGuidance,
  CANDIDATE_VISUAL_CONCEPT_COUNT,
  VISUAL_CONCEPTS_PROMPT_VERSION,
  type CandidateConceptsWire,
  type FactEnrichment,
  type FactSubtype,
  type RenderPolicy,
  type StoredCandidateConcept,
  type VisualConceptProvenance,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";
import { callUtilityLLM } from "../utilityLLM";
import { isMaterialCulturalReference } from "../imagePrompt/generator";
import { renderPersonalized, stripSubjectNameSemanticEntities } from "../renderCanonical";
import { tokenizePlainTextToTemplate } from "../factTokenizer";
import { getVisualConceptsSystem, getVisualConceptsEngineId, DEFAULT_VISUAL_CONCEPTS_ENGINE_ID } from "../visualConceptsConfig";
import { loadEngine } from "../engineInterpreter";
import { logger } from "../logger";

/** A frontier reasoning model at high effort needs minutes, not the 30s default. */
export const VISUAL_CONCEPTS_LLM_TIMEOUT_MS = 240_000;
export const VISUAL_CONCEPTS_MAX_TOKENS = 4000;

/** The stand-in name the gag writer uses for the subject; tokenized afterwards. */
export const STAND_IN_NAME = "Alex";

export class VisualConceptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualConceptsError";
  }
}

/** The configured engine cannot be used: generation stops, with no fallback model. */
export class VisualConceptsEngineUnusable extends VisualConceptsError {
  constructor(readonly reason: string, readonly engineId: string) {
    super(`The gag writer engine "${engineId}" cannot be used (${reason}). Fix it on the Engines screen, then press Regenerate.`);
    this.name = "VisualConceptsEngineUnusable";
  }
}

/** A gag shown to the writer as context: its scene and its bubbles, as stored (with tokens). */
export interface ContextGag {
  scene: string;
  bubbles: Array<Pick<VisualStrategyBubble, "type" | "entity" | "text">>;
}

export interface GenerateVisualConceptsInput {
  /** Fact template with {NAME}/pronoun tokens intact. */
  factText: string;
  /** The review cycle's effective enrichment (meanings, mechanism, policy). */
  enrichment: FactEnrichment;
  renderPolicy: RenderPolicy;
  /** The fact's approved humor note, or null. */
  humorNote: string | null;
  /** The fact's saved, approved gag: the live fact's, also during a refresh. */
  savedGag: ContextGag | null;
  /** The moderator's unsaved working draft (Regenerate). */
  draft: ContextGag | null;
}

export interface VisualConceptsGenerationResult {
  jokeRead: string;
  candidates: StoredCandidateConcept[];
  provenance: VisualConceptProvenance;
}

// ─── Engine settings resolution ─────────────────────────────────────────────

export interface VisualConceptsLLMSettings {
  model: string | null;
  maxTokens: number;
  reasoningEffort?: string;
  timeoutMs: number;
  provenance: VisualConceptProvenance;
  /** Set when the configured engine cannot be used; generation then refuses. */
  unusableReason: string | null;
}

/**
 * Resolve the configured gag-writer engine. Never throws and never substitutes
 * another model: an unusable engine comes back with `unusableReason`, which
 * generation turns into a failure the moderator sees. The review screen calls
 * this too (for freshness) and keeps loading when the engine is unusable.
 */
export async function resolveVisualConceptsLLMSettings(): Promise<VisualConceptsLLMSettings> {
  let engineId = DEFAULT_VISUAL_CONCEPTS_ENGINE_ID;
  const unusable = (reason: string): VisualConceptsLLMSettings => ({
    model: null,
    maxTokens: VISUAL_CONCEPTS_MAX_TOKENS,
    timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
    provenance: {
      engineId,
      model: null,
      reasoningEffort: null,
      timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
      promptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
      fallbackReason: null,
    },
    unusableReason: reason,
  });
  try {
    engineId = (await getVisualConceptsEngineId()).trim() || DEFAULT_VISUAL_CONCEPTS_ENGINE_ID;
    const engine = await loadEngine(engineId);
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
    if (!engine || reason !== null) {
      logger.warn({ engineId, reason }, "[visualConcepts.generator] gag writer engine unusable");
      return unusable(reason ?? "engine_not_found");
    }
    return {
      model: engine.endpointId,
      maxTokens: engine.defaultMaxTokens ?? VISUAL_CONCEPTS_MAX_TOKENS,
      reasoningEffort: engine.defaultReasoningEffort ?? undefined,
      timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
      provenance: {
        engineId,
        model: engine.endpointId,
        reasoningEffort: engine.defaultReasoningEffort ?? null,
        timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
        promptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
        fallbackReason: null,
      },
      unusableReason: null,
    };
  } catch (err) {
    logger.warn({ engineId, err }, "[visualConcepts.generator] gag writer engine could not be resolved");
    return unusable("resolver_error");
  }
}

// ─── The request ────────────────────────────────────────────────────────────

/** Render stored token text with the stand-in name and they/them. */
export function withStandIn(template: string): string {
  return renderPersonalized(template, STAND_IN_NAME, "they");
}

const plain = (snake: string) => snake.replace(/_/g, " ");

function gagLines(label: string, gag: ContextGag): string[] {
  const lines = [label, withStandIn(gag.scene.trim())];
  for (const b of gag.bubbles) {
    if (!b.text.trim()) continue;
    lines.push(`- ${b.type} bubble, ${b.entity === "subject" ? "Alex" : b.entity}: "${withStandIn(b.text.trim())}"`);
  }
  return lines;
}

/**
 * The per-request message: only what a gag writer needs, absent blocks
 * omitted, no second copy of the output rules (those are in the system prompt).
 */
export function buildVisualConceptsUserMessage(input: GenerateVisualConceptsInput): string {
  const e = input.enrichment;
  const blocks: string[][] = [];

  blocks.push(["FACT (the caption):", withStandIn(input.factText.trim())]);

  if (input.humorNote?.trim()) {
    blocks.push(["APPROVED HUMOR NOTE (written or confirmed by a moderator; the correct reading of this joke):", input.humorNote.trim()]);
  }

  const meanings: string[] = [];
  for (const r of e.culturalReferences ?? []) {
    const status = isMaterialCulturalReference(r) ? "" : " (tentative)";
    meanings.push(`- "${r.sourcePhrase}" refers to ${r.canonicalReference}${status}: ${r.explanation}${r.visualImplication ? ` Visually: ${r.visualImplication}` : ""}`);
  }
  for (const s of stripSubjectNameSemanticEntities(e.semanticEntities ?? []).filter((x) => x.materiallyAffectsVisualPrompt)) {
    meanings.push(`- "${s.surfaceText}" means ${s.visualReferent}${s.requiresAdminReview ? " (tentative)" : ""}.`);
  }
  if (meanings.length) blocks.push(["WHAT THE REFERENCES MEAN:", ...meanings]);

  const guide = getSubtypeGuidance(e.primaryArchetype, e.subtype as FactSubtype);
  blocks.push([
    "JOKE MECHANISM:",
    `${plain(e.primaryArchetype)}, ${plain(e.subtype)}${guide?.principle ? `. ${guide.principle}` : ""}`,
  ]);

  const v = input.renderPolicy.violence;
  const violence = v.mode === "suppress"
    ? "Do not depict violence, injury, death or bodies; show consequences symbolically or through damage to things."
    : v.mode === "soften"
      ? "Reduce explicit violent consequences; no graphic injury and no visible death."
      : `Allowed (${v.intensity}): when the fact calls for violence or its aftermath, show it clearly, without gratuitous gore.`;
  const t = input.renderPolicy.supportingText;
  const text = t.mode === "forbid"
    ? "No signs, labels or other words in the picture. Speech and thought bubbles are still allowed."
    : t.mode === "require"
      ? "Short words in the picture are required where they carry the gag."
      : "Short signs, labels and sound-effect words are allowed where they are visual evidence.";
  blocks.push([
    "LIMITS:",
    `Violence: ${violence}${v.guidance ? ` Moderator guidance: ${v.guidance}` : ""}`,
    `Text in the picture: ${text}${t.guidance ? ` Moderator guidance: ${t.guidance}` : ""}`,
  ]);

  if (input.savedGag?.scene.trim()) blocks.push(gagLines("GAG THIS FACT ALREADY HAS (do not repeat its staging or payoff):", input.savedGag));
  if (input.draft?.scene.trim()) blocks.push(gagLines("MODERATOR'S WORKING DRAFT (propose alternatives to it):", input.draft));

  return blocks.map((b) => b.join("\n")).join("\n\n");
}

function buildCorrective(error: string): string {
  return `The previous response failed validation: ${error}\n\nReturn the full JSON object again: a jokeRead and exactly ${CANDIDATE_VISUAL_CONCEPT_COUNT} concepts.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ─── Stand-in name → token template ─────────────────────────────────────────

export type TokenizeFn = (text: string) => Promise<{ template: string; grammarError?: string }>;

export const defaultTokenize: TokenizeFn = (text) =>
  tokenizePlainTextToTemplate(text, { purpose: "visual_strategy", subjectNames: [STAND_IN_NAME] });

const STAND_IN_RE = new RegExp(`\\b${STAND_IN_NAME}\\b`);

/** Why a converted text is not usable, or null. */
function conversionProblem(original: string, converted: { template: string; grammarError?: string }, needsSubject: boolean): string | null {
  if (converted.grammarError) return converted.grammarError;
  if (STAND_IN_RE.test(converted.template)) return `the stand-in name "${STAND_IN_NAME}" was not converted`;
  if (needsSubject && !/\{NAME(_POSSESSIVE)?\}/.test(converted.template)) return "the scene does not name the subject";
  if (!converted.template.trim() && original.trim()) return "the conversion came back empty";
  return null;
}

/**
 * Convert each scene and each bubble line from the stand-in name to a token
 * template. A text that cannot be converted is replaced by one that fails
 * token validation with the reason, so its gag is stored as unpickable and
 * shows why; it is never stored naming "Alex".
 */
export async function convertStandInName(wire: CandidateConceptsWire, tokenize: TokenizeFn = defaultTokenize): Promise<CandidateConceptsWire> {
  const convert = async (textIn: string, needsSubject: boolean): Promise<string> => {
    if (!STAND_IN_RE.test(textIn) && !needsSubject) return textIn;
    try {
      const out = await tokenize(textIn);
      const problem = conversionProblem(textIn, out, needsSubject);
      if (problem) return `{CONVERSION_FAILED} ${problem}: ${textIn}`;
      return out.template;
    } catch (err) {
      return `{CONVERSION_FAILED} the tokenizer failed (${err instanceof Error ? err.message : String(err)}): ${textIn}`;
    }
  };
  const concepts = await Promise.all(wire.concepts.map(async (c) => ({
    ...c,
    sceneDescription: await convert(c.sceneDescription, true),
    bubbles: await Promise.all(c.bubbles.map(async (b) => ({ ...b, text: await convert(b.text, false) }))),
  })));
  return { ...wire, concepts };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * The deterministic validate/sanitize matrix, unchanged from v2 except that it
 * runs on the converted text. Retryable whole-response errors take one
 * corrective call; an unpickable concept on a response with at least one
 * pickable concept is stored and shown with its reason.
 */
export function validateAndSanitizeCandidateConcepts(
  parsed: unknown,
): { ok: true; jokeRead: string; candidates: StoredCandidateConcept[] } | { ok: false; error: string } {
  const result = validateCandidateConcepts(parsed);
  if (!result.ok) return result;
  const candidates = result.data.concepts.map(sanitizeCandidateConcept);

  for (const [i, c] of candidates.entries()) {
    if (!isCandidateConceptPickable(c)) continue;
    const budget = validateVisualStrategyOverridePersistence(withCandidateConceptDraft(undefined, c));
    if (!budget.ok) {
      const first = budget.errors[0];
      return {
        ok: false,
        error: `concept ${i + 1} would exceed the prompt budget once applied (${first?.message ?? "over budget"}) — shorten its sceneDescription or bubble text`,
      };
    }
  }

  if (!candidates.some(isCandidateConceptPickable)) {
    const why = candidates.find((c) => c.tokenError)?.tokenError ?? "no usable concept";
    return { ok: false, error: `no concept could be used (${why}). Name the subject "Alex" in every sceneDescription and give no other character that name.` };
  }

  return { ok: true, jokeRead: result.data.jokeRead.trim(), candidates };
}

type UserMessage = { role: "user"; content: string };

export async function generateVisualConceptsWithModel(
  input: GenerateVisualConceptsInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
  tokenize: TokenizeFn = defaultTokenize,
): Promise<{ jokeRead: string; candidates: StoredCandidateConcept[] }> {
  const firstUser: UserMessage = { role: "user", content: buildVisualConceptsUserMessage(input) };

  const attempt = async (msgs: UserMessage[]) => {
    const raw = await callModel(msgs);
    const parsed = candidateConceptsWireSchema.safeParse(safeJsonParse(raw));
    if (!parsed.success) return validateAndSanitizeCandidateConcepts(safeJsonParse(raw));
    return validateAndSanitizeCandidateConcepts(await convertStandInName(parsed.data, tokenize));
  };

  let result = await attempt([firstUser]);
  if (!result.ok) result = await attempt([firstUser, { role: "user", content: buildCorrective(result.error) }]);
  if (!result.ok) throw new VisualConceptsError(result.error);
  return { jokeRead: result.jokeRead, candidates: result.candidates };
}

function makeOpenAIConceptsCaller(settings: VisualConceptsLLMSettings): (userMessages: UserMessage[]) => Promise<string> {
  return async (userMessages: UserMessage[]): Promise<string> => {
    const systemPrompt = await getVisualConceptsSystem();
    const response = await callUtilityLLM({
      model: settings.model ?? undefined,
      temperature: 0.8,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: settings.timeoutMs,
      responseFormat: zodResponseFormat(candidateConceptsWireSchema, "visual_concepts"),
      messages: [{ role: "system", content: systemPrompt }, ...userMessages],
    });
    return response.choices[0]?.message?.content ?? "{}";
  };
}

/**
 * Draft a joke read and three candidate gags on the configured gag writer.
 * Throws VisualConceptsEngineUnusable when the engine cannot be used (no
 * fallback), VisualConceptsError on an unrecoverable response.
 */
export async function generateVisualConcepts(input: GenerateVisualConceptsInput): Promise<VisualConceptsGenerationResult> {
  const settings = await resolveVisualConceptsLLMSettings();
  if (settings.unusableReason) throw new VisualConceptsEngineUnusable(settings.unusableReason, settings.provenance.engineId);
  const out = await generateVisualConceptsWithModel(input, makeOpenAIConceptsCaller(settings));
  return { ...out, provenance: settings.provenance };
}
