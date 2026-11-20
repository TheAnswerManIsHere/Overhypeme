/**
 * The gag writer: one structured-outputs call drafts three candidate visual
 * gags for a fact (plan docs/plans/PLAN_GAG_GENERATOR.md, approved by David
 * 2026-11-13). It writes no joke read: the approved humor note is written
 * before it runs (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1C, increment 1.2d).
 *
 * - The system prompt is the text David locked (visualConceptsConfig.ts).
 * - The request is the caption with the stand-in name "Alex", the approved
 *   humor note, the violence and text limits, every gag the fact already has
 *   and the moderator's working draft. The classification is not sent (the
 *   blind check of PLAN_FACT_LIFECYCLE_REBUILD.md, 1A, passed).
 * - The model writes "Alex"; every scene and bubble line is converted to a
 *   token template by the existing tokenizer before the existing validation,
 *   sanitizing and budget preflight run. A conversion that leaves the stand-in
 *   name in place, or a scene with no subject token, is a failed conversion,
 *   never a pickable gag.
 * - The engine is set in code (openai-gag-writer, GPT-6
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
  CANDIDATE_VISUAL_CONCEPT_COUNT,
  VISUAL_CONCEPTS_PROMPT_VERSION,
  type CandidateConceptsWire,
  type RenderPolicy,
  type StoredCandidateConcept,
  type VisualConceptProvenance,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";
import { VIOLENCE_RULE } from "../imagePrompt/violenceRule";
import { callUtilityLLM } from "../utilityLLM";
import { rethrowIfOwnershipLost } from "../jobFence";
import { renderPersonalized } from "../renderCanonical";
import { hasNoLikelySubjectReference, tokenizePlainTextToTemplate } from "../factTokenizer";
import { getVisualConceptsSystem, getVisualConceptsEngineId, DEFAULT_VISUAL_CONCEPTS_ENGINE_ID } from "../visualConceptsConfig";
import { engineById } from "../engineInterpreter";
import { logger } from "../logger";



/** A frontier reasoning model at high effort needs minutes, not the 30s default. */
// Measured on dev 2026-11-14 (PR #936 post-merge, five facts): 100–211 s per
// call at high effort. 360 s leaves room above the slowest seen; with one
// corrective retry a job stays well under the queue's 30-minute stuck cutoff.
export const VISUAL_CONCEPTS_LLM_TIMEOUT_MS = 360_000;
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
  renderPolicy: RenderPolicy;
  /** The fact's approved humor note, or null. */
  humorNote: string | null;
  /**
   * Every gag the fact already has, in slot order (plan PLAN_THREE_GAGS.md,
   * increment 2): the version being worked on (a pending change, else the
   * approved version), leaving out a gag marked for removal. Empty when none.
   */
  existingGags: ContextGag[];
  /** The moderator's unsaved working draft (Regenerate). */
  draft: ContextGag | null;
}

export interface VisualConceptsGenerationResult {
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
    const engine = engineById(engineId);
    const reason = !engine
      ? "engine_not_found"
      : engine.kind !== "llm"
        ? "engine_not_llm"
        : engine.provider !== "openai"
          ? "engine_not_openai"
          : !engine.isActive
            ? "engine_inactive"
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

function gagLines(label: string, gag: ContextGag): string[] {
  const lines = [label, withStandIn(gag.scene.trim())];
  for (const b of gag.bubbles) {
    if (!b.text.trim()) continue;
    lines.push(`- ${b.type} bubble, ${b.entity === "subject" ? STAND_IN_NAME : b.entity}: "${withStandIn(b.text.trim())}"`);
  }
  return lines;
}

/**
 * The per-request message: only what a gag writer needs, absent blocks
 * omitted, no second copy of the output rules (those are in the system prompt).
 */
export function buildVisualConceptsUserMessage(input: GenerateVisualConceptsInput): string {
  const blocks: string[][] = [];

  blocks.push(["FACT (the caption):", withStandIn(input.factText.trim())]);

  if (input.humorNote?.trim()) {
    blocks.push(["APPROVED HUMOR NOTE (written or confirmed by a moderator; the correct reading of this joke):", input.humorNote.trim()]);
  }

  // The one violence rule, word for word: the sentence every picture's
  // prompt carries (plan PLAN_GAG_DIRECT_RENDER.md, B), so the writer and the
  // engine are held to the same limit.
  const t = input.renderPolicy.supportingText;
  const text = t.mode === "forbid"
    ? "No signs, labels or other words in the picture. Speech and thought bubbles are still allowed."
    : t.mode === "require"
      ? "Short words in the picture are required where they carry the gag."
      : "Short signs, labels and sound-effect words are allowed where they are visual evidence.";
  blocks.push([
    "LIMITS:",
    `Violence: ${VIOLENCE_RULE}`,
    `Text in the picture: ${text}${t.guidance ? ` Moderator guidance: ${t.guidance}` : ""}`,
  ]);

  // The fact's existing gags. One gag keeps the v3 wording; several are
  // listed together, numbered, under the same instruction (the locked system
  // prompt already speaks of "existing gags").
  const existing = input.existingGags.filter((g) => g.scene.trim());
  if (existing.length === 1) {
    blocks.push(gagLines("GAG THIS FACT ALREADY HAS (do not repeat its staging or payoff):", existing[0]!));
  } else if (existing.length > 1) {
    const lines = [`GAGS THIS FACT ALREADY HAS (${existing.length}; do not repeat the staging or payoff of any of them):`];
    existing.forEach((g, i) => lines.push(...gagLines(`Gag ${i + 1}:`, g)));
    blocks.push(lines);
  }
  if (input.draft?.scene.trim()) blocks.push(gagLines("MODERATOR'S WORKING DRAFT (propose alternatives to it):", input.draft));

  return blocks.map((b) => b.join("\n")).join("\n\n");
}

function buildCorrective(error: string): string {
  return `The previous response failed validation: ${error}\n\nReturn the full JSON object again: exactly ${CANDIDATE_VISUAL_CONCEPT_COUNT} concepts.`;
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
 * What a text that could not be converted becomes: one short invalid token,
 * shorter than every length cap, so the whole response still validates and
 * only that gag is stored unpickable (token validation names the token). The
 * reason goes to the log, never into the capped text. It is never stored
 * naming "Alex".
 */
export const CONVERSION_FAILED_MARKER = "{CONVERSION_FAILED}";

/**
 * Tries per text before it becomes CONVERSION_FAILED_MARKER. The tokenizer is
 * a model call, so one malformed, unconverted or failed response is usually
 * not repeated; a single try made that one response cost the gag for good.
 */
export const CONVERSION_ATTEMPTS = 2;

/**
 * Convert each scene and each bubble line from the stand-in name to a token
 * template; a text that cannot be converted in CONVERSION_ATTEMPTS tries
 * becomes CONVERSION_FAILED_MARKER.
 */
export async function convertStandInName(wire: CandidateConceptsWire, tokenize: TokenizeFn = defaultTokenize): Promise<CandidateConceptsWire> {
  // A scene always names the subject, so it always converts. A bubble line
  // converts when it refers to the subject: by name, or by a pronoun (the
  // tokenizer's own shared predicate). A line the subject speaks without
  // naming "Alex" stays exact: a third-person pronoun in the hero's own line
  // means someone else ("I heard that, and yes, they're real.").
  const convert = async (textIn: string, needsSubject: boolean, spokenBySubject = false): Promise<string> => {
    if (!needsSubject) {
      if (spokenBySubject && !STAND_IN_RE.test(textIn)) return textIn;
      if (hasNoLikelySubjectReference(textIn, [STAND_IN_NAME])) return textIn;
    }
    for (let attempt = 1; attempt <= CONVERSION_ATTEMPTS; attempt++) {
      try {
        const out = await tokenize(textIn);
        const problem = conversionProblem(textIn, out, needsSubject);
        if (!problem) return out.template;
        logger.warn({ problem, text: textIn, attempt, of: CONVERSION_ATTEMPTS }, "[visualConcepts.generator] the stand-in name could not be converted");
      } catch (err) {
        rethrowIfOwnershipLost(err); // Issue #1010
        logger.warn({ err, text: textIn, attempt, of: CONVERSION_ATTEMPTS }, "[visualConcepts.generator] the tokenizer failed on a gag line");
      }
    }
    return CONVERSION_FAILED_MARKER;
  };
  const concepts = await Promise.all(wire.concepts.map(async (c) => ({
    ...c,
    sceneDescription: await convert(c.sceneDescription, true),
    bubbles: await Promise.all(c.bubbles.map(async (b) => ({ ...b, text: await convert(b.text, false, b.entity.trim().toLowerCase() === "subject") }))),
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
): { ok: true; candidates: StoredCandidateConcept[] } | { ok: false; error: string } {
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

  return { ok: true, candidates };
}

type UserMessage = { role: "user"; content: string };

export async function generateVisualConceptsWithModel(
  input: GenerateVisualConceptsInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
  tokenize: TokenizeFn = defaultTokenize,
): Promise<{ candidates: StoredCandidateConcept[] }> {
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
  return { candidates: result.candidates };
}

/** Token counts of one gag-writer call, for a caller that reports cost. */
export interface VisualConceptsUsage {
  promptTokens: number;
  completionTokens: number;
}

export function makeOpenAIConceptsCaller(
  settings: VisualConceptsLLMSettings,
  onUsage?: (usage: VisualConceptsUsage) => void,
  /**
   * A candidate system prompt in place of the locked one. Only the gag-writer
   * preview script passes it, so David can judge a revision before he relocks
   * it (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1C); the product never does.
   */
  systemPromptOverride?: string,
): (userMessages: UserMessage[]) => Promise<string> {
  return async (userMessages: UserMessage[]): Promise<string> => {
    const systemPrompt = systemPromptOverride ?? (await getVisualConceptsSystem());
    const response = await callUtilityLLM({
      model: settings.model ?? undefined,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: settings.timeoutMs,
      responseFormat: zodResponseFormat(candidateConceptsWireSchema, "visual_concepts"),
      messages: [{ role: "system", content: systemPrompt }, ...userMessages],
    });
    if (onUsage && response.usage) {
      onUsage({ promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens });
    }
    return response.choices[0]?.message?.content ?? "{}";
  };
}

/**
 * Draft three candidate gags on the configured gag writer.
 * Throws VisualConceptsEngineUnusable when the engine cannot be used (no
 * fallback), VisualConceptsError on an unrecoverable response.
 */
export async function generateVisualConcepts(input: GenerateVisualConceptsInput): Promise<VisualConceptsGenerationResult> {
  const settings = await resolveVisualConceptsLLMSettings();
  if (settings.unusableReason) throw new VisualConceptsEngineUnusable(settings.unusableReason, settings.provenance.engineId);
  const out = await generateVisualConceptsWithModel(input, makeOpenAIConceptsCaller(settings));
  return { ...out, provenance: settings.provenance };
}
