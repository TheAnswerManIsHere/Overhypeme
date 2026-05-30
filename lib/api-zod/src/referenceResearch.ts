/**
 * Reference research result schema (admin "Research Reference" tool).
 *
 * The admin enrichment editor's Cultural / Insider References editor has a
 * per-row "Research Reference" button that calls
 * `POST /api/admin/references/research`. The service uses the OpenAI
 * Responses API with the `web_search_preview` tool to look up the reference,
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

// Two-part check: any "render/use/display/show" directive within ~60
// characters of a forbidden noun (logo / brand mark / full fact text /
// hashtag). Catches "Render the real Apple logo" where intervening words
// (the brand name) sit between the verb and the noun.
const RENDER_VERB_RE = /\b(render|use|display|show)\b/i;
const FORBIDDEN_NOUN_RE = /\b(real\s+)?(logo|brand[-\s]?mark|full\s+fact\s+text|hashtags?)\b/i;

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
  //    brand marks, full fact text, or hashtags. We check whether a render
  //    verb and a forbidden noun BOTH appear; brand names between them are OK.
  for (const field of [data.explanation, data.visualImplication, data.researchNotes] as const) {
    if (RENDER_VERB_RE.test(field) && FORBIDDEN_NOUN_RE.test(field)) {
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
