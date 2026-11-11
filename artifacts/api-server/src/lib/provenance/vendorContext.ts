/**
 * @purpose What an AI picture's record keeps beyond the request it was made from (image tracing, #912, the completeness audit): what the vendor returned with the picture — the seed it actually used, its timings, its safety flags — and a content fingerprint of every reference picture the request named. The request names a reference only by a link (a fal storage URL that expires), so without the fingerprint a record could not say which picture the engine was shown.
 */
import { createHash } from "node:crypto";
import { selectedBackend } from "../doubleSelection";

/** One picture a request pointed the engine at, identified by its content. */
export interface ReferenceImage {
  /** Where the request named it (the JSON path), e.g. `image_urls[0]`. */
  at: string;
  /** The link, or `data:<type>;base64,…` for a picture sent inline (its bytes are already in the request). */
  url: string;
  sha256?: string;
  byteSize?: number;
  contentType?: string | null;
  /** Why it has no fingerprint, when it has none. */
  unhashed?: string;
}

export interface VendorContext {
  /** What the vendor returned with the picture, as returned (long inline strings replaced by their hash). */
  vendorResponse: unknown;
  referenceImages: ReferenceImage[];
}

const FETCH_TIMEOUT_MS = 15_000;

let fetchOverride: typeof fetch | null = null;
/** Test seam: read reference links through this instead of the network (a test run otherwise fetches nothing). */
export function __setReferenceFetchForTest(impl: typeof fetch | null): void {
  fetchOverride = impl;
}
const MAX_INLINE_STRING = 2048;

const isPictureKey = (key: string) => /image/i.test(key);
const isLink = (v: unknown): v is string => typeof v === "string" && /^(https?:|data:)/i.test(v);

/** Every link the request names under a key about images, with where it sits. */
function referenceLinks(request: unknown): Array<{ at: string; url: string }> {
  const out: Array<{ at: string; url: string }> = [];
  const walk = (v: unknown, at: string, pictureKey: boolean) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, pictureKey));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, at ? `${at}.${k}` : k, isPictureKey(k));
    } else if (pictureKey && isLink(v)) out.push({ at, url: v });
  };
  walk(request, "", false);
  return out;
}

async function fingerprint(at: string, url: string): Promise<ReferenceImage> {
  const shortUrl = url.startsWith("data:") ? `${url.slice(0, url.indexOf(",") + 1)}…` : url;
  try {
    let bytes: Buffer;
    let contentType: string | null;
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const meta = url.slice(5, comma);
      bytes = meta.endsWith(";base64") ? Buffer.from(url.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
      contentType = meta.replace(/;base64$/, "") || null;
    } else {
      // A recorded run's or a test's links point at nothing real; it says so rather than fetching.
      if (!fetchOverride && selectedBackend("AI_BACKEND") === "recorded-double") return { at, url, unhashed: "not fetched: a recorded AI double served this run" };
      // The test runners set this (scripts/lib/test-db.sh), as they set TEST_SKIP_EMBEDDINGS: tests fetch nothing.
      if (!fetchOverride && process.env.TEST_SKIP_REFERENCE_FETCH === "1") return { at, url, unhashed: "not fetched: a test run" };
      const res = await (fetchOverride ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return { at, url, unhashed: `the link answered ${res.status} when the picture was recorded` };
      bytes = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get("content-type");
    }
    return { at, url: shortUrl, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, contentType };
  } catch (err) {
    return { at, url: shortUrl, unhashed: `could not be read when the picture was recorded: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The vendor's result with any very long string (an inline picture) replaced by its hash, so the record stays small. */
function compact(v: unknown): unknown {
  if (typeof v === "string" && v.length > MAX_INLINE_STRING) {
    return { omitted: `${v.length} characters`, sha256: createHash("sha256").update(v).digest("hex") };
  }
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, compact(x)]));
  return v;
}

/**
 * The vendor context of an AI picture: the vendor's result (null when it was not available, e.g. a storage-only
 * retry) and a fingerprint of each reference picture the request named. Never throws: a reference that cannot be
 * read is recorded as such, with the reason.
 */
export async function vendorContext(request: unknown, vendorResult: unknown): Promise<VendorContext> {
  const referenceImages = await Promise.all(referenceLinks(request).map(({ at, url }) => fingerprint(at, url)));
  return { vendorResponse: vendorResult === undefined ? null : compact(vendorResult), referenceImages };
}
