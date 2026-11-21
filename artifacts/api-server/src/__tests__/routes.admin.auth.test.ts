/**
 * Parameterised 401 / 403 coverage for every admin-gated route in
 * routes/admin.ts.
 *
 * This file closes the auth-coverage gap left by routes.admin.test.ts (which
 * only exercises a representative sample of admin routes) by driving 401/403
 * assertions across every requireAdmin route.
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
import { usersTable, factsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, count, eq, gte, like } from "drizzle-orm";
import {
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
} from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { FACT_AI_MEME_BACKFILL_QUEUE } from "../lib/aiMemeBackfillJobs.js";

const USER_PREFIX = "tadminauth-";
const FACT_TEXT_PREFIX = "tadminauth-fact ";
const FILE_START = new Date();

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RouteEntry {
  readonly method: Method;
  readonly path: string;
}

const ADMIN_AUTH_ROUTES: readonly RouteEntry[] = [
  { method: "get",    path: "/admin/stats" },
  { method: "get",    path: "/admin/users" },
  { method: "patch",  path: "/admin/users/:id" },
  { method: "get",    path: "/admin/administrators" },
  { method: "delete", path: "/admin/users/:id" },
  { method: "get",    path: "/admin/users/:id/membership" },
  { method: "get",    path: "/admin/refunds-disputes" },
  { method: "get",    path: "/admin/membership/grace-sweep" },
  { method: "post",   path: "/admin/users/:id/grant-lifetime" },
  { method: "post",   path: "/admin/users/:id/revoke-lifetime" },
  { method: "post",   path: "/admin/users" },
  { method: "get",    path: "/admin/facts" },
  { method: "get",    path: "/admin/facts/:id" },
  { method: "get",    path: "/admin/facts/:id/text-edit-history" },
  { method: "delete", path: "/admin/facts/:id" },
  { method: "patch",  path: "/admin/facts/:id" },
  { method: "post",   path: "/admin/facts/:id/enrich" },
  { method: "get",    path: "/admin/facts/:id/taxonomy-runs" },
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
  { method: "post",   path: "/admin/facts/backfill-ai-memes" },
  { method: "post",   path: "/admin/facts/backfill-embeddings" },
  { method: "get",    path: "/admin/config" },
  { method: "patch",  path: "/admin/config/:key" },
  { method: "get",    path: "/admin/stripe/summary" },
  { method: "post",   path: "/admin/stripe/full-sync" },
  { method: "post",   path: "/admin/stripe/sync" },
  { method: "post",   path: "/admin/stripe/sync/_test/simulate" },
  { method: "get",    path: "/admin/stripe/sync/status" },
  { method: "post",   path: "/admin/stripe/test-event" },
  { method: "get",    path: "/admin/feature-flags" },
  { method: "patch",  path: "/admin/feature-flags" },
  { method: "post",   path: "/admin/_debug/sentry" },
  { method: "get",    path: "/admin/sentry-status" },
  // Phase 1 queue-health surface. Both are read-only aggregations, but they
  // expose per-queue counts and per-job error text, so they are admin-gated
  // exactly like the rest of this table. (The UNAUTHENTICATED liveness probe
  // lives at /health/queues, outside this router, and deliberately returns only
  // a status code and lane counts — no queue names, no payloads, no errors.)
  { method: "get",    path: "/admin/queue-health" },
  { method: "get",    path: "/admin/queue-health/jobs" },
  { method: "get",    path: "/admin/email-queue" },
  { method: "delete", path: "/admin/email-queue" },
  { method: "post",   path: "/admin/email-queue/:id/retry" },
  { method: "get",    path: "/admin/users/:id/data-export" },
  { method: "post",   path: "/admin/retention/run" },
];

// Routes in admin.ts that are intentionally unauthenticated and therefore
// excluded from the introspection equality check below.
const UNAUTHENTICATED_ADMIN_FILE_PATHS: ReadonlySet<string> = new Set([
  "/config/public",
]);

function concretize(path: string): string {
  return path
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
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`));
  // The AI-meme backfill route enqueues for every active fact missing images in
  // the database, not only this file's, so its jobs are swept by creation time.
  await db.delete(asyncJobsTable).where(and(
    eq(asyncJobsTable.queue, FACT_AI_MEME_BACKFILL_QUEUE),
    gte(asyncJobsTable.createdAt, FILE_START),
  ));
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

// #455: the static ADMIN_API_KEY no longer opens any admin route. Even with
// the variable set and the matching header sent, a request without an admin
// session is refused exactly like any other unauthenticated one.
describe("the x-api-key header admits no one (#455)", () => {
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

  for (const path of [
    "/api/admin/users/set-password",
    "/api/admin/users/enable-notifications",
    "/api/admin/facts/backfill-ai-memes",
    "/api/admin/facts/backfill-embeddings",
    "/api/admin/stripe/full-sync",
    "/api/admin/stripe/sync",
  ]) {
    it(`POST ${path} with the matching key and no session is 401`, async () => {
      const app = buildTestApp({ kind: "unauthenticated" }, adminRouter);
      const res = await request(app).post(path).set("x-api-key", TEST_KEY).send({});
      assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    });
  }
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

// ── Admin-authenticated behaviour of the bulk backfill routes ─────────────────

describe("admin bulk backfill routes", () => {
  let adminApp: Express;

  before(async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      membershipTier: "registered",
      isAdmin: true,
    });
    adminApp = buildTestApp({ kind: "authenticated", userId: id }, adminRouter);
  });

  it("backfill-ai-memes is retired: it answers 410 and queues nothing", async () => {
    const [before] = await db.select({ n: count() }).from(asyncJobsTable).where(eq(asyncJobsTable.queue, FACT_AI_MEME_BACKFILL_QUEUE));
    const res = await request(adminApp).post("/api/admin/facts/backfill-ai-memes");
    assert.equal(res.status, 410);
    const [afterCount] = await db.select({ n: count() }).from(asyncJobsTable).where(eq(asyncJobsTable.queue, FACT_AI_MEME_BACKFILL_QUEUE));
    assert.equal(afterCount!.n, before!.n);
  });
});
