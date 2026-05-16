/**
 * Layer 3 — pixel-level NSFW classifier on every generated/composited image.
 *
 * Calls the fal.ai endpoint named in `admin_config.nsfw_classifier_endpoint`
 * (default `fal-ai/imageutils/nsfw`). Stored as a string so we can swap to
 * `x-ailab/nsfw` or any future model with a single config row update.
 *
 * Decision matrix is owned by the caller:
 *   - score < threshold                                 → accept
 *   - score >= threshold && !user.nsfwModeEnabled       → reject + quarantine
 *   - score >= threshold &&  user.nsfwModeEnabled       → accept and tag is_nsfw
 *
 * On classifier error the call site checks `isNsfwClassifierFailOpen()`:
 *   - false (default) → 503 fail-closed
 *   - true            → log warn + allow through (upload proceeds without NSFW tag)
 *
 * Set `admin_config` key `nsfw_classifier_fail_open = "true"` to enable.
 */

import { fal } from "@fal-ai/client";
import { getConfigInt, getConfigString } from "../adminConfig";
import { logger } from "../logger";

export const DEFAULT_NSFW_ENDPOINT = "fal-ai/imageutils/nsfw";
export const DEFAULT_NSFW_THRESHOLD = 0.85;

export interface NsfwClassifierResult {
  score: number;
  model: string;
  raw: unknown;
}

export interface NsfwClassifierOverrides {
  /** Test hook: stub the fal client. */
  falImpl?: { subscribe: (model: string, opts: { input: Record<string, unknown>; logs?: boolean }) => Promise<unknown> };
  endpoint?: string;
  timeoutMs?: number;
}

/** Extracts the score field from the various shapes fal.ai NSFW endpoints can return. */
export function extractNsfwScore(raw: unknown): number | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const data = (r["data"] as Record<string, unknown> | undefined) ?? r;
  const candidates: unknown[] = [
    data["nsfw_score"],
    data["score"],
    data["nsfw_probability"],
    data["nsfw"],
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "boolean") return c ? 1 : 0;
  }
  return null;
}

/**
 * Run the configured fal.ai NSFW classifier against a publicly reachable
 * image URL (typically the fal storage URL we just uploaded to, or a signed
 * download URL from our object storage).
 */
export async function classifyNsfwByUrl(
  imageUrl: string,
  overrides: NsfwClassifierOverrides = {},
): Promise<NsfwClassifierResult> {
  const endpoint = overrides.endpoint ?? (await getConfigString("nsfw_classifier_endpoint", DEFAULT_NSFW_ENDPOINT));
  const timeoutMs = overrides.timeoutMs ?? (await getConfigInt("nsfw_classifier_timeout_ms", 15_000));
  const fallback: typeof fal = fal;
  const client = overrides.falImpl ?? fallback;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // fal.subscribe doesn't expose abort directly; we wrap in Promise.race
    // so callers honour the configured timeout regardless of SDK behaviour.
    const raw = await Promise.race([
      client.subscribe(endpoint, { input: { image_url: imageUrl }, logs: false }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`NSFW classifier timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const score = extractNsfwScore(raw) ?? 0;
    return { score, model: endpoint, raw };
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

/**
 * When true, classifier timeouts / errors let the upload through instead of
 * returning 503. Mirrors the `isArachnidFailOpen()` pattern in arachnid.ts.
 * Controlled via `admin_config` key `nsfw_classifier_fail_open`.
 */
export async function isNsfwClassifierFailOpen(): Promise<boolean> {
  return (await getConfigString("nsfw_classifier_fail_open", "false")).toLowerCase() === "true";
}

export async function getNsfwThreshold(): Promise<number> {
  const raw = await getConfigString("nsfw_classifier_threshold", String(DEFAULT_NSFW_THRESHOLD));
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    logger.warn({ raw }, "[nsfwClassifier] threshold misconfigured; falling back to default");
    return DEFAULT_NSFW_THRESHOLD;
  }
  return parsed;
}

export type NsfwDecision =
  | { outcome: "accept"; score: number; model: string; raw: unknown; isNsfwTag: boolean }
  | { outcome: "reject"; score: number; model: string; raw: unknown }
  | { outcome: "error"; message: string };

/**
 * Run classifier and apply the decision matrix. Caller passes the user's
 * `nsfwModeEnabled` flag.
 */
export async function classifyAndDecide(
  imageUrl: string,
  opts: { nsfwModeEnabled: boolean; overrides?: NsfwClassifierOverrides },
): Promise<NsfwDecision> {
  let result: NsfwClassifierResult;
  try {
    result = await classifyNsfwByUrl(imageUrl, opts.overrides ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "error", message };
  }
  const threshold = opts.overrides?.endpoint ? DEFAULT_NSFW_THRESHOLD : await getNsfwThreshold();
  if (result.score >= threshold) {
    if (opts.nsfwModeEnabled) {
      return { outcome: "accept", score: result.score, model: result.model, raw: result.raw, isNsfwTag: true };
    }
    return { outcome: "reject", score: result.score, model: result.model, raw: result.raw };
  }
  return { outcome: "accept", score: result.score, model: result.model, raw: result.raw, isNsfwTag: false };
}
