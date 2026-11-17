/**
 * Cast extraction: who is in a gag's scene besides the subject (plan
 * `docs/plans/PLAN_GAG_DIRECT_RENDER.md`, *Proposed Design* C).
 *
 * The one producer of a cast. It reads one gag's scene, the speakers of its
 * bubbles and the fact's character list, and returns each character the scene
 * shows other than the subject, with a short description that identifies them
 * in the picture. The direct path binds a bubble's speaker to that
 * description (`compileDirect`), so a balloon's tail lands on the right
 * person without a planner.
 *
 * - It binds, it never renames: every bubble speaker the scene shows comes
 *   back under exactly the speaker's own string, and a bubble is never
 *   changed. A speaker the scene does not show comes back in
 *   `unboundSpeakers`, and is never invented into the cast.
 * - The fact's character list is for labels only: a character it names is
 *   labelled as the fact labels them, and no character is added because the
 *   list names them.
 * - A failure throws; it is never an empty cast. An empty cast is a real
 *   result: nobody else is in the scene.
 * - The engine is set in code: the utility model (`UTILITY_LLM_ENGINE_ID`).
 *
 * Increment 1 uses it in comparison preparation only.
 *
 * @purpose Reads one gag's scene and bubble speakers and returns the characters it shows besides the subject, each with a short identifying description; the one producer of a gag's cast.
 * @subsystem visual-pipeline
 */
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { BUBBLE_ENTITY_MAX_CHARS, SPEAKER_BINDING_ROLE_MAX_CHARS, activeBubbleSpeakers, type VisualStrategyBubble } from "@workspace/api-zod";
import { callUtilityLLM } from "../utilityLLM";
import { CANONICAL_SUBJECT_NAME_FORMS_LC, renderPersonalized } from "../renderCanonical";
import { shortSpeakerRole } from "../imagePrompt/compilers/nanoBanana2";

/** Bumped whenever the prompt or the normalization below changes. */
export const CAST_EXTRACTION_PROMPT_VERSION = "v1";
export const MAX_CAST = 10;
/** The stand-in name the scene is read with: never a real member's name. */
const STAND_IN = "Alex";

export interface CastEntry {
  label: string;
  description: string;
}

export interface CastExtraction {
  promptVersion: string;
  extractedAt: string;
}

export interface CastExtractionResult {
  cast: CastEntry[];
  /** Bubble speakers (not the subject) the scene does not show; the gag cannot be drawn as it stands. */
  unboundSpeakers: string[];
  extraction: CastExtraction;
}

export class CastExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastExtractionError";
  }
}

export const castWireSchema = z.object({
  cast: z.array(z.object({ label: z.string(), description: z.string() })),
});

export const CAST_SYSTEM_PROMPT = [
  "You read the scene of a picture and list who is in it.",
  `The picture's subject is called ${STAND_IN}. NEVER list ${STAND_IN}, and never use ${STAND_IN}'s name in a label or a description.`,
  "List every OTHER person or animal the scene shows or clearly places in the picture. Do not list objects, places or crowds of unnamed extras unless a speaker label names them.",
  "For each, return:",
  "- label: a short, neutral, lowercase label (\"mom\", \"bartender\", \"dog\").",
  "- description: a few words that pick that character out in the picture, taken from the scene (\"the older woman in the passenger seat\"). Describe what is visible; never explain the joke.",
  "Rules for labels:",
  "- When the request lists SPEAKERS, each speaker the scene shows must appear with its label written EXACTLY as given, character for character. A speaker the scene does not show is left out; never invent one.",
  "- When the request lists FACT CHARACTERS and the scene shows one of them, use that label.",
  "- Labels are unique.",
  `At most ${MAX_CAST}. Return an empty list when ${STAND_IN} is the only character.`,
].join("\n");

export interface CastExtractionInput {
  /** The gag's scene, as stored (tokens allowed). */
  scene: string;
  bubbles: readonly Pick<VisualStrategyBubble, "entity" | "text">[];
  /** The fact's character labels (enrichment `characters`), for naming only. */
  factCharacterLabels?: readonly string[];
}

/** The user message: the scene read with the stand-in name, the speakers, the fact's labels. */
export function buildCastUserMessage(input: CastExtractionInput): string {
  const scene = renderPersonalized(input.scene.trim(), STAND_IN, "they/them");
  const speakers = activeBubbleSpeakers(input.bubbles);
  const lines = [`SCENE: ${scene}`];
  if (speakers.length) lines.push(`SPEAKERS: ${speakers.map((s) => `"${s}"`).join(", ")}`);
  const labels = (input.factCharacterLabels ?? []).map((l) => l.trim()).filter(Boolean);
  if (labels.length) lines.push(`FACT CHARACTERS: ${labels.map((l) => `"${l}"`).join(", ")}`);
  return lines.join("\n");
}

/**
 * Deterministic clean-up before the result is used: trims, drops the subject,
 * tokens, the reserved word, empty or over-long labels and duplicates, writes
 * a speaker's label exactly as the bubble does when they match ignoring case,
 * shortens descriptions to the binding's length and clips to the maximum.
 * Never invents an entry.
 */
export function normalizeCast(raw: unknown, speakers: readonly string[]): CastEntry[] {
  const list = Array.isArray((raw as { cast?: unknown })?.cast) ? (raw as { cast: unknown[] }).cast : [];
  const speakerByKey = new Map(speakers.map((s) => [s.trim().toLowerCase(), s.trim()]));
  const out: CastEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    let label = typeof rec.label === "string" ? rec.label.trim().replace(/\s+/g, " ") : "";
    const description = typeof rec.description === "string" ? shortSpeakerRole(rec.description, SPEAKER_BINDING_ROLE_MAX_CHARS) : "";
    const key = label.toLowerCase();
    if (!label || !description) continue;
    if (CANONICAL_SUBJECT_NAME_FORMS_LC.has(key) || key === "subject") continue;
    if (label.includes("{") || label.includes("}") || label.length > BUBBLE_ENTITY_MAX_CHARS) continue;
    if (seen.has(key)) continue;
    label = speakerByKey.get(key) ?? label;
    seen.add(key);
    out.push({ label, description });
    if (out.length >= MAX_CAST) break;
  }
  return out;
}

/** Parse one model response into a cast and the speakers it leaves unbound. Throws on unusable output. */
export function parseCastResponse(rawText: string, input: CastExtractionInput, now: Date = new Date()): CastExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CastExtractionError("cast extraction returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { cast?: unknown }).cast)) {
    throw new CastExtractionError("cast extraction returned no cast list");
  }
  const speakers = activeBubbleSpeakers(input.bubbles);
  const cast = normalizeCast(parsed, speakers);
  const bound = new Set(cast.map((c) => c.label));
  return {
    cast,
    unboundSpeakers: speakers.filter((s) => !bound.has(s.trim())),
    extraction: { promptVersion: CAST_EXTRACTION_PROMPT_VERSION, extractedAt: now.toISOString() },
  };
}

export type CastModelCaller = (system: string, user: string) => Promise<string>;

/** Extract with an injected model caller (tests stub it). */
export async function extractCastWithModel(input: CastExtractionInput, callModel: CastModelCaller): Promise<CastExtractionResult> {
  if (!input.scene.trim()) throw new CastExtractionError("the gag has no scene to read");
  return parseCastResponse(await callModel(CAST_SYSTEM_PROMPT, buildCastUserMessage(input)), input);
}

/** The real call, on the utility model. */
export async function extractCast(input: CastExtractionInput): Promise<CastExtractionResult> {
  return extractCastWithModel(input, async (system, user) => {
    const response = await callUtilityLLM({
      responseFormat: zodResponseFormat(castWireSchema, "gag_cast"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return response.choices[0]?.message?.content ?? "";
  });
}
