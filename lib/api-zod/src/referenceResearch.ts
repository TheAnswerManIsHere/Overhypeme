/**
 * Reference research result schema (admin "Research Reference" tool).
 *
 * The admin enrichment editor's Cultural / Insider References editor has a
 * per-row "Research Reference" button that calls
 * `POST /api/admin/references/research`. The service uses the OpenAI
 * Responses API with the `web_search` tool to look up the reference,
 * then returns a structured result the admin can apply into the form (filling
 * in `explanation` + `visualImplication`).
 *
 * The result NEVER persists automatically — it's surfaced to the admin who
 * applies it into form state, then the existing save/approve flow persists
 * the edited enrichment. Research metadata is also attached as optional
 * fields on the stored `CulturalReference` (researchSources / researchNotes /
 * researchConfidence / ambiguityWarnings / researchedAt / researchedBy) so
 * approved enrichments carry a trace of what informed the explanation.
 *
 * Wire schemas are STRICT (every field required, no transforms / defaults /
 * refinements) for OpenAI Structured Outputs. Business rules live in
 * `validateReferenceResearchResult`.
 */

import { z } from "zod";

export const REFERENCE_RESEARCH_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type ReferenceResearchConfidence = (typeof REFERENCE_RESEARCH_CONFIDENCE_VALUES)[number];

export const REFERENCE_RESEARCH_SOURCE_TYPE_VALUES = [
  "official",
  "encyclopedic",
  "news",
  "community",
  "search_result",
  "admin_context",
  "other",
] as const;
export type ReferenceResearchSourceType = (typeof REFERENCE_RESEARCH_SOURCE_TYPE_VALUES)[number];

export interface ReferenceResearchInput {
  factText: string;
  sourcePhrase: string;
  referenceType: string;
  canonicalReference: string;
  existingExplanation?: string;
  existingVisualImplication?: string;
  adminNotes?: string;
}

export interface ReferenceResearchSource {
  title: string;
  url: string;
  sourceType: ReferenceResearchSourceType;
  summary: string;
}

export interface ReferenceResearchResult {
  explanation: string;
  visualImplication: string;
  confidence: ReferenceResearchConfidence;
  sources: ReferenceResearchSource[];
  researchNotes: string;
  ambiguityWarnings: string[];
  /**
   * Server-side computed: true iff confidence ∈ {high, medium} AND no ambiguity
   * warnings AND visualImplication carries concrete visual guidance. The
   * frontend uses this to decide auto-apply when both target fields are empty.
   */
  canAutoApplyToEmptyFields: boolean;
  researchedAt: string;
  researchedBy: "ai_reference_research";
}

// ─── Wire schemas (strict) ────────────────────────────────────────────────

const referenceResearchSourceWireSchema = z.object({
  title: z.string(),
  url: z.string(),
  sourceType: z.enum(REFERENCE_RESEARCH_SOURCE_TYPE_VALUES),
  summary: z.string(),
});

// The wire schema is what the LLM returns. canAutoApplyToEmptyFields,
// researchedAt, researchedBy are stamped by the service AFTER validation,
// so they're absent from the wire form.
export const referenceResearchResultWireSchema = z.object({
  explanation: z.string(),
  visualImplication: z.string(),
  confidence: z.enum(REFERENCE_RESEARCH_CONFIDENCE_VALUES),
  sources: z.array(referenceResearchSourceWireSchema),
  researchNotes: z.string(),
  ambiguityWarnings: z.array(z.string()),
});
export type ReferenceResearchResultWire = z.infer<typeof referenceResearchResultWireSchema>;

// ─── Business validator ───────────────────────────────────────────────────

// Forbidden-directive check (#672). Each mention of a forbidden noun — logo,
// brand mark, full fact text, hashtag; singular or plural — is judged by the
// clause leading up to it: it is a violation only when a render directive
// (render/use/display/show) reaches it without a negation in between. So
// "Render the real Apple logo" and "avoid clutter, but show the Peloton logo"
// are rejected, while "Show {NAME} … Avoid logos and hashtags", "show no
// logos" and "do not show the logo" — the avoidance guidance the system prompt
// asks for — are accepted. The previous check flagged any field containing
// both a render verb and a forbidden noun anywhere, which rejected exactly
// that avoidance guidance, and its trailing word boundary missed plurals.
const RENDER_VERB_SRC = "render|use|display|show";
const FORBIDDEN_NOUN_RE = /\b(?:logos?|brand[-\s]?marks?|full\s+fact\s+text|hashtags?)\b/gi;
// "do not show", "don't render", "never display", "not use" negate the verb itself.
const NEGATED_VERB_RE = new RegExp(
  `\\b(?:do\\s+not|does\\s+not|don['’]t|doesn['’]t|never|not)\\s+(?:${RENDER_VERB_SRC})\\b`,
  "gi",
);
const RENDER_VERB_RE = new RegExp(`\\b(?:${RENDER_VERB_SRC})\\b`, "gi");
const NEGATION_RE =
  /\b(?:avoid|avoiding|no|not|never|without|exclude|excluding|omit|omitting|free\s+of|instead\s+of|rather\s+than|NEGATED_VERB)\b/gi;

/** Index just past the last match of `re` in `text`, or -1. */
function lastMatchEnd(re: RegExp, text: string): number {
  let end = -1;
  for (const m of text.matchAll(re)) end = (m.index ?? 0) + m[0].length;
  return end;
}

/** Whether `field` directs the image model to render a forbidden noun. */
function hasForbiddenRenderDirective(field: string): boolean {
  const text = field.replace(NEGATED_VERB_RE, "NEGATED_VERB");
  for (const m of text.matchAll(FORBIDDEN_NOUN_RE)) {
    const at = m.index ?? 0;
    // The clause leading up to this mention: back to the previous sentence end.
    const sentenceStart = Math.max(
      text.lastIndexOf(".", at - 1),
      text.lastIndexOf("!", at - 1),
      text.lastIndexOf("?", at - 1),
      text.lastIndexOf(";", at - 1),
      text.lastIndexOf("\n", at - 1),
    ) + 1;
    const prefix = text.slice(sentenceStart, at);
    const verbEnd = lastMatchEnd(RENDER_VERB_RE, prefix);
    if (verbEnd !== -1 && verbEnd > lastMatchEnd(NEGATION_RE, prefix)) return true;
  }
  return false;
}

export type ReferenceResearchValidationResult =
  | { ok: true; data: ReferenceResearchResultWire }
  | { ok: false; error: string; correctableHint?: string };

/**
 * Validate a raw research result against the wire schema + business rules.
 * Public/cultural/brand references with `confidence: "high"` MUST cite at
 * least one source; the visualImplication must carry concrete visual
 * guidance, not just a definition; the result must not recommend rendering
 * real logos, brand marks, full fact text, or hashtags.
 */
export function validateReferenceResearchResult(
  raw: unknown,
  expectations: { referenceType: string },
): ReferenceResearchValidationResult {
  const parsed = referenceResearchResultWireSchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error, correctableHint: error };
  }
  const data = parsed.data;

  // 1. explanation non-empty after trim.
  if (data.explanation.trim().length === 0) {
    return {
      ok: false,
      error: "explanation must not be empty",
      correctableHint: "Return a concise factual explanation of the reference.",
    };
  }
  // 2. visualImplication non-empty after trim.
  if (data.visualImplication.trim().length === 0) {
    return {
      ok: false,
      error: "visualImplication must not be empty",
      correctableHint:
        "Return concrete visual guidance — what the image should show or avoid because of this reference.",
    };
  }
  // 3. visualImplication must carry concrete visual guidance (not just a
  //    definition that ends at "X is a Y" with no visual verbs / nouns).
  if (!hasConcreteVisualGuidance(data.visualImplication)) {
    return {
      ok: false,
      error: "visualImplication reads as a definition; needs concrete visual guidance",
      correctableHint:
        "Describe what the image should show, what setting or props to use, or what visual misunderstanding to avoid. Don't just define the reference.",
    };
  }
  // 4. confidence=high on a public/cultural/brand reference must cite ≥1 source.
  const publicRefKinds = new Set([
    "brand_reference",
    "workplace_reference",
    "cultural_reference",
    "brand_or_cultural_reference",
    "brand_or_retail_reference",
    "pop_culture_reference",
    "internet_meme",
    "media_reference",
    "place_reference",
  ]);
  if (
    data.confidence === "high" &&
    publicRefKinds.has(expectations.referenceType) &&
    data.sources.length === 0
  ) {
    return {
      ok: false,
      error: `confidence "high" on a public ${expectations.referenceType} requires at least one source`,
      correctableHint:
        "Either cite at least one source URL from the web search, or downgrade confidence to medium/low.",
    };
  }
  // 5. forbidden directives — never tell the image model to render real logos,
  //    brand marks, full fact text, or hashtags. Avoidance guidance ("avoid
  //    logos") is fine; see hasForbiddenRenderDirective.
  for (const field of [data.explanation, data.visualImplication, data.researchNotes] as const) {
    if (hasForbiddenRenderDirective(field)) {
      return {
        ok: false,
        error: "research result recommends rendering forbidden content (real logo / brand mark / full fact text / hashtags)",
        correctableHint:
          "Reference real brands by their visual context (boutique, fashion-retail) without telling the image model to render the actual logo or trademark.",
      };
    }
  }

  return { ok: true, data };
}

/**
 * Compute the post-validation `canAutoApplyToEmptyFields` flag. Surfaced as
 * a helper so the route handler and the cache layer stamp the same value
 * (false when confidence is low, when there are ambiguity warnings, or when
 * sources are absent on a public reference type).
 */
export function computeCanAutoApplyToEmptyFields(
  result: ReferenceResearchResultWire,
  referenceType: string,
): boolean {
  if (result.confidence === "low") return false;
  if (result.ambiguityWarnings.length > 0) return false;
  const publicRefKinds = new Set([
    "brand_reference",
    "workplace_reference",
    "cultural_reference",
    "brand_or_cultural_reference",
    "brand_or_retail_reference",
    "pop_culture_reference",
    "internet_meme",
    "media_reference",
    "place_reference",
  ]);
  if (publicRefKinds.has(referenceType) && result.sources.length === 0) return false;
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const VISUAL_GUIDANCE_RE =
  /\b(show|display|render|frame|compose|stage|scene|background|foreground|setting|environment|prop|atmosphere|lighting|color|palette|texture|costume|outfit|gesture|pose|expression|composition|cinematic|wide\s*shot|close[-\s]*up|medium\s*shot|silhouette|reflection|reveal|focus|avoid|do\s*not\s*(show|render)|instead\s+of|rather\s+than)\b/i;

/**
 * Heuristic: does the visualImplication contain visual-domain verbs / nouns?
 * Rejects pure definitions like "Apple is a technology company that makes phones."
 */
function hasConcreteVisualGuidance(s: string): boolean {
  return VISUAL_GUIDANCE_RE.test(s);
}
