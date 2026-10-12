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

import { fal as vendorFal } from "@fal-ai/client";
import { logger } from "./logger";
import { aiBackend, recorder } from "./aiClients";
import { falDouble, type FalLike } from "./aiDouble/doubles";
import { recordingFal, recordFalPricing } from "./aiDouble/recorder";

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
  // Under the recorded double there is no key and none is needed. A non-secret
  // sentinel lets the gates in front of fal (the NSFW classifier on upload and
  // meme save) run against the double rather than silently skip.
  if (aiBackend() === "recorded-double") return FAL_DOUBLE_SENTINEL;
  const k = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  return k && k.trim() ? k : null;
}

/**
 * Configures the fal SDK from the env. Idempotent — safe to call from
 * anywhere, repeatedly. Throws when neither env var is set so callers get
 * an unambiguous failure mode instead of an opaque 401 from fal.ai.
 */
export function ensureFalConfigured(): void {
  if (aiBackend() === "recorded-double") return;
  const apiKey = getFalApiKey();
  if (!apiKey) {
    throw new Error(
      "FAL_AI_API_KEY (or FAL_KEY) environment variable is not set — fal.ai integration unavailable",
    );
  }
  if (configured && configuredKey === apiKey) return;
  vendorFal.config({ credentials: apiKey });
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

/** What `getFalApiKey()` returns under `AI_BACKEND=recorded-double`. Not a credential. */
export const FAL_DOUBLE_SENTINEL = "recorded-double";

let recordingClient: FalLike | null = null;

/** The fal client this call should use, resolved per call (design D2). */
function backendFal(): FalLike {
  switch (aiBackend()) {
    case "recorded-double":
      return falDouble;
    case "recorder": {
      if (!recordingClient) {
        const { allowance, ctx } = recorder();
        recordingClient = recordingFal(vendorFal as unknown as FalLike, allowance, ctx, (endpoint) => falUnitPrice(endpoint, ctx));
      }
      return recordingClient;
    }
    default:
      return vendorFal as unknown as FalLike;
  }
}

/** The recorder's price source: fal's pricing API (free), recorded as it is read. */
async function falUnitPrice(endpoint: string, ctx: { clients: Record<string, string> }): Promise<number | null> {
  const key = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  const res = await fetch(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`, {
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { prices?: Array<{ endpoint_id: string; unit_price: number; unit?: string }> };
  recordFalPricing(endpoint, body, ctx);
  const entry = body.prices?.find((p) => p.endpoint_id === endpoint);
  // Only a per-call unit can be reserved per call; anything else is an unknown price.
  if (!entry || !/^(image|images|request|requests)$/i.test(entry.unit ?? "")) return null;
  return Number(entry.unit_price);
}

/**
 * The shared fal client. A forwarding facade: each supported method resolves
 * the backend when it is invoked, so the selection is made per call, not when
 * this module loads. Typed as the SDK client so callers are unchanged.
 */
export const fal = {
  subscribe: (endpoint: string, opts: Parameters<FalLike["subscribe"]>[1]) => backendFal().subscribe(endpoint, opts),
  storage: { upload: (file: Blob, opts?: unknown) => backendFal().storage.upload(file, opts) },
  queue: {
    submit: (endpoint: string, opts: Parameters<FalLike["queue"]["submit"]>[1]) => backendFal().queue.submit(endpoint, opts),
    status: (endpoint: string, opts: Parameters<FalLike["queue"]["status"]>[1]) => backendFal().queue.status(endpoint, opts),
    result: (endpoint: string, opts: Parameters<FalLike["queue"]["result"]>[1]) => backendFal().queue.result(endpoint, opts),
  },
  config: (opts: unknown) => backendFal().config(opts),
} as unknown as typeof vendorFal;
