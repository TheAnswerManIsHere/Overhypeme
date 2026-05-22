/**
 * Single source of truth for fal.ai client configuration.
 *
 * Before this module existed, eight separate call sites (videoPipelineRunner,
 * falAutoSubtitle, aiMemePipeline, userImageUpload, createMemeRecord,
 * adminEngines, routes/videos.ts, falPricing.ts) each repeated the same
 * three-step dance:
 *
 *   1. read `process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"]`
 *   2. throw / warn when missing
 *   3. `fal.config({ credentials: apiKey })`
 *
 * Forgetting step 3 in a new route produced a misleading
 * `ApiError: Unauthorized ("Authorization header is required")` from fal's
 * SDK — which the frontend surfaced verbatim, leading users to think their
 * own auth had failed. Two call sites also read only FAL_AI_API_KEY (not
 * the FAL_KEY fallback), so half the codebase silently worked under one
 * env var name and half under the other.
 *
 * This module centralizes both concerns. Call `ensureFalConfigured()`
 * either once at server boot (preferred) or defensively at any call site
 * — it's idempotent, so cost is a single Map lookup after the first hit.
 * Re-export `fal` from here for convenience but the underlying SDK module
 * state is shared regardless of import path.
 */

import { fal } from "@fal-ai/client";
import { logger } from "./logger";

let configured = false;
let configuredKey: string | null = null;

/**
 * Reads the fal API key from env. Returns null when neither variable is
 * set; callers that need a hard fail should use `ensureFalConfigured()`
 * (which throws), not this. Exported separately so callsites can detect
 * "fal is not available in this environment" and skip cleanly (e.g. the
 * NSFW classifier short-circuit in memes.ts).
 */
export function getFalApiKey(): string | null {
  const k = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  return k && k.trim() ? k : null;
}

/**
 * Configures the fal SDK from the env. Idempotent — safe to call from
 * anywhere, repeatedly. Throws when neither env var is set so callers get
 * an unambiguous failure mode instead of an opaque 401 from fal.ai.
 */
export function ensureFalConfigured(): void {
  const apiKey = getFalApiKey();
  if (!apiKey) {
    throw new Error(
      "FAL_AI_API_KEY (or FAL_KEY) environment variable is not set — fal.ai integration unavailable",
    );
  }
  if (configured && configuredKey === apiKey) return;
  fal.config({ credentials: apiKey });
  configured = true;
  configuredKey = apiKey;
  if (!configured) {
    // First-time wire-up — log once so deploy logs make the credential
    // hookup visible without leaking the key itself.
    logger.info("[falClient] fal.ai client configured");
  }
}

/** Reset module state. Test-only — production never resets the client. */
export function __resetFalClientForTests(): void {
  configured = false;
  configuredKey = null;
}

export { fal };
