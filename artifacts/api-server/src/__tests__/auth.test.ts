/**
 * Integration tests for src/lib/auth.ts session helpers.
 *
 * Talks to the real test DB. Each test creates its own user/session rows
 * tagged with the prefix "tau-" and cleans them up in afterEach.
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 *
 * The OIDC provider helpers (getGoogleConfig, getAppleConfig) are out of
 * scope — they require live network calls to OpenID discovery endpoints.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { usersTable, sessionsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import {
  SESSION_COOKIE,
  SESSION_TTL,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  clearSession,
  getSessionId,
  type SessionData,
} from "../lib/auth.js";

const USER_PREFIX = "tau-";

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

function makeReq(opts: { auth?: string; cookieSid?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers["authorization"] = opts.auth;
  return {
    headers,
    cookies: opts.cookieSid ? { [SESSION_COOKIE]: opts.cookieSid } : {},
  } as unknown as Request;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local` });
  return id;
}

function makeSessionData(userId: string): SessionData {
  return {
    user: {
      id: userId,
      email: `${userId}@test.local`,
    } as unknown as SessionData["user"],
    access_token: "test-token",
  };
}

async function cleanupTestUsers() {
  // USER_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db.delete(sessionsTable).where(like(sessionsTable.sid, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => { await cleanupTestUsers(); });
after(async () => { await cleanupTestUsers(); });

describe("constants", () => {
  it("SESSION_COOKIE is 'sid'", () => {
    assert.equal(SESSION_COOKIE, "sid");
  });

  it("SESSION_TTL is 7 days in milliseconds", () => {
    assert.equal(SESSION_TTL, 7 * 24 * 60 * 60 * 1000);
  });
});

describe("getSessionId", () => {
  it("returns undefined when neither header nor cookie is present", () => {
    assert.equal(getSessionId(makeReq()), undefined);
  });

  it("extracts the token from a Bearer Authorization header", () => {
    const req = makeReq({ auth: "Bearer abc123" });
    assert.equal(getSessionId(req), "abc123");
  });

  it("ignores non-Bearer Authorization headers and falls back to the cookie", () => {
    const req = makeReq({ auth: "Basic foo:bar", cookieSid: "cookie-sid" });
    assert.equal(getSessionId(req), "cookie-sid");
  });

  it("prefers the Authorization header over the cookie when both are present", () => {
    const req = makeReq({ auth: "Bearer header-sid", cookieSid: "cookie-sid" });
    assert.equal(getSessionId(req), "header-sid");
  });

  it("returns the cookie value when no Authorization header is supplied", () => {
    const req = makeReq({ cookieSid: "cookie-sid" });
    assert.equal(getSessionId(req), "cookie-sid");
  });

  it("returns undefined for an empty Bearer token", () => {
    const req = makeReq({ auth: "Bearer " });
    assert.equal(getSessionId(req), "");
  });
});

describe("createSession", () => {
  afterEach(async () => { await cleanupTestUsers(); });

  it("inserts a row with a random 64-char hex sid and links the user", async () => {
    const userId = await createTestUser();
    const sid = await createSession(makeSessionData(userId), userId);
    assert.match(sid, /^[0-9a-f]{64}$/);
    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.ok(row, "session row should exist");
    assert.equal(row.userId, userId);
    assert.ok(row.expire > new Date(), "expire should be in the future");
  });

  it("permits a userId-less (guest) session — userId column is nullable", async () => {
    const sid = await createSession({
      user: { id: "guest" } as unknown as SessionData["user"],
      access_token: "guest-token",
    });
    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.ok(row);
    assert.equal(row.userId, null);
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  });

  it("two consecutive calls produce different sids", async () => {
    const userId = await createTestUser();
    const a = await createSession(makeSessionData(userId), userId);
    const b = await createSession(makeSessionData(userId), userId);
    assert.notEqual(a, b);
  });
});

describe("getSession", () => {
  afterEach(async () => { await cleanupTestUsers(); });

  it("returns the stored sess data for a non-expired sid", async () => {
    const userId = await createTestUser();
    const data = makeSessionData(userId);
    const sid = await createSession(data, userId);
    const out = await getSession(sid);
    assert.ok(out);
    assert.equal(out!.user.id, userId);
    assert.equal(out!.access_token, "test-token");
  });

  it("returns null for an unknown sid", async () => {
    const out = await getSession(`${USER_PREFIX}does-not-exist`);
    assert.equal(out, null);
  });

  it("returns null for an expired sid AND deletes the row", async () => {
    const userId = await createTestUser();
    const sid = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(sessionsTable).values({
      sid,
      sess: makeSessionData(userId) as unknown as Record<string, unknown>,
      expire: new Date(Date.now() - 60_000),
      userId,
    });
    const out = await getSession(sid);
    assert.equal(out, null);
    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.equal(row, undefined, "expired row should have been removed");
  });
});

describe("updateSession", () => {
  afterEach(async () => { await cleanupTestUsers(); });

  it("rewrites the sess payload and pushes expire forward", async () => {
    const userId = await createTestUser();
    const sid = await createSession(makeSessionData(userId), userId);
    const [before] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));

    const updated: SessionData = {
      ...makeSessionData(userId),
      access_token: "rotated-token",
      isAdmin: true,
    };
    await new Promise((r) => setTimeout(r, 5));
    await updateSession(sid, updated);

    const [after] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    const sess = after.sess as unknown as SessionData;
    assert.equal(sess.access_token, "rotated-token");
    assert.equal(sess.isAdmin, true);
    assert.ok(after.expire >= before.expire, "expire should not move backward");
  });
});

describe("deleteSession", () => {
  afterEach(async () => { await cleanupTestUsers(); });

  it("removes the row for the given sid", async () => {
    const userId = await createTestUser();
    const sid = await createSession(makeSessionData(userId), userId);
    await deleteSession(sid);
    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.equal(row, undefined);
  });

  it("is a no-op for an unknown sid", async () => {
    await deleteSession(`${USER_PREFIX}never-existed`);
    // No throw = success.
  });
});

describe("clearSession", () => {
  afterEach(async () => { await cleanupTestUsers(); });

  it("clears the cookie and (when sid is given) deletes the matching row", async () => {
    const userId = await createTestUser();
    const sid = await createSession(makeSessionData(userId), userId);
    const res = makeRes();
    await clearSession(res as unknown as Response, sid);

    assert.equal(res.clearCookieCalls.length, 1);
    assert.equal(res.clearCookieCalls[0]?.name, SESSION_COOKIE);
    assert.deepEqual(res.clearCookieCalls[0]?.opts, {
      path: "/",
      sameSite: "none",
      secure: true,
    });

    const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
    assert.equal(row, undefined);
  });

  it("clears only the cookie when sid is omitted (no DB write)", async () => {
    const res = makeRes();
    await clearSession(res as unknown as Response);
    assert.equal(res.clearCookieCalls.length, 1);
    assert.equal(res.clearCookieCalls[0]?.name, SESSION_COOKIE);
  });
});
