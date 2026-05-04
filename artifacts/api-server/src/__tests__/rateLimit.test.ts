import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { createRateLimiter, RATE_MAX, RATE_WINDOW_MS } from "../lib/rateLimit.js";
import { purgeExpiredRateLimitCounters } from "../lib/sharedRateLimiter.js";
import { db, rateLimitCountersTable } from "@workspace/db";
import { like } from "drizzle-orm";

const RUN_ID = crypto.randomUUID();

function makeReq(opts: { ip?: string; sessionId?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.sessionId) headers["authorization"] = `Bearer ${opts.sessionId}`;
  return { ip: opts.ip ?? "127.0.0.1", headers, cookies: {} } as unknown as Request;
}
function makeRes(): Response & { statusCode: number; body: unknown } { let statusCode = 200; let responseBody: unknown; const res = { status(code: number) { statusCode = code; return res; }, json(body: unknown) { responseBody = body; }, get statusCode() { return statusCode; }, get body() { return responseBody; } }; return res as unknown as Response & { statusCode: number; body: unknown }; }
async function runMw(mw: ReturnType<typeof createRateLimiter>, req: Request) { const res = makeRes(); let nextCalled = false; await mw(req, res, () => { nextCalled = true; }); return { res, nextCalled }; }

describe("createRateLimiter", () => {
  before(async () => {
    await db.delete(rateLimitCountersTable).where(like(rateLimitCountersTable.keyRaw, "rl|test.%"));
  });

  it("shares state across limiter instances", async () => {
    const endpoint = `test.shared.${RUN_ID}`;
    const a = createRateLimiter(endpoint, 3, RATE_WINDOW_MS);
    const b = createRateLimiter(endpoint, 3, RATE_WINDOW_MS);
    const req = makeReq({ ip: "10.0.0.44" });
    assert.equal((await runMw(a, req)).nextCalled, true);
    assert.equal((await runMw(b, req)).nextCalled, true);
    assert.equal((await runMw(a, req)).nextCalled, true);
    const blocked = await runMw(b, req);
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.res.statusCode, 429);
  });

  it("returns 429 when requests exceed the limit", async () => {
    const middleware = createRateLimiter(`test.exceed.${RUN_ID}`, RATE_MAX, RATE_WINDOW_MS);
    const req = makeReq({ ip: "10.0.0.2" });
    for (let i = 0; i < RATE_MAX; i++) await runMw(middleware, req);
    const blocked = await runMw(middleware, req);
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.res.statusCode, 429);
  });

  it("uses session ID as part of the key", async () => {
    const middleware = createRateLimiter(`test.sid.${RUN_ID}`, RATE_MAX, RATE_WINDOW_MS);
    const sessionReq = makeReq({ ip: "10.0.0.4", sessionId: "session-abc-123" });
    for (let i = 0; i < RATE_MAX; i++) await runMw(middleware, sessionReq);
    const blocked = await runMw(middleware, sessionReq);
    assert.equal(blocked.res.statusCode, 429);
    const ipOnly = await runMw(middleware, makeReq({ ip: "10.0.0.4" }));
    assert.equal(ipOnly.nextCalled, true);
  });

  it("can purge expired counters", async () => {
    await purgeExpiredRateLimitCounters();
  });
});
