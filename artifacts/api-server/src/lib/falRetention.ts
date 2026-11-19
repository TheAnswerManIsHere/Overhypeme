/**
 * @purpose How long fal.ai keeps what this app gives it and what it generates (launch Phase 14, increment 6b: vendor expiry), stated once so the retention schedule and the Privacy page can name it: the bundled default reference photos, the generated pictures, and the headers every raw queue submit sends.
 * @subsystem visual-pipeline
 *
 * fal keeps two kinds of copy, controlled separately (fal, *Data Retention &
 * Storage*, read 2026-11-19):
 * - files on its CDN, uploaded inputs and generated outputs alike, kept for
 *   as long as `X-Fal-Object-Lifecycle-Preference` says (an account default
 *   otherwise);
 * - request payloads (inputs and outputs in request history), kept "for 90
 *   days by default". Render recovery reads that history to find a lost
 *   receipt (`renderFalTransport.ts`, `history`), so render requests keep it;
 *   it holds the default reference's address and a sample name, never a
 *   member's photo or account. The member's photo for the safety classifier
 *   is handled in `moderation/nsfwClassifier.ts` (an hour, and no history).
 */

const DAY_SECONDS = 24 * 60 * 60;

/**
 * The default reference photos (David, his wife, his cat; `defaultReferenceResolver.ts`)
 * expire a year after each upload. The address is saved into render attempts
 * and comparison panels and reused by a retry or the judging page, so it has
 * to outlive the cache by a wide margin; the cache renews it after
 * `REFERENCE_URL_RENEW_AFTER_MS`, so a new render never sends an address
 * older than that.
 */
export const REFERENCE_UPLOAD_LIFECYCLE = { expiresIn: "1y" } as const;

/** A cached reference address is uploaded afresh once it is this old. */
export const REFERENCE_URL_RENEW_AFTER_MS = 30 * DAY_SECONDS * 1000;

/**
 * Generated pictures stay on fal's CDN for 30 days. The app copies each
 * picture into its own storage as soon as it is collected; a comparison
 * cell whose copy failed retries from fal's address, which 30 days covers.
 */
export const GENERATED_OUTPUT_EXPIRY_SECONDS = 30 * DAY_SECONDS;

/** The headers a raw POST to fal's queue sends: the key, and the outputs' expiry. */
export function falQueueSubmitHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
    "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: GENERATED_OUTPUT_EXPIRY_SECONDS }),
  };
}
