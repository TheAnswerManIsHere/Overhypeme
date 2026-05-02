/**
 * Parameterised 401 / 403 coverage for every admin-gated route in
 * routes/admin.ts.
 *
 * This file closes the auth-coverage gap left by routes.admin.test.ts (which
 * only exercises a representative sample of admin routes) by driving 401/403
 * assertions across every requireAdmin / requireAdminOrApiKey route.
 *
 * Drift protection: the final describe block introspects adminRouter.stack
 * and asserts ADMIN_AUTH_ROUTES is in lockstep with the actual router. Any
 * new admin route added to admin.ts without an entry here fails CI loudly.
 *
 * Pattern: uses the shared `buildTestApp` helper — the chosen house style for
 * new admin tests. routes.admin.test.ts retains the alternative
 * authMiddleware-+-real-session pattern for the value it adds in exercising
 * the session / cookie code path end-to-end.
 *
 * Out of scope: 200 / happy-path coverage and admin routes that live in
 * other route files (e.g. /admin/reviews/* in routes/reviews.ts).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "tadminauth-";

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RouteEntry {
  readonly method: Method;
  readonly path: string;
}

const ADMIN_AUTH_ROUTES: readonly RouteEntry[] = [
  { method: "get",    path: "/admin/stats" },
  { method: "get",    path: "/admin/resource-governance" },
  { method: "get",    path: "/admin/users" },
  { method: "patch",  path: "/admin/users/:id" },
  { method: "get",    path: "/admin/administrators" },
  { method: "delete", path: "/admin/users/:id" },
  { method: "get",    path: "/admin/users/:id/membership" },
  { method: "get",    path: "/admin/refunds-disputes" },
  { method: "post",   path: "/admin/users/:id/grant-lifetime" },
  { method: "post",   path: "/admin/users/:id/revoke-lifetime" },
  { method: "post",   path: "/admin/users" },
  { method: "get",    path: "/admin/facts" },
  { method: "delete", path: "/admin/facts/:id" },
  { method: "patch",  path: "/admin/facts/:id" },
  { method: "post",   path: "/admin/facts/:id/variants" },
  { method: "delete", path: "/admin/facts/variants/:variantId" },
  { method: "post",   path: "/admin/facts/import" },
  { method: "post",   path: "/admin/facts/import-csv" },
  { method: "get",    path: "/admin/comments/pending" },
  { method: "get",    path: "/admin/comments/pending/count" },
  { method: "get",    path: "/admin/comments/flagged" },
  { method: "post",   path: "/admin/comments/:id/approve" },
  { method: "post",   path: "/admin/comments/:id/reject" },
  { method: "delete", path: "/admin/comments/:id" },
  { method: "post",   path: "/admin/users/:id/verify-email" },
  { method: "get",    path: "/admin/users/:id/spend" },
  { method: "post",   path: "/admin/users/set-password" },
  { method: "post",   path: "/admin/users/enable-notifications" },
  { method: "post",   path: "/admin/facts/:id/refresh-images" },
  { method: "post",   path: "/admin/facts/backfill-images" },
  { method: "post",   path: "/admin/backfill-pexels" },
  { method: "post",   path: "/admin/facts/backfill-ai-memes" },
  { method: "post",   path: "/admin/facts/backfill-embeddings" },
  { method: "get",    path: "/admin/facts/:id/ai-meme" },
  { method: "put",    path: "/admin/facts/:id/ai-meme/generate" },
  { method: "put",    path: "/admin/facts/:id/ai-meme/regenerate-image" },
  { method: "put",    path: "/admin/facts/:id/ai-scene-prompts" },
  { method: "get",    path: "/admin/config" },
  { method: "patch",  path: "/admin/config/:key" },
  { method: "get",    path: "/admin/video-styles" },
  { method: "post",   path: "/admin/video-styles" },
  { method: "patch",  path: "/admin/video-styles/:id" },
  { method: "post",   path: "/admin/video-styles/:id/preview-gif" },
  { method: "delete", path: "/admin/video-styles/:id/preview-gif" },
  { method: "get",    path: "/admin/stripe/summary" },
  { method: "post",   path: "/admin/stripe/sync" },
  { method: "post",   path: "/admin/stripe/sync/_test/simulate" },
  { method: "get",    path: "/admin/stripe/sync/status" },
  { method: "post",   path: "/admin/stripe/test-event" },
  { method: "get",    path: "/admin/feature-flags" },
  { method: "patch",  path: "/admin/feature-flags" },
  { method: "post",   path: "/admin/_debug/sentry" },
  { method: "get",    path: "/admin/sentry-status" },
  { method: "get",    path: "/admin/route-stats" },
  { method: "get",    path: "/admin/email-queue" },
  { method: "delete", path: "/admin/email-queue" },
  { method: "post",   path: "/admin/email-queue/:id/retry" },
  { method: "get",    path: "/admin/users/:id/data-export" },
  { method: "post",   path: "/admin/users/:id/data-delete" },
  { method: "post",   path: "/admin/retention/run" },
];

// Routes in admin.ts that are intentionally unauthenticated and therefore
// excluded from the introspection equality check below.
const UNAUTHENTICATED_ADMIN_FILE_PATHS: ReadonlySet<string> = new Set([
  "/config/public",
  "/route-stats",
]);

function concretize(path: string): string {
  return path
    .replace(/:variantId\b/g, "test-variant-id")
    .replace(/:key\b/g, "test-key")
    .replace(/:id\b/g, "test-id");
}

async function createNonAdmin(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "registered",
    isAdmin: false,
  });
  return id;
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

let nonAdminId: string;
let unauthApp: Express;
let nonAdminApp: Express;

before(async () => {
  await cleanup();
  nonAdminId = await createNonAdmin();
  unauthApp = buildTestApp({ kind: "unauthenticated" }, adminRouter);
  nonAdminApp = buildTestApp({ kind: "authenticated", userId: nonAdminId }, adminRouter);
});

after(cleanup);

for (const route of ADMIN_AUTH_ROUTES) {
  const url = `/api${concretize(route.path)}`;
  describe(`${route.method.toUpperCase()} ${route.path}`, () => {
    it("returns 401 with no credentials", async () => {
      const res = await request(unauthApp)[route.method](url);
      assert.equal(
        res.status,
        401,
        `expected 401, got ${res.status} (body: ${JSON.stringify(res.body)})`,
      );
      assert.equal(res.body.error, "Unauthorized");
    });

    it("returns 403 admin_required for an authenticated non-admin", async () => {
      const res = await request(nonAdminApp)[route.method](url);
      assert.equal(
        res.status,
        403,
        `expected 403, got ${res.status} (body: ${JSON.stringify(res.body)})`,
      );
      assert.equal(res.body.error, "admin_required");
    });
  });
}

describe("requireAdminOrApiKey via x-api-key header", () => {
  // IMPORTANT: capture the previous value inside `before`, NOT at module-load
  // time. Under `--test-isolation=none` all test files share a process and
  // top-level `before` hooks from every file run before any tests, in an
  // order that is independent of the order in which files' tests execute.
  // That means another file's top-level `before` (e.g. routes.import.test.ts
  // setting ADMIN_API_KEY to its own test key) may have already mutated the
  // env var by the time this nested suite runs — capturing at module load
  // would snapshot a stale value, and the `after` below would then clobber
  // the sibling file's setup, breaking its tests with 401s.
  let previousKey: string | undefined;
  const TEST_KEY = "test-admin-key-do-not-use-anywhere-else";

  before(() => {
    previousKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = TEST_KEY;
  });

  after(() => {
    if (previousKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousKey;
  });

  it("admits an unauthenticated request bearing a valid api key", async () => {
    // POST /admin/users/set-password validates body next and returns 400
    // for missing email — that 400 (not 401/403) confirms the api-key
    // branch passed the auth gate.
    const app = buildTestApp({ kind: "unauthenticated" }, adminRouter);
    const res = await request(app)
      .post("/api/admin/users/set-password")
      .set("x-api-key", TEST_KEY)
      .send({});
    assert.notEqual(res.status, 401, "valid api key should not return 401");
    assert.notEqual(res.status, 403, "valid api key should not return 403");
    assert.equal(res.status, 400);
    assert.match(String(res.body.error ?? ""), /email/i);
  });

  it("rejects an unauthenticated request bearing a wrong api key with 401", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminRouter);
    const res = await request(app)
      .post("/api/admin/users/set-password")
      .set("x-api-key", "wrong-key")
      .send({});
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    assert.equal(res.body.error, "Unauthorized");
  });
});

describe("admin router auth coverage completeness", () => {
  it("ADMIN_AUTH_ROUTES matches every /admin/* route registered on adminRouter", () => {
    type StackLayer = {
      route?: {
        path: string;
        methods?: Record<string, boolean>;
        stack?: Array<{ method?: string }>;
      };
    };
    const layers = (adminRouter as unknown as { stack: StackLayer[] }).stack;

    const registered = new Set<string>();
    for (const layer of layers) {
      const r = layer.route;
      if (!r) continue;
      if (UNAUTHENTICATED_ADMIN_FILE_PATHS.has(r.path)) continue;
      // Express 4 exposes `route.methods`; Express 5 also populates it,
      // but fall back to scanning `route.stack[].method` if it is absent.
      const methods = r.methods
        ? Object.keys(r.methods)
        : (r.stack ?? [])
            .map((s) => s.method)
            .filter((m): m is string => typeof m === "string");
      for (const m of methods) {
        registered.add(`${m.toLowerCase()} ${r.path}`);
      }
    }

    const tested = new Set<string>(
      ADMIN_AUTH_ROUTES.map((e) => `${e.method} ${e.path}`),
    );

    const missing = [...registered].filter((k) => !tested.has(k)).sort();
    const extra   = [...tested].filter((k) => !registered.has(k)).sort();

    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      "ADMIN_AUTH_ROUTES drifted from adminRouter.stack — update both lists in lockstep",
    );
  });
});
