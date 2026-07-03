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

import { normalizeHashtag, DENIED_HASHTAGS, isDeniedHashtag } from "@workspace/api-zod";
import { CANONICAL_SUBJECT_NAMES, possessive } from "./renderCanonical";

// ─── Suggested-hashtag denylist ──────────────────────────────────────────────
//
// The denylist (subject placeholder name + app name + generic-humor terms) is
// the SHARED, browser-safe `DENIED_HASHTAGS` from @workspace/api-zod, so the
// server and the moderation "Add hashtag" button enforce exactly one list.
//
// Belt-and-suspenders: api-zod encodes the subject-name forms as the fixed
// "alex"/"alexs" literals; we also union renderCanonical's authoritative
// CANONICAL_SUBJECT_NAMES (+ their possessives) here so that if a second
// canonical placeholder is ever added server-side, server-side stripping picks
// it up even before the api-zod literals are updated. (The client denylist
// would still need the api-zod update to match — there is exactly one canonical
// name today, so the two are in sync.)
const SERVER_DENIED_HASHTAGS: ReadonlySet<string> = new Set<string>([
  ...DENIED_HASHTAGS,
  ...CANONICAL_SUBJECT_NAMES.map((n) => normalizeHashtag(n)),
  ...CANONICAL_SUBJECT_NAMES.map((n) => normalizeHashtag(possessive(n))),
].filter((t) => t.length > 0));

/** Drop denied (subject / app / generic-humor) tags, matched on normalized form. */
export function stripDeniedHashtags(tags: readonly string[]): string[] {
  return tags.filter((t) => typeof t === "string" && !SERVER_DENIED_HASHTAGS.has(normalizeHashtag(t)));
}

// Re-export the shared client-facing predicate so callers importing from this
// server module get the same check the UI uses.
export { isDeniedHashtag };

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
    if (SERVER_DENIED_HASHTAGS.has(normalized)) continue;
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
