/**
 * Shared hashtag persistence helpers — the ONE place server-side code turns raw
 * tag strings (from AI suggestions, submitter input, or enrichment fallback)
 * into the normalized, denylist-filtered, deduped, capped list that gets written
 * to the hashtags table.
 *
 * Why this exists: hashtag normalization used to live in three places with
 * subtly different rules — `normalizeHashtag` in `@workspace/api-zod`
 * (strips ALL non-alphanumerics, incl. underscores), `attachHashtags` in
 * reviews.ts (a regex that KEPT underscores), and the enrichment denylist buried
 * in factEnrichment.ts. Same input → different stored tag depending on the path.
 * Everything now funnels through `sanitizeHashtagsForPersistence`, unifying on
 * the canonical `normalizeHashtag` rule.
 *
 * **Server-only.** The denylist depends on `CANONICAL_SUBJECT_NAMES` /
 * `possessive` from `renderCanonical` (server module). The browser must not
 * import this file.
 */

import { normalizeHashtag } from "@workspace/api-zod";
import { CANONICAL_SUBJECT_NAMES, possessive } from "./renderCanonical";

// ─── Suggested-hashtag denylist (subject name + app name) ────────────────────
//
// Two kinds of tag must never reach a fact's hashtags, no matter what produced
// them:
//   1. The SUBJECT'S name. Classifiers/suggesters see the fact rendered to the
//      canonical placeholder "Alex" (they/them), so they naturally propose
//      "alex" — but that is a stand-in for whoever the meme is personalized to,
//      not a real topic.
//   2. The APP'S own name. Prompts are steeped in "Overhype.me" branding, so the
//      model leaks "overhype" / "overhypeme" as a discovery tag.
//
// (Previously lived in factEnrichment.ts; moved here because the denylist is a
// general hashtag concern, not enrichment-only.)
const APP_NAME_HASHTAGS: readonly string[] = ["overhype", "overhypeme"];

// Include the POSSESSIVE form of each subject name: canonical rendering can feed
// "{NAME_POSSESSIVE}" → "Alex's", and normalizeHashtag("Alex's") is "alexs" —
// distinct from "alex", so it would otherwise slip the filter.
const DENIED_HASHTAGS: ReadonlySet<string> = new Set<string>(
  [...CANONICAL_SUBJECT_NAMES, ...CANONICAL_SUBJECT_NAMES.map((n) => possessive(n)), ...APP_NAME_HASHTAGS]
    .map((t) => normalizeHashtag(t))
    .filter((t) => t.length > 0),
);

/** Drop subject-name / app-name tags (matched on normalized form). */
export function stripDeniedHashtags(tags: readonly string[]): string[] {
  return tags.filter((t) => typeof t === "string" && !DENIED_HASHTAGS.has(normalizeHashtag(t)));
}

/**
 * Turn arbitrary tag input into the attachable list: string-only → normalize →
 * drop empty → strip denied → dedupe (first-seen order) → cap at `limit`.
 *
 * `limit` is REQUIRED (no hidden default) so each call site owns its business
 * limit explicitly — suggestions (6), submitter input (10), enrichment fallback
 * (8). Accepts `unknown[]` and defends against non-string members so it can be
 * pointed at raw request bodies / parsed model JSON without a pre-cast.
 */
export function sanitizeHashtagsForPersistence(
  tags: readonly unknown[],
  opts: { limit: number },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeHashtag(raw.trim());
    if (!normalized) continue;
    if (DENIED_HASHTAGS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Approval-time precedence: the submitter's valid tags are the source of truth;
 * the enrichment-suggested tags are the fallback used ONLY when the submitter
 * left no valid tags (so a fact is never left untagged). Both candidate sources
 * are sanitized FIRST, then chosen by sanitized length — a submission of only
 * denied/invalid tags (e.g. `["alex","overhype"]`) sanitizes to empty and
 * correctly falls through to the enrichment tags rather than producing zero tags.
 */
export function resolveTagsForApproval(
  reviewHashtags: readonly unknown[] | null | undefined,
  enrichmentHashtags: readonly unknown[] | null | undefined,
): string[] {
  const submitted = sanitizeHashtagsForPersistence(reviewHashtags ?? [], { limit: 10 });
  if (submitted.length > 0) return submitted;
  return sanitizeHashtagsForPersistence(enrichmentHashtags ?? [], { limit: 8 });
}

/**
 * The FINAL discovery-tag list attached at production approval.
 *
 * - `bodyHashtags` **present** (the moderation UI always sends the curated list,
 *   even when empty) → it is authoritative; sanitized and used verbatim.
 * - `bodyHashtags` **absent** (`undefined` — legacy / non-UI callers) → fall back
 *   to the submitter's tags, else the AI suggestions.
 *
 * Presence is `!== undefined`, NOT truthiness: an empty array is a deliberate
 * "no tags" signal and must not silently fall back. The caller (approval) then
 * rejects an empty result, since a fact can't ship without tags.
 */
export function resolveFinalApprovalTags(
  bodyHashtags: readonly unknown[] | undefined,
  reviewHashtags: readonly unknown[] | null | undefined,
  enrichmentHashtags: readonly unknown[] | null | undefined,
): string[] {
  return bodyHashtags !== undefined
    ? sanitizeHashtagsForPersistence(bodyHashtags, { limit: 10 })
    : resolveTagsForApproval(reviewHashtags, enrichmentHashtags);
}
