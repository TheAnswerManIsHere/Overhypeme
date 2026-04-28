/**
 * Integration tests proving authMiddleware always reads a fresh user row.
 *
 * Task #301 made `req.user` always-fresh by re-reading the user row on every
 * authenticated request (instead of trusting the snapshot embedded in the
 * session blob). These tests lock that behavior in: we authenticate once,
 * mutate the user row directly in the database (simulating a Stripe webhook
 * or admin grant), and then assert that the *next* request through
 * authMiddleware reflects the new row — without re-login.
 *
 * Talks to the real dev database. Each test creates its own user + session
 * tagged with the prefix "tauthfresh-" and cleans them up before/after.
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
import { usersTable, sessionsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, SESSION_COOKIE, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "tauthfresh-";

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

async function createTestUser(opts: {
  tier?: "unregistered" | "registered" | "legendary";
  isAdmin?: boolean;
  displayName?: string | null;
  pronouns?: string | null;
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.tier ?? "registered",
    isAdmin: opts.isAdmin ?? false,
    displayName: opts.displayName ?? null,
    pronouns: opts.pronouns ?? "he/him",
  });
  return id;
}

async function createSessionFor(userId: string): Promise<string> {
  // Note: we deliberately seed the session blob with STALE values for the
  // mutable fields. If authMiddleware were trusting the session snapshot
  // instead of re-reading the user row, these stale values would leak into
  // req.user and the assertions below would fail.
  const sessionData: SessionData = {
    user: {
      id: userId,
      email: `${userId}@test.local`,
      displayName: "stale-display-name",
      pronouns: "stale/pronouns",
      membershipTier: "registered",
      isAdmin: false,
    } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: false,
  };
  return createSession(sessionData, userId);
}

async function cleanupTestUsers() {
  // USER_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("authMiddleware (fresh user row on every request)", () => {
  before(async () => { await cleanupTestUsers(); });
  after(async () => { await cleanupTestUsers(); });

  it("membershipTier upgrade in the DB is reflected on the very next request without re-login", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const sid = await createSessionFor(userId);

    // First request: user is registered.
    {
      const req = makeReq({ bearer: sid });
      const res = makeRes();
      const next = makeNext();
      await authMiddleware(req, res as unknown as Response, next.fn);
      assert.equal(req.user?.membershipTier, "registered");
      assert.equal(req.user?.userRole, "registered");
      assert.equal(req.user?.realUserRole, "registered");
      assert.equal(next.calls, 1);
    }

    // Simulate a Stripe webhook upgrading the user to legendary.
    await db
      .update(usersTable)
      .set({ membershipTier: "legendary" })
      .where(eq(usersTable.id, userId));

    // Second request: same session, but req.user must reflect the new tier.
    {
      const req = makeReq({ bearer: sid });
      const res = makeRes();
      const next = makeNext();
      await authMiddleware(req, res as unknown as Response, next.fn);
      assert.equal(
        req.user?.membershipTier,
        "legendary",
        "next request should see the upgraded tier without re-login",
      );
      assert.equal(req.user?.userRole, "legendary");
      assert.equal(req.user?.realUserRole, "legendary");
      assert.equal(next.calls, 1);
      assert.equal(res.clearCookieCalls.length, 0);
    }
  });

  it("displayName change in the DB is reflected on the very next request", async () => {
    const userId = await createTestUser({ displayName: "Old Name" });
    const sid = await createSessionFor(userId);

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(req.user?.displayName, "Old Name");
    }

    await db
      .update(usersTable)
      .set({ displayName: "Brand New Name" })
      .where(eq(usersTable.id, userId));

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(
        req.user?.displayName,
        "Brand New Name",
        "displayName edits should be visible immediately on the next request",
      );
    }
  });

  it("pronouns change in the DB is reflected on the very next request", async () => {
    const userId = await createTestUser({ pronouns: "he/him" });
    const sid = await createSessionFor(userId);

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(req.user?.pronouns, "he/him");
    }

    await db
      .update(usersTable)
      .set({ pronouns: "they/them" })
      .where(eq(usersTable.id, userId));

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(
        req.user?.pronouns,
        "they/them",
        "pronouns edits should be visible immediately on the next request",
      );
    }
  });

  it("admin grant via the DB is reflected on the very next request (isAdmin + isRealAdmin)", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await createSessionFor(userId);

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(req.user?.isAdmin, false);
      assert.equal(req.user?.isRealAdmin, false);
      assert.equal(req.user?.userRole, "registered");
      assert.equal(req.user?.realUserRole, "registered");
    }

    // Simulate an admin granting this user the admin role in the DB.
    await db
      .update(usersTable)
      .set({ isAdmin: true })
      .where(eq(usersTable.id, userId));

    {
      const req = makeReq({ bearer: sid });
      const next = makeNext();
      await authMiddleware(req, makeRes() as unknown as Response, next.fn);
      assert.equal(
        req.user?.isAdmin,
        true,
        "admin grant should be visible immediately on the next request",
      );
      assert.equal(req.user?.isRealAdmin, true);
      assert.equal(req.user?.userRole, "admin");
      assert.equal(req.user?.realUserRole, "admin");
    }
  });

  it("realUserRole stays 'admin' even when adminModeDisabled toggle is set (userRole becomes 'registered')", async () => {
    const userId = await createTestUser({ isAdmin: true });
    // Create a session with adminModeDisabled: true (simulating the "view as user" toggle)
    const sessionData: SessionData = {
      user: {
        id: userId,
        email: `${userId}@test.local`,
        membershipTier: "registered",
        isAdmin: true,
      } as unknown as SessionData["user"],
      access_token: "test-token",
      isAdmin: false,
      adminModeDisabled: true,
    };
    const sid = await createSession(sessionData, userId);

    const req = makeReq({ bearer: sid });
    const next = makeNext();
    await authMiddleware(req, makeRes() as unknown as Response, next.fn);

    // The toggle suppresses isAdmin but isRealAdmin and realUserRole must stay true/admin
    assert.equal(req.user?.isAdmin, false, "toggle OFF: isAdmin should be false");
    assert.equal(req.user?.isRealAdmin, true, "isRealAdmin is always the DB truth");
    assert.equal(req.user?.userRole, "registered", "toggle OFF: userRole should reflect the toggled state");
    assert.equal(req.user?.realUserRole, "admin", "realUserRole must always be admin regardless of toggle");
  });

  it("soft-deleting the user (isActive=false) logs them out on the very next request", async () => {
    const userId = await createTestUser({ tier: "legendary" });
    const sid = await createSessionFor(userId);

    {
      const req = makeReq({ bearer: sid });
      const res = makeRes();
      const next = makeNext();
      await authMiddleware(req, res as unknown as Response, next.fn);
      assert.equal(req.user?.id, userId);
      assert.equal(req.isAuthenticated(), true);
      assert.equal(res.clearCookieCalls.length, 0);
    }

    // Simulate a soft-delete (account closure / ban).
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, userId));

    {
      const req = makeReq({ bearer: sid });
      const res = makeRes();
      const next = makeNext();
      await authMiddleware(req, res as unknown as Response, next.fn);
      assert.equal(
        req.user,
        undefined,
        "soft-deleted users should be treated as logged out on the next request",
      );
      assert.equal(req.isAuthenticated(), false);
      assert.equal(next.calls, 1);
      assert.equal(res.clearCookieCalls.length, 1);
      assert.equal(res.clearCookieCalls[0]?.name, SESSION_COOKIE);

      const [row] = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.sid, sid));
      assert.equal(
        row,
        undefined,
        "the orphaned session row should have been deleted",
      );
    }
  });
});
