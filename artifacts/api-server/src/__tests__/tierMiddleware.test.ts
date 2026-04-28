/**
 * Integration tests for tierMiddleware.
 *
 * Talks to the real dev database. Each test creates its own user (and optionally
 * a session) tagged with the prefix "ttm-" and cleans them up in afterEach.
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import {
  requireLegendary,
  injectMembershipTier,
} from "../middlewares/tierMiddleware.js";
import { deriveUserRole } from "../lib/userRole.js";
import { createSession, SESSION_COOKIE, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "ttm-";

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

interface MakeReqOpts {
  authenticated: boolean;
  userId?: string;
  bearer?: string;
  cookieSid?: string;
  // The new architecture moves the DB lookup into authMiddleware, so callers
  // of these middlewares always see a fully-populated `req.user`. These mocks
  // simulate that by constructing the same shape authMiddleware would have
  // produced for the test scenario.
  membershipTier?: "unregistered" | "registered" | "legendary";
  isRealAdmin?: boolean;
  isAdmin?: boolean;
}

function makeReq(opts: MakeReqOpts): Request & {
  membershipTier?: string;
  userRole?: string;
} {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  let user: Record<string, unknown> | undefined;
  if (opts.userId) {
    const tier = opts.membershipTier ?? "unregistered";
    const isAdmin = opts.isAdmin ?? false;
    user = {
      id: opts.userId,
      membershipTier: tier,
      isAdmin,
      isRealAdmin: opts.isRealAdmin ?? isAdmin,
      userRole: deriveUserRole(tier, isAdmin),
    };
  }
  const req = {
    headers,
    cookies: opts.cookieSid ? { [SESSION_COOKIE]: opts.cookieSid } : {},
    user,
    isAuthenticated() {
      return opts.authenticated;
    },
  } as unknown as Request & { membershipTier?: string; userRole?: string };
  return req;
}

function makeNext(): { calls: number; fn: NextFunction } {
  const state = { calls: 0 };
  const fn: NextFunction = () => {
    state.calls += 1;
  };
  return {
    get calls() { return state.calls; },
    fn,
  };
}

async function createTestUser(opts: {
  tier?: "unregistered" | "registered" | "legendary";
  isAdmin?: boolean;
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.tier ?? "registered",
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

async function createSessionWithAdminFlag(userId: string, isAdmin: boolean): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin,
  };
  return createSession(sessionData, userId);
}

async function cleanupTestUsers() {
  // USER_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("requireLegendary", () => {
  before(async () => { await cleanupTestUsers(); });
  after(async () => { await cleanupTestUsers(); });

  it("returns 401 when the request is not authenticated", async () => {
    const req = makeReq({ authenticated: false });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
    assert.equal(next.calls, 0);
  });

  it("returns 403 legendary_required when the user is registered (not legendary, not admin)", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const sid = await createSessionWithAdminFlag(userId, false);
    const req = makeReq({
      authenticated: true,
      userId,
      bearer: sid,
      membershipTier: "registered",
      isRealAdmin: false,
    });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: "legendary_required",
      message: "This feature requires a Legendary membership.",
    });
    assert.equal(next.calls, 0);
  });

  it("calls next when the user is on the legendary tier", async () => {
    const userId = await createTestUser({ tier: "legendary" });
    const sid = await createSessionWithAdminFlag(userId, false);
    const req = makeReq({
      authenticated: true,
      userId,
      bearer: sid,
      membershipTier: "legendary",
      isRealAdmin: false,
    });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 200);
    assert.equal(next.calls, 1);
  });

  it("calls next when req.user.isRealAdmin is true, even on a non-legendary tier", async () => {
    const userId = await createTestUser({ tier: "registered", isAdmin: true });
    const sid = await createSessionWithAdminFlag(userId, true);
    const req = makeReq({
      authenticated: true,
      userId,
      bearer: sid,
      membershipTier: "registered",
      isAdmin: true,
      isRealAdmin: true,
    });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 200);
    assert.equal(next.calls, 1);
  });

  it("treats a registered user with no admin flags as non-admin → 403 regardless of session", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const req = makeReq({
      authenticated: true,
      userId,
      membershipTier: "registered",
      isRealAdmin: false,
    });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 403);
    assert.equal(next.calls, 0);
  });

  it("returns 403 legendary_required when the user accessor throws (try/catch fallback)", async () => {
    const req = makeReq({
      authenticated: true,
      userId: `${USER_PREFIX}does-not-exist-${randomUUID()}`,
    });
    Object.defineProperty(req, "user", {
      get() {
        throw new Error("simulated user accessor failure");
      },
    });
    const res = makeRes();
    const next = makeNext();
    await requireLegendary(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "legendary_required" });
    assert.equal(next.calls, 0);
  });
});

describe("injectMembershipTier", () => {
  before(async () => { await cleanupTestUsers(); });
  after(async () => { await cleanupTestUsers(); });

  it("does nothing for unauthenticated requests and calls next", async () => {
    const req = makeReq({ authenticated: false });
    const res = makeRes();
    const next = makeNext();
    await injectMembershipTier(req, res as unknown as Response, next.fn);
    assert.equal(req.membershipTier, undefined);
    assert.equal(req.userRole, undefined);
    assert.equal(next.calls, 1);
  });

  it("sets membershipTier and userRole when the user is on the legendary tier", async () => {
    const userId = await createTestUser({ tier: "legendary" });
    const sid = await createSessionWithAdminFlag(userId, false);
    const req = makeReq({
      authenticated: true,
      userId,
      bearer: sid,
      membershipTier: "legendary",
      isRealAdmin: false,
    });
    const res = makeRes();
    const next = makeNext();
    await injectMembershipTier(req, res as unknown as Response, next.fn);
    assert.equal(req.membershipTier, "legendary");
    assert.equal(req.userRole, "legendary");
    assert.equal(next.calls, 1);
  });

  it("sets userRole='admin' when req.user.isAdmin is true", async () => {
    const userId = await createTestUser({ tier: "registered", isAdmin: true });
    const sid = await createSessionWithAdminFlag(userId, true);
    const req = makeReq({
      authenticated: true,
      userId,
      bearer: sid,
      membershipTier: "registered",
      isAdmin: true,
      isRealAdmin: true,
    });
    const res = makeRes();
    const next = makeNext();
    await injectMembershipTier(req, res as unknown as Response, next.fn);
    assert.equal(req.membershipTier, "registered");
    assert.equal(req.userRole, "admin");
    assert.equal(next.calls, 1);
  });

  it("sets userRole='registered' when authenticated with no admin flags", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const req = makeReq({
      authenticated: true,
      userId,
      membershipTier: "registered",
      isRealAdmin: false,
    });
    const res = makeRes();
    const next = makeNext();
    await injectMembershipTier(req, res as unknown as Response, next.fn);
    assert.equal(req.membershipTier, "registered");
    assert.equal(req.userRole, "registered");
    assert.equal(next.calls, 1);
  });

  it("falls back to unregistered/unregistered when an exception is thrown internally", async () => {
    const req = makeReq({
      authenticated: true,
      userId: `${USER_PREFIX}does-not-exist-${randomUUID()}`,
    });
    Object.defineProperty(req, "user", {
      get() {
        throw new Error("simulated user accessor failure");
      },
    });
    const res = makeRes();
    const next = makeNext();
    await injectMembershipTier(req, res as unknown as Response, next.fn);
    assert.equal(req.membershipTier, "unregistered");
    assert.equal(req.userRole, "unregistered");
    assert.equal(next.calls, 1);
  });
});
