/**
 * Prompt-identity snapshot resolution (rev-7 plan §11.5).
 *
 * Today `resolveAttemptIdentity()` (imagePromptJobs.ts) freezes identity ONLY
 * for moderation attempts (`reviewRenderSubject`); an ordinary user attempt
 * re-queries the LIVE user in the worker while its fact text was already
 * frozen at enqueue — so a profile edit between click and render can produce a
 * prompt whose fact text and moderator-Concept tokens/binding use two
 * different identities. This module is the fix: a versioned snapshot resolved
 * ONCE and reused everywhere for a given render (fact text, Concept tokens,
 * subject binding, the compiler's final token gate, preview, and
 * scenario/eval hashing).
 *
 * A second, independent thing happens here: the identity used INSIDE the
 * image prompt is reduced to a short prompt-safe name (David's decision,
 * 2026-07-20 — "no reason to feed a full display name to an image model").
 * This is scoped to the image-prompt-GENERATION pipeline only — the
 * separately-composited meme caption (`memeComposite.ts`) keeps using the
 * full stored identity, untouched.
 *
 * The reduction is NOT a new bound on what users may store: the profile
 * name/pronoun bound is (and stays) `validators/personalName.ts`, which this
 * module does not duplicate or second-guess. `reducePromptName` /
 * `clampPronouns` only shorten an already-validated value for prompt use.
 *
 * Wiring this snapshot into the attempt-construction/async-handler flow (so
 * it is actually FROZEN before enqueue and consumed instead of a live query)
 * is the next slice (`prepareImagePromptAttemptInputs`) — this module is the
 * pure, testable resolution logic it will call.
 */

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { RENDERED_IDENTITY_NAME_MAX } from "@workspace/api-zod";
import { CANONICAL_NAME } from "../renderCanonical";

export const PROMPT_IDENTITY_SNAPSHOT_VERSION = 1 as const;

export type PromptIdentitySource =
  | "user"
  | "review_sample"
  | "eval_sample"
  | "workbench"
  | "canonical_fallback";

export interface PromptIdentitySnapshot {
  version: 1;
  /** Prompt-reduced — at most RENDERED_IDENTITY_NAME_MAX grapheme clusters. */
  name: string;
  /** As stored, defensively length-clamped per side (see clampPronouns). */
  pronouns: string | null;
  source: PromptIdentitySource;
}

// ─── Grapheme-safe reduction ────────────────────────────────────────────────

/**
 * Truncate to at most `max` grapheme clusters — never a raw UTF-16/code-point
 * slice, which can split a combining mark or split a surrogate pair mid-emoji.
 * Uses `Intl.Segmenter` (available in the Node runtime this project targets);
 * falls back to code-point iteration (correct for surrogate pairs, not for
 * combining marks) if `Intl.Segmenter` is ever unavailable, so this can never
 * throw.
 */
export function graphemeSafeTruncate(s: string, max: number): string {
  if (!s || max <= 0) return "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const clusters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
      (x) => x.segment,
    );
    return clusters.length <= max ? s : clusters.slice(0, max).join("");
  }
  const codePoints = [...s];
  return codePoints.length <= max ? s : codePoints.slice(0, max).join("");
}

/**
 * Reduce a validated identity to a prompt-safe short name: prefer `firstName`
 * when present; else the FIRST whitespace-delimited token of `displayName`
 * (never a raw slice of the whole name — "Alexandra Smith-Jones" reduces to
 * "Alexandra", not a truncated fragment of the full string); else the
 * canonical fallback name. Always grapheme-safe-bounded to
 * RENDERED_IDENTITY_NAME_MAX. Pure.
 */
export function reducePromptName(identity: { firstName?: string | null; displayName?: string | null }): string {
  const first = (identity.firstName ?? "").trim();
  if (first) return graphemeSafeTruncate(first, RENDERED_IDENTITY_NAME_MAX);

  const display = (identity.displayName ?? "").trim();
  if (display) {
    const firstToken = display.split(/\s+/)[0] ?? display;
    return graphemeSafeTruncate(firstToken, RENDERED_IDENTITY_NAME_MAX);
  }

  return CANONICAL_NAME;
}

/**
 * Defensively bound each side of a "subj/obj" pronoun string to
 * RENDERED_IDENTITY_NAME_MAX. Profile pronouns are already word-length-capped
 * at write time by `validators/personalName.ts` (default 20 chars/word), so
 * this is normally a no-op — it exists so a legacy/unvalidated row can never
 * violate the budget-projection guarantee (`promptIdentityBudget.ts` assumes
 * every pronoun-derived token is <= RENDERED_IDENTITY_NAME_MAX). Preserves the
 * original string byte-for-byte when no side needs clamping.
 */
export function clampPronouns(pronouns: string | null | undefined): string | null {
  if (!pronouns) return null;
  const parts = pronouns.split("/");
  const clamped = parts.map((p) => graphemeSafeTruncate(p.trim(), RENDERED_IDENTITY_NAME_MAX));
  if (clamped.every((p, i) => p === parts[i]!.trim())) return pronouns;
  return clamped.filter(Boolean).join("/");
}

// ─── Snapshot builders ──────────────────────────────────────────────────────

/** The canonical fallback identity — anonymous/admin render, no user/sample. */
export function canonicalPromptIdentity(): PromptIdentitySnapshot {
  return { version: PROMPT_IDENTITY_SNAPSHOT_VERSION, name: CANONICAL_NAME, pronouns: null, source: "canonical_fallback" };
}

/**
 * Build the frozen prompt identity for a user render: looks up the user's
 * validated firstName/displayName/pronouns and reduces them for prompt use.
 * A missing/deleted user resolves to the canonical fallback rather than
 * throwing.
 */
export async function resolvePromptIdentityForUser(userId: string): Promise<PromptIdentitySnapshot> {
  const [u] = await db
    .select({ firstName: usersTable.firstName, displayName: usersTable.displayName, pronouns: usersTable.pronouns })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!u) return canonicalPromptIdentity();
  return {
    version: PROMPT_IDENTITY_SNAPSHOT_VERSION,
    name: reducePromptName(u),
    pronouns: clampPronouns(u.pronouns),
    source: "user",
  };
}

/**
 * Build a frozen prompt identity from a pre-sampled name+pronouns (a
 * moderation review sample or an eval sample — see
 * `resolveRenderReviewInput.ts` / `evalRunJobs.ts`). The sample is already a
 * chosen display identity; only the prompt-safe reduction is applied here.
 */
export function resolvePromptIdentityFromSample(
  sample: { name: string; pronouns: string | null },
  source: Extract<PromptIdentitySource, "review_sample" | "eval_sample">,
): PromptIdentitySnapshot {
  return {
    version: PROMPT_IDENTITY_SNAPSHOT_VERSION,
    name: reducePromptName({ displayName: sample.name }),
    pronouns: clampPronouns(sample.pronouns),
    source,
  };
}

/**
 * Build a frozen prompt identity from the canonical workbench test name
 * (`RUNTIME_PREVIEW_DEFAULT_NAME`) — kept as its own `source` tag (distinct
 * from `canonical_fallback`) so preview/debug provenance can tell "the
 * workbench's fixed test identity" apart from "no identity was available."
 */
export function resolvePromptIdentityForWorkbench(name: string, pronouns: string | null): PromptIdentitySnapshot {
  return {
    version: PROMPT_IDENTITY_SNAPSHOT_VERSION,
    name: reducePromptName({ displayName: name }),
    pronouns: clampPronouns(pronouns),
    source: "workbench",
  };
}

/**
 * Runtime-validated read of a persisted snapshot from JSONB — never trust a
 * bare type-cast on stored JSON.
 */
export function isValidPromptIdentitySnapshot(value: unknown): value is PromptIdentitySnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const validSources: readonly string[] = ["user", "review_sample", "eval_sample", "workbench", "canonical_fallback"];
  return (
    v.version === PROMPT_IDENTITY_SNAPSHOT_VERSION &&
    typeof v.name === "string" && v.name.trim().length > 0 &&
    (v.pronouns === null || typeof v.pronouns === "string") &&
    typeof v.source === "string" && validSources.includes(v.source)
  );
}
