/**
 * Integration tests for the OAuth link flow:
 *
 *   GET  /api/link/:provider          — initiate provider linking (auth-required)
 *   GET  /api/callback/google         — link-mode branch inside handleOAuthCallback
 *
 * Design goals
 * ────────────
 * 1. Network is never touched. `_setAuthCodeGrantForTest` stubs the OIDC token
 *    exchange; `_setClientDiscoveryForTest` stubs the discovery document fetch.
 *
 * 2. Fake GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are set per-test so
 *    `isProviderConfigured("google")` returns true without real credentials.
 *
 * 3. Everything else (DB inserts, pending-state storage, redirect assertions)
 *    runs against the real test database.
 *
 * Prefix convention: "tlink-" (uses "-" not "_" so LIKE wildcards in cleanup
 * cannot accidentally match rows owned by sibling test files).
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, oauthPendingStatesTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import authRouter, {
  _storePendingStateForTest,
  _setAuthCodeGrantForTest,
  _resetAuthCodeGrantForTest,
  _setBuildAuthorizationUrlForTest,
  _resetBuildAuthorizationUrlForTest,
} from "../routes/auth.js";

import {
  _setClientDiscoveryForTest,
  _resetClientDiscoveryForTest,
  _resetGoogleConfigCacheForTest,
  createSession,
  type SessionData,
} from "../lib/auth.js";

import type {
  TokenEndpointResponse,
  TokenEndpointResponseHelpers,
  Configuration,
} from "openid-client";

const USER_PREFIX = "tlink-";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that mounts authRouter at /api.
 * When `userId` is provided the middleware populates req.user so
 * req.isAuthenticated() returns true — mimicking a real logged-in session.
 */
function makeApp(userId?: string): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use((req: Request, _res, next) => {
    if (userId) {
      (req as Request & { user?: { id: string } }).user = { id: userId };
    }
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

/** Set minimal Google env vars so `isProviderConfigured` / `getGoogleConfig`
 *  do not throw. Returns a restore function. */
function applyFakeGoogleEnv(): () => void {
  const prev = {
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.GOOGLE_CLIENT_ID     = "fake-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "fake-google-client-secret";
  return () => { Object.assign(process.env, prev); };
}

function makeFakeDiscovery(): typeof import("openid-client").discovery {
  return async () => ({} as Configuration);
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

/** Insert a bare user row (no password, no provider) and return its id. */
async function insertUser(email: string, opts: { oauthProvider?: string } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email,
    oauthProvider: opts.oauthProvider ?? null,
    isActive: true,
  });
  return id;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(cleanup);
after(async () => {
  await cleanup();
  _resetAuthCodeGrantForTest();
  _resetBuildAuthorizationUrlForTest();
  _resetClientDiscoveryForTest();
  _resetGoogleConfigCacheForTest();
});

afterEach(() => {
  _resetAuthCodeGrantForTest();
  _resetBuildAuthorizationUrlForTest();
  _resetClientDiscoveryForTest();
  _resetGoogleConfigCacheForTest();
});

// ── GET /api/link/:provider ───────────────────────────────────────────────────

describe("GET /api/link/:provider", () => {
  it("returns 401 when not authenticated", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    try {
      const app = makeApp(); // no userId → unauthenticated
      const res = await request(app).get("/api/link/google");
      assert.equal(res.status, 401);
    } finally {
      restoreEnv();
    }
  });

  it("returns 404 for an unknown provider", async () => {
    const email = `${USER_PREFIX}${randomUUID()}@test.local`;
    const userId = await insertUser(email);
    const app = makeApp(userId);
    const res = await request(app).get("/api/link/twitter");
    assert.equal(res.status, 404);
  });

  it("redirects with link_error=already_linked when the user already has an OAuth provider", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    try {
      const email = `${USER_PREFIX}${randomUUID()}@test.local`;
      const userId = await insertUser(email, { oauthProvider: "google" });
      const app = makeApp(userId);
      const res = await request(app).get("/api/link/google");
      assert.equal(res.status, 302);
      assert.match(res.headers["location"] ?? "", /link_error=already_linked/);
    } finally {
      restoreEnv();
    }
  });

  it("redirects to the OAuth authorization URL when provider is not yet linked", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    _setBuildAuthorizationUrlForTest(
      (_config, _params) => new URL("https://accounts.google.com/o/oauth2/v2/auth?state=fake"),
    );
    try {
      const email = `${USER_PREFIX}${randomUUID()}@test.local`;
      const userId = await insertUser(email); // no oauthProvider
      const app = makeApp(userId);
      const res = await request(app).get("/api/link/google");
      assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
      assert.ok(
        !(res.headers["location"] ?? "").includes("link_error"),
        "Should not contain link_error in redirect URL",
      );
    } finally {
      restoreEnv();
    }
  });

  it("stores pending OAuth state with linkUserId set to the authenticated user", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());

    // Capture the state value the route passes to buildAuthorizationUrl so we
    // can look up the exact DB row and verify its linkUserId.
    let capturedState: string | undefined;
    _setBuildAuthorizationUrlForTest((_config, params) => {
      capturedState = params["state"] as string | undefined;
      return new URL(
        `https://accounts.google.com/o/oauth2/v2/auth?state=${capturedState ?? ""}`,
      );
    });

    try {
      const email = `${USER_PREFIX}${randomUUID()}@test.local`;
      const userId = await insertUser(email);
      const app = makeApp(userId);
      const res = await request(app)
        .get("/api/link/google")
        .query({ returnTo: "/settings" });

      assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
      assert.ok(capturedState, "buildAuthorizationUrl must have been called with a state param");

      const [row] = await db
        .select()
        .from(oauthPendingStatesTable)
        .where(eq(oauthPendingStatesTable.state, capturedState!));

      assert.ok(row, "A pending state row should exist in the DB after the link route is called");
      assert.equal(
        row.linkUserId,
        userId,
        "linkUserId in the pending state should equal the authenticated user's id",
      );
      assert.equal(row.returnTo, "/settings", "returnTo should be preserved from the query param");
    } finally {
      restoreEnv();
    }
  });
});

// ── Callback link-mode ────────────────────────────────────────────────────────

describe("GET /api/callback/google — link mode", () => {
  it("redirects with ?linked=1 when emails match and no provider is set yet", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    const email = `${USER_PREFIX}${randomUUID()}@test.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(email));

    const userId = await insertUser(email); // no oauthProvider
    const state = randomUUID();
    await _storePendingStateForTest(state, {
      codeVerifier: "test-verifier-link-ok",
      nonce:        "test-nonce-link-ok",
      returnTo:     "/settings",
      isPopup:      false,
      linkUserId:   userId,
    });

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-link-code", state });

      assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
      assert.match(res.headers["location"] ?? "", /linked=1/);

      // Confirm the DB row was actually updated
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      assert.equal(row?.oauthProvider, "google", "oauthProvider should be set after linking");
    } finally {
      restoreEnv();
    }
  });

  it("redirects with ?link_error=email_mismatch when OAuth email differs from account email", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    const accountEmail = `${USER_PREFIX}${randomUUID()}@test.local`;
    const oauthEmail   = `${USER_PREFIX}${randomUUID()}@other.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(oauthEmail)); // different email

    const userId = await insertUser(accountEmail);
    const state = randomUUID();
    await _storePendingStateForTest(state, {
      codeVerifier: "test-verifier-mismatch",
      nonce:        "test-nonce-mismatch",
      returnTo:     "/settings",
      isPopup:      false,
      linkUserId:   userId,
    });

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-mismatch-code", state });

      assert.equal(res.status, 302);
      assert.match(res.headers["location"] ?? "", /link_error=email_mismatch/);

      // Provider must NOT have been set
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      assert.equal(row?.oauthProvider, null, "oauthProvider should remain null after email mismatch");
    } finally {
      restoreEnv();
    }
  });

  it("redirects with ?link_error=already_linked when the target user already has a provider", async () => {
    const restoreEnv = applyFakeGoogleEnv();
    _setClientDiscoveryForTest(makeFakeDiscovery());
    const email = `${USER_PREFIX}${randomUUID()}@test.local`;
    _setAuthCodeGrantForTest(async () => makeFakeTokens(email));

    // User already has google linked
    const userId = await insertUser(email, { oauthProvider: "google" });
    const state = randomUUID();
    await _storePendingStateForTest(state, {
      codeVerifier: "test-verifier-already-linked",
      nonce:        "test-nonce-already-linked",
      returnTo:     "/settings",
      isPopup:      false,
      linkUserId:   userId,
    });

    try {
      const app = makeApp();
      const res = await request(app)
        .get("/api/callback/google")
        .query({ code: "fake-already-linked-code", state });

      assert.equal(res.status, 302);
      assert.match(res.headers["location"] ?? "", /link_error=already_linked/);
    } finally {
      restoreEnv();
    }
  });
});
