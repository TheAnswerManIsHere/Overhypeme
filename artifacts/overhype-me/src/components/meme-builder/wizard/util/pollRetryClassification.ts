/**
 * Shared retry classification for the wizard's job-polling loops
 * (step2-video's GodModeLoadingTakeover, step2-image's PulidLoadingTakeover).
 *
 * The API's global rate limiter (see artifacts/api-server/src/lib/rateLimit.ts)
 * gives these polling loops their first-ever 429 path — until now a non-OK
 * poll response could only mean a real server problem. A poller must
 * distinguish the two: a rate-limiter 429 is retryable indefinitely (the job
 * is still running server-side, the client is just being told to slow down),
 * while a persistent generic failure (5xx, 404, etc.) must still terminate.
 *
 * Classification is on status 429 ONLY, never on the presence of a
 * `Retry-After` header — a persistent generic 503 can legitimately carry
 * that header too, and treating that as retryable would trade "a burst of
 * 429s kills a live job" for "a dead upstream spins forever."
 */

const DEFAULT_RETRY_BACKOFF_MS = 2_000;

/**
 * Thrown by a job-polling fetch when the server returns a non-OK response.
 * Carries the HTTP status and, if present, the `Retry-After` header (in
 * seconds) so callers can classify and back off without losing that
 * information to a stringified error message.
 */
export class PollHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null = null) {
    super(`poll: ${status}`);
    this.name = "PollHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Builds a `PollHttpError` from a non-OK fetch `Response`. */
export function pollHttpErrorFromResponse(res: Response): PollHttpError {
  const raw = res.headers.get("retry-after");
  const parsed = raw !== null ? Number(raw) : NaN;
  return new PollHttpError(res.status, Number.isFinite(parsed) ? parsed : null);
}

/** True only for a rate-limiter response — status 429, and status alone. */
export function isRetryablePollError(err: unknown): err is PollHttpError {
  return err instanceof PollHttpError && err.status === 429;
}

/**
 * Delay before the next poll after a retryable (429) response: honors the
 * server's `Retry-After` when present, otherwise a fixed backoff — either
 * way, longer than the normal poll interval so the client isn't hammering
 * the limiter it just tripped.
 */
export function retryDelayMsFor(err: PollHttpError, fallbackMs: number = DEFAULT_RETRY_BACKOFF_MS): number {
  if (err.retryAfterSeconds !== null && err.retryAfterSeconds > 0) {
    return err.retryAfterSeconds * 1000;
  }
  return fallbackMs;
}
