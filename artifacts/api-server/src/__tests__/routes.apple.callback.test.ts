/**
 * End-to-end integration test for the Apple OAuth callback route:
 *   POST /api/callback/apple
 *
 * Design goals
 * ────────────
 * 1. The success-path tests must exercise the real `generateAppleClientSecret`
 *    / `createPrivateKey` path so that a regression there surfaces here.
 *    We achieve this by stubbing only the OIDC discovery HTTP call via
 *    `_setClientDiscoveryForTest` (exported from lib/auth.ts) while letting
 *    `getAppleConfig()` — and therefore `generateAppleClientSecret()` — run
 *    for real with a synthetic EC key-pair loaded into env vars.
 *
 * 2. The token-exchange step (`oidc.authorizationCodeGrant`) is always mocked
 *    via `_setAuthCodeGrantForTest` (routes/auth.ts) so no real Apple token
 *    endpoint is required.
 *
 * 3. Everything else — pending-state lookup, upsertUser, session creation,
 *    cookie writing — runs against the real test database.
 *
 * Prefix convention: "tapplecb-" (uses `-` not `_` so LIKE wildcards in
 * cleanup cannot accidentally match rows owned by sibling test files). See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";

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
  _resetAppleConfigCacheForTest,
} from "../lib/auth.js";

import type {
  TokenEndpointResponse,
  TokenEndpointResponseHelpers,
  Configuration,
} from "openid-client";

const USER_PREFIX = "tapplecb-";

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
  // Sessions are deleted via ON DELETE CASCADE when the user row is removed.
  // Users created by the Apple callback get an auto-generated UUID for their
  // id but the email always starts with USER_PREFIX, so filter by email.
  await db.delete(usersTable).where(like(usersTable.email, `${USER_PREFIX}%`));
}

/** Generate a fresh EC P-256 key pair and load it into Apple env vars.
 *  Returns a restore function that resets the env vars to their prior values. */
function applyFakeAppleEnv(): () => void {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const prev = {
    APPLE_KEY_ID:     process.env.APPLE_KEY_ID,
    APPLE_TEAM_ID:    process.env.APPLE_TEAM_ID,
    APPLE_CLIENT_ID:  process.env.APPLE_CLIENT_ID,
    APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY,
  };
  process.env.APPLE_KEY_ID     = "TEST_KID";
  process.env.APPLE_TEAM_ID    = "TEST_TEAM";
  process.env.APPLE_CLIENT_ID  = "com.test.app";
  process.env.APPLE_PRIVATE_KEY = kp.privateKey
    .export({ type: "pkcs8", format: "pem" }) as string;
  return () => { Object.assign(process.env, prev); };
}

function makeFakeTokens(email: string): TokenEndpointResponse & TokenEndpointResponseHelpers {
  return {
    access_token: "fake-access-token",
    token_type:   "bearer",
    claims() {
      return {
        sub:  `apple|${randomUUID()}`,
        email,
        aud:  "com.test.app",
        iss:  "https://appleid.apple.com",
        iat:  Math.floor(Date.now() / 1000),
        exp:  Math.floor(Date.now() / 1000) + 3600,
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
  _resetAppleConfigCacheForTest();
});

afterEach(() => {
  _resetAuthCodeGrantForTest();
  _resetClientDiscoveryForTest();
  _resetAppleConfigCacheForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/callback/apple", () => {
  it("redirects without a 500 when code and state are missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/api/callback/apple").send({});
    assert.notEqual(res.status, 500, `Expected no 500, got ${res.status}`);
    assert.equal(res.status, 302);
    assert.match(res.headers["location"] ?? "", /login\/apple/);
  });

  it("redirects without a 500 when state is unknown (expired/never stored)", async () => {
    // Neither getAppleConfig nor authorizationCodeGrant is reached: the route
    // returns early after consumePendingState returns null.
    _setAuthCodeGrantForTest(
      async () => makeFakeTokens(`${USER_PREFIX}${randomUUID()}@test.local`),
    );

    const app = makeApp();
    const res = await request(app)
      .post("/api/callback/apple")
      .send({ code: "fake-code", state: "unknown-state-that-was-never-stored" });

    assert.notEqual(res.status, 500, `Expected no 500, got ${res.status}`);
    assert.equal(res.status, 302);
    assert.match(res.headers["location"] ?? "", /login\/apple/);
  });

  it("completes sign-in: real generateAppleClientSecret runs, no 500, session cookie set", async () => {
    // Use a real EC key pair so generateAppleClientSecret() exercises
    // createPrivateKey() for real.  Only the OIDC discovery HTTP call and
    // the Apple token exchange are mocked.
    const restoreEnv = applyFakeAppleEnv();
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
        .post("/api/callback/apple")
        .send({ code: "fake-apple-code", state });

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
    const restoreEnv = applyFakeAppleEnv();
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
        .post("/api/callback/apple")
        .send({ code: "fake-apple-code-2", state });

      const users = await db
        .select()
        .from(usersTable)
        .where(like(usersTable.email, `${USER_PREFIX}%`));

      assert.ok(users.length > 0, "A user row should have been created");

      const createdUser = users.find((u) => u.email === testEmail);
      assert.ok(createdUser, `User with email ${testEmail} should exist`);
      assert.equal(createdUser.oauthProvider, "apple");

      // Sessions are keyed by a random hex sid — query by userId instead.
      const sessions = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.userId, createdUser.id));

      assert.ok(sessions.length > 0, "A session row should have been created");
    } finally {
      restoreEnv();
    }
  });

  it("renders popup HTML without a 500 when isPopup is true", async () => {
    const restoreEnv = applyFakeAppleEnv();
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
        .post("/api/callback/apple")
        .send({ code: "fake-apple-code-popup", state });

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
