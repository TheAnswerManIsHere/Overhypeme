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
import { falDouble, falPricingReplay, type FalLike } from "./aiDouble/doubles";
import { recordingFal, recordFalPricing } from "./aiDouble/recorder";
import { imageSizePresetPx } from "./falImageSizes";

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
        recordingClient = recordingFal(vendorFal as unknown as FalLike, allowance, ctx, falUnitPrice);
      }
      return recordingClient;
    }
    default:
      return vendorFal as unknown as FalLike;
  }
}

const FAL_PRICING_API = "https://api.fal.ai/v1/models/pricing";

/**
 * The fal pricing API's answer for one endpoint, through the selected
 * backend: replayed from its recording under the double (never fetched),
 * fetched otherwise, and recorded as it is read under the recorder. Null
 * when it is unavailable; the caller parses the envelope.
 */
export async function fetchFalPricing(endpointId: string): Promise<unknown | null> {
  const backend = aiBackend();
  if (backend === "recorded-double") {
    try {
      return falPricingReplay(endpointId);
    } catch (err) {
      logger.warn({ endpointId, err: (err as Error).message }, "[falPricing] no recorded pricing under the AI double");
      return null;
    }
  }
  const apiKey = getFalApiKey();
  if (!apiKey) {
    logger.warn("[falPricing] No FAL API key found — skipping pricing fetch");
    return null;
  }
  const res = await fetch(`${FAL_PRICING_API}?endpoint_id=${encodeURIComponent(endpointId)}`, {
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, endpointId }, "[falPricing] Pricing API returned non-OK");
    return null;
  }
  const body = (await res.json()) as unknown;
  if (backend === "recorder") recordFalPricing(endpointId, body, recorder().ctx);
  return body;
}

/**
 * The recorder's price for one call of `endpoint`, from the pricing API.
 * Null when it cannot be bounded, and the recorder then refuses the call.
 */
export async function falUnitPrice(endpoint: string, input?: unknown): Promise<number | null> {
  return falCallPrice(await fetchFalPricing(endpoint), endpoint, input);
}

/**
 * One call's price from a pricing answer. A per-image or per-request unit is
 * the price as it stands. A per-megapixel unit (`fal-ai/flux-pulid`) is
 * bounded from the request: the output size from `image_size` (a fal preset,
 * an explicit `{ width, height }`, or fal's `landscape_4_3` default when the
 * request names none), rounded UP to whole megapixels, times `num_images`.
 * A size or count the request states but this cannot read is null, so the
 * call is refused rather than under-reserved.
 */
export function falCallPrice(body: unknown, endpoint: string, input?: unknown): number | null {
  const prices = (body as { prices?: Array<{ endpoint_id: string; unit_price: number; unit?: string }> } | null)?.prices;
  const entry = prices?.find((p) => p.endpoint_id === endpoint);
  if (!entry || !Number.isFinite(Number(entry.unit_price))) return null;
  const unit = Number(entry.unit_price);
  if (/^(image|images|request|requests)$/i.test(entry.unit ?? "")) return unit;
  if (!/^(megapixel|megapixels)$/i.test(entry.unit ?? "")) return null;
  const req = (input ?? {}) as { image_size?: unknown; num_images?: unknown };
  const size =
    req.image_size === undefined
      ? imageSizePresetPx("landscape_4_3")
      : typeof req.image_size === "string"
        ? imageSizePresetPx(req.image_size)
        : explicitSize(req.image_size);
  if (!size) return null;
  const count = req.num_images === undefined ? 1 : req.num_images;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
  return unit * Math.ceil((size.width * size.height) / 1_000_000) * count;
}

function explicitSize(v: unknown): { width: number; height: number } | null {
  const { width, height } = (v ?? {}) as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : null;
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
