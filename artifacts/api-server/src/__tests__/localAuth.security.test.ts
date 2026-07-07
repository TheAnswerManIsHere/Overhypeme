/**
 * Security regression tests for the local-auth surface.
 *
 * PRIMARY PURPOSE (C1 — critical): prove that the "dev admin login" endpoint
 * cannot mint or upgrade a session to the bootstrap admin account for an
 * ordinary (unauthenticated, cross-origin) caller.
 *
 * These assertions describe the SECURE target state:
 *   - By default (no ENABLE_DEV_ADMIN_LOGIN flag) the route is inert in every
 *     environment: GET/POST return 404-like, set no `sid` cookie, and never
 *     emit the `localStorage["auth_token"]` bootstrap script.
 *
 * Before the PR-1 fix this file is RED — the endpoint returns 200 with an
 * admin session + Set-Cookie, which is exactly the vulnerability. The red
 * output is the "before" proof. After PR-1 it must be GREEN.
 *
 * NOTE: buildTestApp mounts the router behind a stub auth middleware and does
 * NOT reproduce app.ts's CORS/CSRF/origin-exemption. The handler itself is the
 * core exploit (it grants admin with no credential), so proving the handler is
 * inert is sufficient here; the app-level CORS/origin-exemption removal is
 * asserted separately once the route is gated.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import type { Express } from "express";
import request from "supertest";

import { db, usersTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import { BOOTSTRAP_ADMIN_EMAIL } from "../lib/auth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

// Track whether this test created the bootstrap admin row so we only delete a
// row we own (a real seeded bootstrap admin, if present, must survive).
let createdBootstrapAdmin = false;
let app: Express;

before(async () => {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, BOOTSTRAP_ADMIN_EMAIL))
    .limit(1);

  if (!existing) {
    await db.insert(usersTable).values({
      id: `tsec-bootstrap-admin`,
      email: BOOTSTRAP_ADMIN_EMAIL,
      isActive: true,
      isAdmin: true,
      membershipTier: "legendary",
    });
    createdBootstrapAdmin = true;
  }

  // Unauthenticated caller — the attacker's position.
  app = buildTestApp({ kind: "unauthenticated" }, localAuthRouter);
});

after(async () => {
  if (createdBootstrapAdmin) {
    await db.delete(usersTable).where(eq(usersTable.id, `tsec-bootstrap-admin`));
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, `tsec-bootstrap-admin`));
  }
});

describe("C1: dev-admin-login must be inert by default", () => {
  it("POST /auth/dev-admin-login does not grant an admin session", async () => {
    const res = await request(app).post("/api/auth/dev-admin-login").send({});

    assert.equal(
      res.status,
      404,
      `dev-admin-login must be disabled by default, got ${res.status} (body: ${JSON.stringify(res.body)})`,
    );
    // Must not have handed back the bootstrap admin identity.
    assert.notEqual(res.body?.email, BOOTSTRAP_ADMIN_EMAIL);
    // Must not have set a session cookie.
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    assert.equal(
      setCookie.some((c) => c.startsWith("sid=")),
      false,
      "must not set a sid session cookie",
    );
  });

  it("GET /auth/dev-admin-login does not emit a localStorage auth_token bootstrap", async () => {
    const res = await request(app).get("/api/auth/dev-admin-login");

    assert.equal(
      res.status,
      404,
      `dev-admin-login (GET) must be disabled by default, got ${res.status}`,
    );
    assert.doesNotMatch(
      res.text ?? "",
      /auth_token/,
      "must not emit the localStorage bootstrap script",
    );
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    assert.equal(
      setCookie.some((c) => c.startsWith("sid=")),
      false,
      "must not set a sid session cookie",
    );
  });
});
