/**
 * End-to-end integration test for the Google OAuth callback route:
 *   GET /api/callback/google
 *
 * Design goals
 * ────────────
 * 1. The token-exchange step (`oidc.authorizationCodeGrant`) is mocked via
 *    `_setAuthCodeGrantForTest` (routes/auth.ts) so no real Google token
 *    endpoint is required.
 *
 * 2. The OIDC discovery HTTP call is stubbed via `_setClientDiscoveryForTest`
 *    (lib/auth.ts) for tests that reach `getGoogleConfig()`.  Fake
 *    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars satisfy the call-site
 *    guard without real credentials.
 *
 * 3. Everything else — pending-state lookup, upsertUser, session creation,
 *    cookie writing — runs against the real test database.
 *
 * Prefix convention: "tgooglecb-" (uses `-` not `_` so LIKE wildcards in
 * cleanup cannot accidentally match rows owned by sibling test files). See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, sessionsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import authRouter, {
  _storePendingStateForTest,
  _setAuthCodeGrantForTest,
  _resetAuthCodeGrantForTest,
} from "../routes/auth.js";

import {
  _setClientDiscoveryForTest,
  _resetClientDiscoveryForTest,
  _resetGoogleConfigCacheForTest,
} from "../lib/auth.js";

import type {
  TokenEndpointResponse,
  TokenEndpointResponseHelpers,
  Configuration,
} from "openid-client";

const USER_PREFIX = "tgooglecb-";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.isAuthenticated = function (this: typeof req) {
      return this.user != null;
    } as typeof req.isAuthenticated;
    next();
  });
  app.use("/api", authRouter);
  return app;
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.email, `${USER_PREFIX}%`));
}

/** Set minimal Google env vars so `getGoogleConfig()` does not throw.
 *  Returns a restore function that resets them to their prior values. */
function applyFakeGoogleEnv(): () => void {
  const prev = {
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.GOOGLE_CLIENT_ID     = "fake-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "fake-google-client-secret";
  return () => { Object.assign(process.env, prev); };
}

function makeFakeTokens(email: string): TokenEndpointResponse & TokenEndpointResponseHelpers {
  return {
    access_token: "fake-access-token",
    token_type:   "bearer",
    claims() {
      return {
        sub:         `google|${randomUUID()}`,
        email,
        given_name:  "Test",
        family_name: "User",
        picture:     null,
        aud:         "fake-google-client-id",
        iss:         "https://accounts.google.com",
        iat:         Math.floor(Date.now() / 1000),
        exp:         Math.floor(Date.now() / 1000) + 3600,
      };
    },
  } as unknown as TokenEndpointResponse & TokenEndpointResponseHelpers;
}

function makeFakeDiscovery(): typeof import("openid-client").discovery {
  return async () => ({} as Configuration);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(cleanup);
after(async () => {
  await cleanup();
  _resetAuthCodeGrantForTest();
  _resetClientDiscoveryForTest();
  _resetGoogleConfigCacheForTest();
});

afterEach(() => {
  _resetAuthCodeGrantForTest();
  _resetClientDiscoveryForTest();
  _resetGoogleConfigCacheForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/callback/google", () => {
  it("redirects without a 500 when code and state are missing", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/callback/google");
    assert.notEqual(res.status, 500, `Expected no 500, got ${res.status}`);
    assert.equal(res.status, 302);
    assert.match(res.headers["location"] ?? "", /login\/google/);
  });

  it("redirects without a 500 when state is unknown (expired/never stored)", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    _setAuthCodeGrantForTest(
      async () => makeFakeTokens(`${USER_PREFIX}${randomUUID()}@test.local`),
    );

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-code", state: "unknown-state-that-was-never-stored" });

      assert.notEqual(res.status, 500, `Expected no 500, got ${res.status}`);
      assert.equal(res.status, 302);
      assert.match(res.headers["location"] ?? "", /login\/google/);
    } finally {
      restoreEnv();
    }
  });

  it("completes sign-in: no 500, session cookie set", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    _setAuthCodeGrantForTest(
      async () => makeFakeTokens(`${USER_PREFIX}${randomUUID()}@test.local`),
    );

    const state = randomUUID();
    _storePendingStateForTest(state, {
      codeVerifier: "test-verifier",
      nonce:        "test-nonce",
      returnTo:     "/",
      isPopup:      false,
    });

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-google-code", state });

      assert.notEqual(
        res.status, 500,
        `Expected no 500, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.equal(res.status, 302, `Expected 302 redirect, got ${res.status}`);

      const setCookie = res.headers["set-cookie"];
      assert.ok(
        Array.isArray(setCookie)
          ? setCookie.some((c: string) => c.startsWith("sid="))
          : typeof setCookie === "string" && setCookie.startsWith("sid="),
        "Response must set a 'sid' session cookie",
      );
    } finally {
      restoreEnv();
    }
  });

  it("creates a user row and a session row in the database", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());

    const testEmail = `${USER_PREFIX}${randomUUID()}@test.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(testEmail));

    const state = randomUUID();
    _storePendingStateForTest(state, {
      codeVerifier: "test-verifier-2",
      nonce:        "test-nonce-2",
      returnTo:     "/dashboard",
      isPopup:      false,
    });

    try {
      const app = makeApp();
      await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-google-code-2", state });

      const users = await db
        .select()
        .from(usersTable)
        .where(like(usersTable.email, `${USER_PREFIX}%`));

      assert.ok(users.length > 0, "A user row should have been created");

      const createdUser = users.find((u) => u.email === testEmail);
      assert.ok(createdUser, `User with email ${testEmail} should exist`);
      assert.equal(createdUser.oauthProvider, "google");

      const sessions = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.userId, createdUser.id));

      assert.ok(sessions.length > 0, "A session row should have been created");
    } finally {
      restoreEnv();
    }
  });

  it("returning user: second sign-in succeeds, no duplicate user, new session row", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());

    const testEmail = `${USER_PREFIX}${randomUUID()}@test.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(testEmail));

    try {
      // ── First sign-in (creates the user) ──
      const state1 = randomUUID();
      _storePendingStateForTest(state1, {
        codeVerifier: "test-verifier-returning-1",
        nonce:        "test-nonce-returning-1",
        returnTo:     "/",
        isPopup:      false,
      });

      const app = makeApp();
      const res1 = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-google-code-returning-1", state: state1 });

      assert.notEqual(res1.status, 500, `First sign-in: expected no 500, got ${res1.status}`);
      assert.equal(res1.status, 302);

      const usersAfterFirst = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, testEmail));
      assert.equal(usersAfterFirst.length, 1, "Exactly one user row after first sign-in");
      const userId = usersAfterFirst[0]!.id;

      const sessionsAfterFirst = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.userId, userId));
      assert.equal(sessionsAfterFirst.length, 1, "Exactly one session row after first sign-in");

      // ── Second sign-in with same email (hits ON CONFLICT DO UPDATE branch) ──
      const state2 = randomUUID();
      _storePendingStateForTest(state2, {
        codeVerifier: "test-verifier-returning-2",
        nonce:        "test-nonce-returning-2",
        returnTo:     "/",
        isPopup:      false,
      });

      const res2 = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-google-code-returning-2", state: state2 });

      assert.notEqual(
        res2.status, 500,
        `Second sign-in: expected no 500, got ${res2.status}: ${JSON.stringify(res2.body)}`,
      );
      assert.equal(res2.status, 302, `Second sign-in: expected 302, got ${res2.status}`);

      const setCookie = res2.headers["set-cookie"];
      assert.ok(
        Array.isArray(setCookie)
          ? setCookie.some((c: string) => c.startsWith("sid="))
          : typeof setCookie === "string" && setCookie.startsWith("sid="),
        "Second sign-in must still set a 'sid' session cookie",
      );

      // No duplicate user row
      const usersAfterSecond = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, testEmail));
      assert.equal(
        usersAfterSecond.length, 1,
        "Returning user should not create a duplicate user row",
      );
      assert.equal(usersAfterSecond[0]!.id, userId, "User id should be stable across sign-ins");

      // A second session row exists
      const sessionsAfterSecond = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.userId, userId));
      assert.equal(
        sessionsAfterSecond.length, 2,
        "Second sign-in should create an additional session row",
      );
    } finally {
      restoreEnv();
    }
  });

  it("renders popup HTML without a 500 when isPopup is true", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());

    const testEmail = `${USER_PREFIX}${randomUUID()}@test.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(testEmail));

    const state = randomUUID();
    _storePendingStateForTest(state, {
      codeVerifier: "test-verifier-popup",
      nonce:        "test-nonce-popup",
      returnTo:     "/",
      isPopup:      true,
    });

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-google-code-popup", state });

      assert.notEqual(res.status, 500, `Expected no 500, got ${res.status}`);
      assert.equal(res.status, 200, `Expected 200 HTML for popup flow, got ${res.status}`);
      assert.ok(
        res.text.includes("<script>"),
        "Popup response should contain an inline <script> to redirect the opener",
      );
    } finally {
      restoreEnv();
    }
  });
});
