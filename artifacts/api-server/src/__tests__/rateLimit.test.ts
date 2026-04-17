import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createRateLimiter, RATE_MAX, RATE_WINDOW_MS } from "../lib/rateLimit.js";

function makeReq(opts: { ip?: string; sessionId?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.sessionId) {
    headers["authorization"] = `Bearer ${opts.sessionId}`;
  }
  return {
    ip: opts.ip ?? "127.0.0.1",
    headers,
    cookies: {},
  } as unknown as Request;
}

function makeRes(): Response & { statusCode: number; body: unknown } {
  let statusCode = 200;
  let responseBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      responseBody = body;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return responseBody;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("createRateLimiter", () => {
  it("allows all requests within the rate limit", () => {
    const middleware = createRateLimiter();
    const req = makeReq({ ip: "10.0.0.1" });

    for (let i = 0; i < RATE_MAX; i++) {
      const res = makeRes();
      let nextCalled = false;
      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.ok(nextCalled, `request ${i + 1} should call next()`);
      assert.notEqual(res.statusCode, 429, `request ${i + 1} must not be rejected`);
    }
  });

  it("returns 429 when requests exceed the limit", () => {
    const middleware = createRateLimiter();
    const req = makeReq({ ip: "10.0.0.2" });

    for (let i = 0; i < RATE_MAX; i++) {
      middleware(req, makeRes(), () => {});
    }

    const res = makeRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, "next() must not be called when limit is exceeded");
    assert.equal(res.statusCode, 429, "response status must be 429");
    const body = res.body as Record<string, unknown>;
    assert.ok(typeof body?.["error"] === "string", "response must include an error message");
  });

  it("resets the counter after the window expires", () => {
    let fakeNow = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => fakeNow;

    try {
      const middleware = createRateLimiter();
      const req = makeReq({ ip: "10.0.0.3" });

      for (let i = 0; i < RATE_MAX; i++) {
        middleware(req, makeRes(), () => {});
      }

      const blockedRes = makeRes();
      let blockedNextCalled = false;
      middleware(req, blockedRes, () => {
        blockedNextCalled = true;
      });
      assert.equal(blockedNextCalled, false, "should be blocked before window resets");
      assert.equal(blockedRes.statusCode, 429, "should return 429 before window resets");

      fakeNow += RATE_WINDOW_MS + 1;

      const afterRes = makeRes();
      let afterNextCalled = false;
      middleware(req, afterRes, () => {
        afterNextCalled = true;
      });
      assert.ok(afterNextCalled, "should be allowed again after window resets");
      assert.notEqual(afterRes.statusCode, 429, "should not return 429 after window resets");
    } finally {
      Date.now = originalNow;
    }
  });

  it("uses session ID as the rate-limit key instead of IP", () => {
    const middleware = createRateLimiter();
    const sessionId = "session-abc-123";

    const sessionReq = makeReq({ ip: "10.0.0.4", sessionId });
    for (let i = 0; i < RATE_MAX; i++) {
      middleware(sessionReq, makeRes(), () => {});
    }

    const sessionBlockedRes = makeRes();
    let sessionBlockedNextCalled = false;
    middleware(sessionReq, sessionBlockedRes, () => {
      sessionBlockedNextCalled = true;
    });
    assert.equal(sessionBlockedNextCalled, false, "session should be blocked after limit");
    assert.equal(sessionBlockedRes.statusCode, 429, "session should get 429 after limit");

    const ipOnlyReq = makeReq({ ip: "10.0.0.4" });
    const ipRes = makeRes();
    let ipNextCalled = false;
    middleware(ipOnlyReq, ipRes, () => {
      ipNextCalled = true;
    });
    assert.ok(ipNextCalled, "same IP without a session token should not inherit the session's limit");
    assert.notEqual(ipRes.statusCode, 429, "IP-keyed requests should not be blocked by session's counter");
  });
});
