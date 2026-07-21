/**
 * Shared render-style resolution (rev-7 plan sections 11.1-11.3).
 *
 * Today `resolveStylePrompt()` (imagePromptJobs.ts) queries `look_styles`
 * fresh EVERY worker run and collapses four different situations to the same
 * `""`: no style selected, the style row was deleted, the row is inactive,
 * and the row's suffix for this generation mode happens to be empty. That
 * means (a) a style edited/deactivated between enqueue and execution silently
 * changes a queued render, and (b) a genuine resolution failure quietly
 * becomes "no style" instead of a visible error. This module is the fix: one
 * resolver with an explicit result for every case, plus copy-length
 * validation so a customized style row can't blow the compiler's RENDER STYLE
 * budget reserve.
 *
 * Wiring this into attempt construction (resolve ONCE before enqueue, freeze
 * the result, never re-resolve live) is the next slice
 * (`prepareImagePromptAttemptInputs`) -- this module is the pure resolution
 * logic + snapshot shape it will use. The workbench/preview path adopts this
 * resolver too, replacing its own duplicated raw query.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, lookStylesTable } from "@workspace/db";
import type { GenerationMode } from "@workspace/api-zod";
import { DEFAULT_PHOTOREALISTIC_STYLE } from "./compilers/nanoBanana2";

/** The runtime + authoring invariant for style copy (plan 11.3) -- a
 *  customized row can be arbitrarily long in the DB (unbounded `text`
 *  columns), but must never exceed this to stay inside the compiler's RENDER
 *  STYLE budget reserve. */
export const RENDER_STYLE_COPY_MAX_CHARS = 180;

export type StyleInvalidReason = "not_found" | "inactive" | "empty_suffix" | "copy_too_long" | "copy_invalid";

export const RENDER_STYLE_SNAPSHOT_VERSION = 1 as const;

export interface ResolvedRenderStyleSnapshot {
  version: 1;
  selection: "default" | "selected";
  styleId: string | null;
  variant: GenerationMode;
  prompt: string;
  /** SHA-256 (lowercase hex) of the normalized UTF-8 prompt bytes -- style
   *  provenance, and the hook for future DB-only copy edits to invalidate a
   *  stale scenario/eval hash even when styleId is unchanged. */
  copyDigest: string;
  resolutionSource: "frozen" | "legacy_live_resolution";
}

export type ResolveRenderStyleResult =
  | { selection: "default"; styleId: null | "none"; variant: GenerationMode; prompt: string; copyDigest: string }
  | { selection: "selected"; styleId: string; variant: GenerationMode; prompt: string; copyDigest: string }
  | { selection: "invalid"; styleId: string; reason: StyleInvalidReason };

export type StyleCopyNormalizeResult = { ok: true; value: string } | { ok: false; reason: StyleInvalidReason };

// Control characters to reject in style copy, as explicit hex escapes (never a
// literal control byte in this source file): C0 controls except tab (\x09),
// LF (\x0A), and CR (\x0D) -- those are rejected separately by the
// single-line check below -- plus DEL (\x7F).
const CONTROL_CHAR_CODES = [
  ...Array.from({ length: 9 }, (_, i) => i),        // \x00-\x08
  0x0b, 0x0c,                                        // \x0B, \x0C
  ...Array.from({ length: 18 }, (_, i) => 0x0e + i), // \x0E-\x1F
  0x7f,
];
const CONTROL_CHAR_RE = new RegExp(`[${CONTROL_CHAR_CODES.map((c) => `\\x${c.toString(16).padStart(2, "0")}`).join("")}]`);

/**
 * Normalize + validate a raw style-copy string: trim outer whitespace,
 * require exactly one non-empty line (reject embedded newlines -- a
 * multi-line suffix is a copy-paste mistake, not intentional formatting),
 * reject embedded control characters, and enforce
 * `RENDER_STYLE_COPY_MAX_CHARS`. Preserves ordinary punctuation and Unicode
 * untouched. Pure. Shared by the read-time resolver here and any future
 * admin-write validator so the two can never define the bound differently.
 */
export function normalizeStyleCopy(raw: string): StyleCopyNormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty_suffix" };
  if (trimmed.includes("\n") || trimmed.includes("\r")) return { ok: false, reason: "copy_invalid" };
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false, reason: "copy_invalid" };
  if (trimmed.length > RENDER_STYLE_COPY_MAX_CHARS) return { ok: false, reason: "copy_too_long" };
  return { ok: true, value: trimmed };
}

/** SHA-256 (lowercase hex) of the normalized UTF-8 bytes of `prompt`. */
export function computeStyleCopyDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Resolve a style selection into an explicit result -- never a bare string
 * that collapses distinct failure modes to `""`.
 *
 * - `styleId` absent or `"none"` -> `default` (the compiler-owned
 *   photorealistic line).
 * - Otherwise: the row must exist, be active, and have a non-empty,
 *   length-valid suffix for `generationMode` -- any failure is `invalid` with
 *   a specific reason, never silently treated as "no style".
 */
export async function resolveRenderStyle(
  styleId: string | null | undefined,
  generationMode: GenerationMode,
): Promise<ResolveRenderStyleResult> {
  if (!styleId || styleId === "none") {
    return {
      selection: "default",
      styleId: styleId === "none" ? "none" : null,
      variant: generationMode,
      prompt: DEFAULT_PHOTOREALISTIC_STYLE,
      copyDigest: computeStyleCopyDigest(DEFAULT_PHOTOREALISTIC_STYLE),
    };
  }

  const [row] = await db
    .select({
      promptSuffix: lookStylesTable.promptSuffix,
      promptSuffixReference: lookStylesTable.promptSuffixReference,
      isActive: lookStylesTable.isActive,
    })
    .from(lookStylesTable)
    .where(eq(lookStylesTable.id, styleId))
    .limit(1);

  if (!row) return { selection: "invalid", styleId, reason: "not_found" };
  if (!row.isActive) return { selection: "invalid", styleId, reason: "inactive" };

  const raw = generationMode === "i2i" ? row.promptSuffixReference : row.promptSuffix;
  const normalized = normalizeStyleCopy(raw);
  if (!normalized.ok) return { selection: "invalid", styleId, reason: normalized.reason };

  return {
    selection: "selected",
    styleId,
    variant: generationMode,
    prompt: normalized.value,
    copyDigest: computeStyleCopyDigest(normalized.value),
  };
}

/** Turn a non-invalid resolution into the frozen snapshot shape. Callers must
 *  check `result.selection !== "invalid"` first -- this narrows accordingly. */
export function freezeRenderStyleSnapshot(
  result: Extract<ResolveRenderStyleResult, { selection: "default" | "selected" }>,
  resolutionSource: ResolvedRenderStyleSnapshot["resolutionSource"],
): ResolvedRenderStyleSnapshot {
  return {
    version: RENDER_STYLE_SNAPSHOT_VERSION,
    selection: result.selection,
    styleId: result.styleId,
    variant: result.variant,
    prompt: result.prompt,
    copyDigest: result.copyDigest,
    resolutionSource,
  };
}

/**
 * Runtime-validated read of a persisted snapshot from JSONB -- never trust a
 * bare type-cast on stored JSON.
 */
export function isValidRenderStyleSnapshot(value: unknown): value is ResolvedRenderStyleSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === RENDER_STYLE_SNAPSHOT_VERSION &&
    (v.selection === "default" || v.selection === "selected") &&
    (v.styleId === null || typeof v.styleId === "string") &&
    (v.variant === "i2i" || v.variant === "t2i") &&
    typeof v.prompt === "string" && v.prompt.trim().length > 0 &&
    typeof v.copyDigest === "string" && v.copyDigest.length === 64 &&
    (v.resolutionSource === "frozen" || v.resolutionSource === "legacy_live_resolution")
  );
}
