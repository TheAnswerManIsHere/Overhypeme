/**
 * Shared prompt-content detectors (PR-A, plan §6).
 *
 * Two pure, dependency-light detectors with ONE definition each, so the
 * compiler, the planner validator, the VSO save path, and their tests never
 * drift on the same regexes:
 *
 *   - `detectOwnedLanguage` — prose that authors a clause the COMPILER owns
 *     (identity/likeness preservation, reference-image operation, readable-text/
 *     logo policy). The compiler strips this from AI planner prose and warns
 *     (non-mutating) on a moderator Concept; the VSO save path shows the same as
 *     an amber advisory.
 *   - `detectMediumClaim` — an explicit artistic-MEDIUM / rendering-technique
 *     claim (anime, oil painting, cel-shaded, …). Style is compiler-owned
 *     (single-channel), so a planner-authored medium claim fails validation.
 *     Deliberately conservative: mood/staging words ("dramatic", "cinematic",
 *     "moody", "gritty", "epic") are NOT medium claims and must pass.
 *
 * Both operate on plain prose and return the matched substring (for admin-visible
 * findings), or null. They do NOT mutate. Token-interpretation detection stays
 * in the compiler (it needs the api-server token renderer); these three prose
 * categories are the portable part.
 */

export type OwnedLanguageCategory = "identity" | "reference" | "text_policy";

export interface OwnedLanguageFinding {
  category: OwnedLanguageCategory;
  matchedText: string;
}

// Ordered category patterns. Each is matched against the raw text; the finding
// with the earliest match position wins, so `matchedText` points at the real
// offending phrase rather than an arbitrary category.
const OWNED_LANGUAGE_PATTERNS: Array<{ category: OwnedLanguageCategory; re: RegExp }> = [
  {
    category: "reference",
    re: /\b(?:reference|uploaded|source)\s+(?:image|photo|picture|person)\b|\bimage-to-image\b|\bi2i\b|\btext-to-image\b|\bt2i\b/i,
  },
  {
    category: "identity",
    re: /\b(?:preserv\w*|maintain|keep|retain)\b[^.!?]*\b(?:face|facial|identity|likeness|recognizable|same person)\b|\b(?:face|facial|identity|likeness|recognizable)\b[^.!?]*\b(?:preserv\w*|maintain|keep|retain)\b|\brecognizable face\b|\bfacial identity\b/i,
  },
  {
    category: "text_policy",
    re: /\b(?:readable text|captions?|watermarks?|logos?|brand marks?)\b|\bfree of\b[^.!?]*\b(?:text|captions?|watermarks?|logos?|brand marks?)\b/i,
  },
];

/**
 * The first compiler-owned-language finding in `text` (by match position), or
 * null. Pure.
 */
export function detectOwnedLanguage(text: string): OwnedLanguageFinding | null {
  if (!text) return null;
  let best: { finding: OwnedLanguageFinding; index: number } | null = null;
  for (const { category, re } of OWNED_LANGUAGE_PATTERNS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { finding: { category, matchedText: m[0] }, index: m.index };
    }
  }
  return best?.finding ?? null;
}

export interface MediumClaimFinding {
  matchedText: string;
}

// Unambiguous artistic-medium nouns + technique markers that only occur in a
// medium context. NOT included (mood/staging/lighting — legitimately physical):
// dramatic, cinematic, moody, atmospheric, gritty, epic, vibrant, chiaroscuro
// (a lighting term). "photorealistic" is matched only as an explicit rendering
// claim ("photorealistic rendering/style", "hyper-photorealistic"), never bare,
// since it doubles as a quality descriptor and is the compiler-owned default.
const MEDIUM_CLAIM_RE =
  /\b(?:anime|manga|cartoon|comic book|comic-book|oil painting|watercolou?r|pixel art|pixel-art|claymation|stop[- ]motion|pop art|pop-art|ukiyo-e|woodblock print|stained glass|pencil sketch|charcoal drawing|pastel drawing|3d render|cgi|low[- ]poly|vaporwave|cel[- ]shaded|cel shading|halftone|ben-day|impasto|line art|vector art|cross-hatching|graffiti art|street art)\b|\bhyper-photorealistic\b|\bphotorealistic (?:rendering|style|render)\b|\brendered (?:as|in) (?:an? )?(?:oil painting|watercolou?r|comic|anime|pixel|sketch|painting)\b/i;

/**
 * The first explicit medium/rendering-technique claim in `text`, or null. Pure.
 * Conservative by design — see the exclusions above.
 */
export function detectMediumClaim(text: string): MediumClaimFinding | null {
  if (!text) return null;
  const m = MEDIUM_CLAIM_RE.exec(text);
  return m ? { matchedText: m[0] } : null;
}

/**
 * A sentence/entry that AUTHORS a balloon/bubble render directive — the shape,
 * tail/trail, or "bubble reading …" lettering claims. ONE definition shared by
 * the compiler (which strips planner prose while moderator bubbles are active)
 * and candidate-concept validation (which rejects a sceneDescription that
 * authors a balloon alongside structured `bubbles` — the single-channel rule).
 * Deliberately narrow: ordinary dialogue context ("the father looks surprised
 * at what he said") must never match.
 */
export const BUBBLE_DIRECTIVE_LANGUAGE_RE =
  /\b(?:speech|thought|word|dialogue)\s+(?:bubble|balloon)s?\b|\bthought\s+cloud\b|\b(?:bubble|balloon)\s+(?:reading|saying|containing|that\s+(?:reads|says))\b/i;

/** First bubble-directive phrase in `text`, or null. Pure. */
export function detectBubbleDirectiveLanguage(text: string): string | null {
  if (!text) return null;
  const m = BUBBLE_DIRECTIVE_LANGUAGE_RE.exec(text);
  return m ? m[0] : null;
}
