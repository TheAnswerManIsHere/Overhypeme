import { describe, it, expect } from "vitest";
import {
  PollHttpError,
  isRetryablePollError,
  pollHttpErrorFromResponse,
  retryDelayMsFor,
} from "../util/pollRetryClassification";

function responseWith(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("pollHttpErrorFromResponse", () => {
  it("carries the status through", () => {
    const err = pollHttpErrorFromResponse(responseWith(429));
    expect(err.status).toBe(429);
  });

  it("parses a numeric Retry-After into seconds", () => {
    const err = pollHttpErrorFromResponse(responseWith(429, { "Retry-After": "30" }));
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("yields null when Retry-After is absent", () => {
    expect(pollHttpErrorFromResponse(responseWith(429)).retryAfterSeconds).toBeNull();
  });

  it("yields null for an HTTP-date Retry-After rather than NaN", () => {
    // The spec allows a date form. We don't support it, but we must degrade to
    // "no instruction" rather than propagate NaN into a setTimeout delay.
    const err = pollHttpErrorFromResponse(
      responseWith(503, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    expect(err.retryAfterSeconds).toBeNull();
  });
});

describe("isRetryablePollError", () => {
  it("is true for 429", () => {
    expect(isRetryablePollError(new PollHttpError(429))).toBe(true);
  });

  it("is false for 503 even when it carries Retry-After", () => {
    // Status alone decides. A persistent generic 503 may legitimately send
    // Retry-After; treating that as retryable would spin forever on a dead
    // upstream instead of surfacing the failure.
    expect(isRetryablePollError(new PollHttpError(503, 5))).toBe(false);
  });

  it("is false for 404 and for a plain Error", () => {
    expect(isRetryablePollError(new PollHttpError(404))).toBe(false);
    expect(isRetryablePollError(new Error("network down"))).toBe(false);
  });
});

describe("retryDelayMsFor", () => {
  it("honors Retry-After over the caller's fallback", () => {
    expect(retryDelayMsFor(new PollHttpError(429, 30), 500)).toBe(30_000);
  });

  it("uses the caller's fallback when Retry-After is absent", () => {
    expect(retryDelayMsFor(new PollHttpError(429), 500)).toBe(500);
  });

  it("ignores a non-positive Retry-After so the delay is never zero-or-negative", () => {
    expect(retryDelayMsFor(new PollHttpError(429, 0), 500)).toBe(500);
    expect(retryDelayMsFor(new PollHttpError(429, -1), 500)).toBe(500);
  });
});
