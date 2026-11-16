/**
 * The fact character list — every person or animal a fact's locked wording
 * names besides the subject, offered as the choices for a bubble's speaker
 * (PLAN_BUBBLE_SPEAKERS.md, A–B).
 *
 * One producer: a dedicated, versioned call made inside `enrichFact` after
 * classification. It has its own prompt and its own strict response schema, so
 * the main classifier's contract and CLASSIFICATION_PROMPT_VERSION never move
 * because of it. The fill job (`factCharacterFillJob.ts`) calls the same
 * extractor, so a backfilled list and a freshly-enriched one cannot drift.
 *
 * Provenance: `charactersExtraction` is stamped ONLY when the call's output
 * validated (an empty list included). A failure leaves no marker on a fact
 * that never had a list, and keeps the prior list and marker on one that did
 * — the wording is locked, so a prior successful list is still the fact's.
 */
import { zodResponseFormat } from "openai/helpers/zod";
import {
  CHARACTER_LIST_PROMPT_VERSION,
  MAX_FACT_CHARACTERS,
  BUBBLE_ENTITY_MAX_CHARS,
  factCharactersSchema,
  factCharactersWireSchema,
  type CharactersExtraction,
  type EnrichmentOverrides,
  type FactCharacter,
  type FactEnrichment,
} from "@workspace/api-zod";
import { callUtilityLLM } from "./utilityLLM";
import { logger } from "./logger";
import { CANONICAL_SUBJECT_NAMES, CANONICAL_SUBJECT_NAME_FORMS_LC, possessive } from "./renderCanonical";

export const FACT_CHARACTERS_SYSTEM_PROMPT = [
  "You list the characters in a short exaggerated 'fact' about a person.",
  `The fact's subject is the person it is about. In the text you receive the subject is called ${CANONICAL_SUBJECT_NAMES.map((n) => `"${n}"`).join(" or ")} (they/them). NEVER list the subject.`,
  "List every OTHER person or animal the fact names or clearly refers to, who could be shown in a picture of the fact and could speak or think: relatives, pets, named people, roles (\"the referee\", \"a doctor\"), groups that act as one character (\"the crowd\").",
  "Do NOT list objects, places, abstractions, body parts, or things that merely exist in the scene. Do NOT invent characters the fact does not mention.",
  "For each character return:",
  "- label: a short, neutral, lowercase label a moderator would pick from a dropdown — \"mom\", \"dog\", \"referee\", \"chuck norris\" — with NO name of the subject, NO possessive (write \"mom\", never \"Alex's mom\" or \"his mom\"), no article, and no curly braces.",
  "- kind: \"person\" or \"animal\".",
  "- ofSubject: true when the character is the subject's own relation or possession (\"his mom\" → mom, true; \"their dog\" → dog, true); false otherwise (\"the referee\" → false).",
  `At most ${MAX_FACT_CHARACTERS}. Labels must be unique. Return an empty list when the subject is the only character.`,
].join("\n");

export class CharacterExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterExtractionError";
  }
}

const SUBJECT_POSSESSIVE_PREFIXES = CANONICAL_SUBJECT_NAMES.map((n) => `${possessive(n).toLowerCase()} `);
const PRONOUN_POSSESSIVE_PREFIXES = ["his ", "her ", "their ", "its "];

/**
 * Deterministic clean-up of the model's list before validation: trims, strips a
 * subject possessive ("Alex's mom" → "mom", ofSubject true), drops the subject
 * itself, the reserved word, tokens, over-long labels and duplicates, and clips
 * to the maximum. Never invents an entry.
 */
export function normalizeExtractedCharacters(raw: unknown): FactCharacter[] {
  const list = Array.isArray((raw as { characters?: unknown })?.characters)
    ? ((raw as { characters: unknown[] }).characters)
    : [];
  const out: FactCharacter[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    let label = typeof rec.label === "string" ? rec.label.trim().replace(/\s+/g, " ") : "";
    let ofSubject = rec.ofSubject === true;
    const kind = rec.kind === "animal" ? "animal" : rec.kind === "person" ? "person" : null;
    if (!label || !kind) continue;
    const lower = label.toLowerCase();
    const prefix = [...SUBJECT_POSSESSIVE_PREFIXES, ...PRONOUN_POSSESSIVE_PREFIXES].find((p) => lower.startsWith(p));
    if (prefix) {
      label = label.slice(prefix.length).trim();
      ofSubject = true;
    }
    const key = label.toLowerCase();
    if (!label || CANONICAL_SUBJECT_NAME_FORMS_LC.has(key) || key === "subject") continue;
    if (label.includes("{") || label.includes("}")) continue;
    if (label.length > BUBBLE_ENTITY_MAX_CHARS) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, kind, ofSubject });
    if (out.length >= MAX_FACT_CHARACTERS) break;
  }
  return out;
}

/** Parse + normalize + validate one model response. Throws on unusable output. */
export function parseCharacterResponse(rawText: string): FactCharacter[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CharacterExtractionError("character call returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { characters?: unknown }).characters)) {
    throw new CharacterExtractionError("character call returned no characters array");
  }
  const result = factCharactersSchema.safeParse(normalizeExtractedCharacters(parsed));
  if (!result.success) {
    throw new CharacterExtractionError(`character list failed validation: ${result.error.message}`);
  }
  return result.data;
}

export type CharacterModelCaller = (system: string, user: string) => Promise<string>;

/** Extract with an injected model caller (tests stub it). */
export async function extractFactCharactersWithModel(
  factText: string,
  callModel: CharacterModelCaller,
): Promise<FactCharacter[]> {
  const raw = await callModel(FACT_CHARACTERS_SYSTEM_PROMPT, `Fact: ${factText}`);
  return parseCharacterResponse(raw);
}

export interface CharacterLLMSettings {
  model?: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
  timeoutMs?: number;
}

/** The real call, on the enrichment engine's settings. */
export async function extractFactCharacters(
  factText: string,
  settings: CharacterLLMSettings,
): Promise<FactCharacter[]> {
  return extractFactCharactersWithModel(factText, async (system, user) => {
    const response = await callUtilityLLM({
      ...(settings.model ? { model: settings.model } : {}),
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
      responseFormat: zodResponseFormat(factCharactersWireSchema, "fact_characters"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return response.choices[0]?.message?.content ?? "";
  });
}

export function newCharactersExtraction(now: Date = new Date()): CharactersExtraction {
  return { promptVersion: CHARACTER_LIST_PROMPT_VERSION, extractedAt: now.toISOString() };
}

/** The prior list worth carrying forward, or null when it was never really extracted. */
export type PriorCharacters = Pick<FactEnrichment, "characters" | "charactersExtraction"> | null | undefined;

/**
 * Attach the fact's characters to a freshly classified enrichment. Success →
 * the list and a fresh marker. Failure → the prior list and marker when the
 * prior was really extracted; otherwise `[]` and NO marker (counted as
 * missing, retried by the fill job). Never throws.
 */
export async function attachCharacters(
  enrichment: FactEnrichment,
  prior: PriorCharacters,
  extract: () => Promise<FactCharacter[]>,
): Promise<FactEnrichment> {
  try {
    return withExtractedCharacters(enrichment, await extract());
  } catch (err) {
    logger.warn({ err }, "[factCharacters] character call failed; keeping prior list or leaving it missing");
    return withPriorCharactersOrMissing(enrichment, prior);
  }
}

/** A baseline with a really-extracted list: the list and a fresh marker, nothing else changed. */
export function withExtractedCharacters<T extends FactEnrichment>(enrichment: T, characters: FactCharacter[]): T {
  return { ...enrichment, characters, charactersExtraction: newCharactersExtraction() };
}

function withPriorCharactersOrMissing(enrichment: FactEnrichment, prior: PriorCharacters): FactEnrichment {
  const { charactersExtraction: _drop, ...rest } = enrichment;
  if (prior?.charactersExtraction) {
    return { ...rest, characters: prior.characters ?? [], charactersExtraction: prior.charactersExtraction };
  }
  return { ...rest, characters: [] };
}

/**
 * The part of a fact's override map a bulk re-enrich keeps. Both bulk backfills
 * reset overrides by design, but the oracle promises a moderator's character
 * correction survives re-enrichment (plan E) — so `/characters` alone is kept.
 * Widening this to every field is a separate behaviour change.
 */
export function charactersOverrideOnly(overrides: EnrichmentOverrides | null | undefined): EnrichmentOverrides {
  const kept = overrides?.["/characters"];
  return kept ? { "/characters": kept } : {};
}
