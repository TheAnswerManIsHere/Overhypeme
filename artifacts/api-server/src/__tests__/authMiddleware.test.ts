/**
 * Integration tests for authMiddleware.
 *
 * Talks to the real dev database. Each test creates its own user + session
 * tagged with the prefix "tam-" and cleans them up in afterEach.
 *
 * NOTE on the prefix: SQL LIKE treats `_` as a single-character wildcard, so
 * a cleanup like `like(id, 't_am_%')` would also match other test files'
 * rows during parallel runs (e.g. clobbering `t_amf_*`). To stay safe, every
 * test prefix in this directory uses `-` as its separator (not `_` or `%`)
 * and is chosen so no prefix is a literal initial substring of another.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable, sessionsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, SESSION_COOKIE, type SessionData } from "../lib/auth.js";


const USER_PREFIX = "tam-";

interface MockRes {
  clearCookieCalls: Array<{ name: string; opts?: unknown }>;
  clearCookie(name: string, opts?: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    clearCookieCalls: [],
    clearCookie(name, opts) {
      this.clearCookieCalls.push({ name, opts });
      return this;
    },
  };
  return res;
}

function makeReq(opts: { bearer?: string; cookieSid?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  return {
    headers,
    cookies: opts.cookieSid ? { [SESSION_COOKIE]: opts.cookieSid } : {},
  } as unknown as Request;
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

async function createTestUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

async function cleanupTestUsers() {
  // USER_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("authMiddleware", () => {
  before(async () => {
    await cleanupTestUsers();
  });
  after(async () => {
    await cleanupTestUsers();
  });

  it("attaches isAuthenticated() to the request even when no session id is present", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);
    assert.equal(typeof req.isAuthenticated, "function");
    assert.equal(req.isAuthenticated(), false);
    assert.equal(req.user, undefined);
    assert.equal(next.calls, 1);
  });

  it("calls next without attaching a user when no session id is present", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);
    assert.equal(req.user, undefined);
    assert.equal(next.calls, 1);
    assert.equal(res.clearCookieCalls.length, 0);
  });

  it("attaches no user and does NOT clear cookie when Bearer session id is unknown", async () => {
    // Bearer tokens live in localStorage — clearing the cookie for a stale
    // Bearer token would evict any valid concurrent cookie session.
    const bogusSid = randomUUID();
    const req = makeReq({ bearer: bogusSid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);
    assert.equal(req.user, undefined);
    assert.equal(req.isAuthenticated(), false);
    assert.equal(next.calls, 1);
    assert.equal(res.clearCookieCalls.length, 0);
  });

  it("deletes the DB row but does NOT clear cookie when Bearer sess payload has no user id", async () => {
    const userId = await createTestUser();
    const sid = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(sessionsTable).values({
      sid,
      sess: { } as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + 60_000),
      userId,
    });
    const req = makeReq({ bearer: sid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);
    assert.equal(req.user, undefined);
    assert.equal(next.calls, 1);
    assert.equal(res.clearCookieCalls.length, 0);

    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.equal(row, undefined, "session row should have been deleted from DB");
  });

  it("attaches the user to the request when the bearer token resolves to a valid session", async () => {
    const userId = await createTestUser();
    const sessionData: SessionData = {
      user: {
        id: userId,
        email: `${userId}@test.local`,
        displayName: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
        membershipTier: "registered",
        avatarStyle: "bottts",
        avatarSource: "avatar",
        pronouns: "he/him",
      } as unknown as SessionData["user"],
      access_token: "test-token",
    };
    const sid = await createSession(sessionData, userId);

    const req = makeReq({ bearer: sid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);

    assert.equal(req.user?.id, userId);
    assert.equal(req.isAuthenticated(), true);
    assert.equal(next.calls, 1);
    assert.equal(res.clearCookieCalls.length, 0);
  });

  it("reads the session id from the sid cookie when no Authorization header is present", async () => {
    const userId = await createTestUser();
    const sessionData: SessionData = {
      user: { id: userId, email: `${userId}@test.local` } as unknown as SessionData["user"],
      access_token: "test-token",
    };
    const sid = await createSession(sessionData, userId);

    const req = makeReq({ cookieSid: sid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);

    assert.equal(req.user?.id, userId);
    assert.equal(req.isAuthenticated(), true);
    assert.equal(next.calls, 1);
  });

  it("treats expired Bearer sessions as invalid (deletes DB row, does NOT clear cookie)", async () => {
    const userId = await createTestUser();
    const sid = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(sessionsTable).values({
      sid,
      sess: {
        user: { id: userId },
        access_token: "test-token",
      } as unknown as Record<string, unknown>,
      expire: new Date(Date.now() - 60_000),
      userId,
    });

    const req = makeReq({ bearer: sid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);

    assert.equal(req.user, undefined);
    assert.equal(next.calls, 1);
    // A stale Bearer token must NOT clear the cookie — the browser may have a
    // valid cookie session that would be wrongly evicted otherwise.
    assert.equal(res.clearCookieCalls.length, 0);

    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.equal(row, undefined, "expired session row should have been deleted from DB");
  });

  it("falls back to cookie session when Bearer token is stale (sign-in regression guard)", async () => {
    const userId = await createTestUser();
    const cookieSessionData: SessionData = {
      user: { id: userId, email: `${userId}@test.local` } as unknown as SessionData["user"],
      access_token: "",
    };
    const cookieSid = await createSession(cookieSessionData, userId);

    // Stale Bearer token (simulates an expired dev-admin-login stored in localStorage)
    const staleBearerSid = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(sessionsTable).values({
      sid: staleBearerSid,
      sess: { user: { id: userId }, access_token: "" } as unknown as Record<string, unknown>,
      expire: new Date(Date.now() - 60_000),
      userId,
    });

    const req = makeReq({ bearer: staleBearerSid, cookieSid });
    const res = makeRes();
    const next = makeNext();
    await authMiddleware(req, res as unknown as Response, next.fn);

    // Must authenticate via the valid cookie session despite the stale Bearer
    assert.equal(req.user?.id, userId);
    assert.equal(req.isAuthenticated(), true);
    assert.equal(next.calls, 1);
    // Stale Bearer DB row should be cleaned up
    const [staleRow] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, staleBearerSid));
    assert.equal(staleRow, undefined, "stale Bearer session row should be deleted");
    // Cookie must NOT be cleared
    assert.equal(res.clearCookieCalls.length, 0);
  });
});
