/**
 * Integration tests for admin API routes (routes/admin.ts).
 *
 * Mounts authMiddleware + adminRouter on an ephemeral Express app and drives
 * requests via supertest against the real test DB.
 *
 * For each key route the test matrix is:
 *   1. No credentials → 401 Unauthorized
 *   2. Authenticated as a non-admin user → 403 admin_required
 *   3. Authenticated as an admin → 200 with expected response shape
 *
 * Routes exercised:
 *   GET /admin/stats
 *   GET /admin/users
 *   GET /admin/facts
 *   GET /admin/comments/pending   (moderation)
 *   GET /admin/comments/flagged   (moderation)
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in cleanup cannot
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  adminConfigTable,
  usersTable,
  factsTable,
  factTextEditHistoryTable,
  pendingReviewsTable,
  asyncJobsTable,
  membershipEntitlementsTable,
  membershipHistoryTable,
} from "@workspace/db/schema";
import { like, eq, inArray, or, and } from "drizzle-orm";

import {
  NCMEC_RESERVED_CONFIG_KEYS,
  NCMEC_RESERVED_KEY_REFUSAL,
} from "../lib/moderation/ncmecConfig.js";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData, BOOTSTRAP_ADMIN_EMAIL } from "../lib/auth.js";
import { hashFactText } from "../lib/enrichmentVersioning.js";
import {
  APPROVED_FACT_TEXT_EDIT_PHRASE,
  FACT_TEXT_EDIT_CODES,
  buildPlaceholderFactEnrichment,
  computeProcessingSignatureStaleness,
} from "@workspace/api-zod";
import { currentProcessingSignatureFromConfig } from "../lib/processingSignature.js";
import { runGraceSweepOnce } from "../lib/membershipSchedules.js";


const USER_PREFIX = "troutesadmin-";
const FACT_PREFIX = "t-routes-admin-fact-";

function makeApp(): Express {
  const app = express();
  // Mirror the real server's body limit (app.ts: express.json({ limit: "2mb" })).
  // Bare express.json() defaults to 100 KB, which is BELOW the 2 MB contract
  // /admin/facts/import-csv advertises — so on the default this harness answers
  // a large-but-legal import with 413 before the route's own caps are ever
  // reached, and no test of those caps can mean anything.
  app.use(express.json({ limit: "2mb" }));
  app.use(authMiddleware);
  app.use(adminRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  tier?: "unregistered" | "registered" | "legendary";
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

async function sessionFor(userId: string, isAdmin: boolean): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin,
  };
  return createSession(sessionData, userId);
}

// Rows these tests create under ids/keys the prefix LIKEs cannot reach: users
// minted by POST /admin/users (generated ids) and durable jobs keyed by fact id.
const createdUserIds: string[] = [];
const jobFactIds: number[] = [];

async function cleanup(): Promise<void> {
  // membership_history.user_id / performed_by_admin_id are plain FKs (no cascade),
  // so history goes before the users it points at. Entitlements cascade.
  await db.delete(membershipHistoryTable).where(or(
    like(membershipHistoryTable.userId, `${USER_PREFIX}%`),
    like(membershipHistoryTable.performedByAdminId, `${USER_PREFIX}%`),
    createdUserIds.length ? inArray(membershipHistoryTable.userId, createdUserIds) : undefined,
  ));
  if (createdUserIds.length) await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  if (jobFactIds.length) {
    await db.delete(asyncJobsTable).where(inArray(
      asyncJobsTable.dedupeKey,
      jobFactIds.flatMap((id) => [`enrichment:fact:${id}`]),
    ));
  }
  // Triage reviews created by the variant/import endpoints reference the test
  // admin via submitted_by_id (no ON DELETE cascade), so they must be removed
  // before the users they point at.
  await db.delete(pendingReviewsTable).where(like(pendingReviewsTable.submittedById, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%`));
}

async function createTestFact(
  text: string,
  opts: { parentId?: number; isActive?: boolean } = {},
): Promise<number> {
  const active = opts.isActive ?? true;
  const [fact] = await db.insert(factsTable).values({
    text,
    parentId: opts.parentId,
    isActive: active,
    // Active facts require a non-empty Visual Concept (Phase 2 CHECK constraint).
    enrichment: active ? buildPlaceholderFactEnrichment() : undefined,
  }).returning({ id: factsTable.id });
  return fact!.id;
}

/**
 * A fact in the state the activation guard actually meets: one that WAS live and
 * has been deactivated, so it still carries the Visual Concept it was activated
 * with. `createTestFact({ isActive: false })` omits enrichment entirely, which is
 * a different row — a guard that rejected only CONCEPT-LESS inactive facts would
 * satisfy that fixture while letting an ordinary deactivated fact walk straight
 * back into production. (Codex, #567 round 2.)
 *
 * Deactivating after insert is exactly what the product does; the Phase 2 CHECK
 * constrains active rows only, so the concept survives the flip.
 */
async function createDeactivatedFact(text: string): Promise<number> {
  const id = await createTestFact(text);
  await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, id));
  const [row] = await db.select({ isActive: factsTable.isActive, enrichment: factsTable.enrichment })
    .from(factsTable).where(eq(factsTable.id, id));
  assert.equal(row.isActive, false, "precondition: the fact must be deactivated");
  assert.ok(
    (row.enrichment as { visualPromptStrategyOverride?: { coreSceneOverride?: string } } | null)
      ?.visualPromptStrategyOverride?.coreSceneOverride?.trim(),
    "precondition: a deactivated fact must RETAIN its Visual Concept, or this fixture is not the real state",
  );
  return id;
}

// ── Shared test state ─────────────────────────────────────────────────────────

let adminSid: string;
let userSid: string;
let adminUserId: string;

before(async () => {
  await cleanup();
  const adminId = await createTestUser({ isAdmin: true });
  adminUserId = adminId;
  const userId = await createTestUser({ isAdmin: false, tier: "legendary" });
  adminSid = await sessionFor(adminId, true);
  userSid = await sessionFor(userId, false);
});

after(cleanup);

// ── GET /admin/stats ──────────────────────────────────────────────────────────

describe("GET /admin/stats", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/stats");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/stats")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with totalFacts and totalUsers for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/stats")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok("totalFacts" in res.body, "response should have totalFacts");
    assert.ok("totalUsers" in res.body, "response should have totalUsers");
    assert.equal(typeof res.body.totalFacts, "number");
    assert.equal(typeof res.body.totalUsers, "number");
  });
});

// ── GET /admin/users ──────────────────────────────────────────────────────────

describe("GET /admin/users", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/users");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with users array, total, page, and limit for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users), "users should be an array");
    assert.equal(typeof res.body.total, "number");
    assert.equal(typeof res.body.page, "number");
    assert.equal(typeof res.body.limit, "number");
  });

  it("filters results via ?search and still returns the standard shape", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .query({ search: USER_PREFIX })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(
      (res.body.users as Array<{ email: string }>).every((u) =>
        u.email.includes(USER_PREFIX),
      ),
      "every returned user email should match the search prefix",
    );
  });

  it("respects ?limit and ?page pagination params", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .query({ limit: "1", page: "1" })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length <= 1, "should return at most 1 user");
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 1);
  });
});

// ── GET /admin/facts ──────────────────────────────────────────────────────────

describe("GET /admin/facts", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/facts");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with facts array, total, page, and limit for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.facts), "facts should be an array");
    assert.equal(typeof res.body.total, "number");
    assert.equal(typeof res.body.page, "number");
    assert.equal(typeof res.body.limit, "number");
  });

  it("each fact row exposes the expected fields", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .query({ limit: "1" })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    if ((res.body.facts as unknown[]).length === 0) return;
    const fact = res.body.facts[0] as Record<string, unknown>;
    for (const key of ["id", "text", "isActive", "upvotes", "downvotes", "createdAt"]) {
      assert.ok(key in fact, `fact should have field "${key}"`);
    }
  });

  it("includes active roots that have inactive variants in the inactive view", async () => {
    const suffix = randomUUID();
    const rootText = `${FACT_PREFIX}inactive-variant-root-${suffix}`;
    const variantText = `${FACT_PREFIX}inactive-variant-child-${suffix}`;
    const rootId = await createTestFact(rootText, { isActive: true });
    const variantId = await createTestFact(variantText, { parentId: rootId, isActive: false });

    const res = await request(makeApp())
      .get("/admin/facts")
      .query({ visibility: "inactive", search: variantText, limit: "100" })
      .set("authorization", `Bearer ${adminSid}`);

    assert.equal(res.status, 200);
    const root = (res.body.facts as Array<{ id: number; variants: Array<{ id: number; isActive: boolean }> }>)
      .find((fact) => fact.id === rootId);
    assert.ok(root, "active root should be returned as the container for its inactive variant");
    assert.deepEqual(root.variants.map((variant) => variant.id), [variantId]);
    assert.ok(root.variants.every((variant) => variant.isActive === false));
  });
});

// ── GET /admin/comments/pending (moderation) ──────────────────────────────────

describe("GET /admin/comments/pending", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/comments/pending");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/pending")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with comments array and total for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/pending")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.comments), "comments should be an array");
    assert.equal(typeof res.body.total, "number");
  });
});

// ── GET /admin/comments/flagged (moderation) ──────────────────────────────────

describe("GET /admin/comments/flagged", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/comments/flagged");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/flagged")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with comments array for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/flagged")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.comments), "comments should be an array");
  });
});

// ── PATCH /admin/users/:id ────────────────────────────────────────────────────

describe("PATCH /admin/users/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/some-id")
      .send({ isActive: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/some-id")
      .set("authorization", `Bearer ${userSid}`)
      .send({ isActive: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  // Happy-path: confirms requireAdmin admits an admin and the route
  // updates the target row. Regression-catches both auth admission and
  // basic handler behaviour. Other write routes in this file deliberately
  // share the same middleware (`requireAdmin`); a single happy-path here
  // is sufficient to catch admit-admins regressions, since the read-route
  // 200 tests above also exercise the same gate.
  it("returns 200 and updates the target user when called by an admin", async () => {
    const targetId = await createTestUser({ isAdmin: false });
    const res = await request(makeApp())
      .patch(`/admin/users/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ displayName: "patched-by-test" });
    assert.equal(
      res.status,
      200,
      `expected 200, got ${res.status} (body: ${JSON.stringify(res.body)})`,
    );
    assert.equal(res.body.success, true);
    assert.equal((res.body.user as { displayName?: string }).displayName, "patched-by-test");
  });

  // Round 2 of PR #425's review: the email-change lockout guard used to reject
  // ANY change crossing the bootstrap-email boundary, even when the target
  // remains a real admin through `is_admin` — nothing is actually being
  // removed. Isolated from the admin-population count entirely: `is_admin`
  // stays true across the change, so the guard never runs for this request
  // regardless of how many other admins exist.
  it("allows an email change away from the bootstrap address when the target is independently is_admin", async () => {
    const targetId = await createTestUser({ isAdmin: true });
    // Start the target ON the bootstrap address so the change below actually
    // crosses the boundary — the bug only reproduces on a real crossing.
    await db.update(usersTable).set({ email: BOOTSTRAP_ADMIN_EMAIL }).where(eq(usersTable.id, targetId));
    const newEmail = `${randomUUID()}@example.test`;
    const res = await request(makeApp())
      .patch(`/admin/users/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ email: newEmail });
    assert.equal(
      res.status,
      200,
      `expected 200, got ${res.status} (body: ${JSON.stringify(res.body)})`,
    );
    assert.equal((res.body.user as { email?: string }).email, newEmail);
  });
});

// ── Removed routes ───────────────────────────────────────────────────────────

describe("POST /admin/users/:id/data-delete (removed)", () => {
  // Deleted deliberately: its hard phase was redundant with DELETE /admin/users/:id
  // and threw 23503 on membership_history's FK. Authenticate as admin so a 404 here
  // means "no such route" rather than "rejected before routing".
  it("no longer exists — DELETE /admin/users/:id is the deletion path", async () => {
    const res = await request(makeApp())
      .post("/admin/users/some-id/data-delete")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ phase: "hard" });
    assert.equal(res.status, 404);
  });
});

// ── DELETE /admin/users/:id ───────────────────────────────────────────────────

describe("DELETE /admin/users/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).delete("/admin/users/some-id");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/some-id")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── POST /admin/users/:id/grant-lifetime ──────────────────────────────────────

describe("POST /admin/users/:id/grant-lifetime", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .post("/admin/users/some-id/grant-lifetime")
      .send({});
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .post("/admin/users/some-id/grant-lifetime")
      .set("authorization", `Bearer ${userSid}`)
      .send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── PATCH /admin/facts/:id ────────────────────────────────────────────────────

describe("PATCH /admin/facts/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/facts/some-id")
      .send({ isActive: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/facts/some-id")
      .set("authorization", `Bearer ${userSid}`)
      .send({ isActive: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("normalizes text and recomputes canonicalText/splitTokenIndex/hasPronouns from the normalized text", async () => {
    // A live fact is protected, so a text change now requires the confirmation
    // envelope (approved-fact-text lock). Normalization/derived-metadata is the
    // same on the confirmed path.
    const original = `${FACT_PREFIX}${randomUUID()} original text`;
    const factId = await createTestFact(original);
    const res = await request(makeApp())
      .patch(`/admin/facts/${factId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({
        text: "{Subj} keeps it locked in {POSS} back yard.",
        confirmTextEdit: {
          phrase: APPROVED_FACT_TEXT_EDIT_PHRASE,
          reason: "UAT: verifying normalization on the confirmed path.",
          expectedOldTextHash: hashFactText(original),
        },
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.fact.text, "{Subj} {keeps|keep} it locked in {POSS} back yard.");

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.ok(row);
    assert.equal(row.text, "{Subj} {keeps|keep} it locked in {POSS} back yard.");
    assert.equal(row.hasPronouns, true);
    assert.ok(row.canonicalText);
    assert.equal(typeof row.splitTokenIndex, "number");
  });

  it("a confirmed edit on a VARIANT (parentId set) commits normally — the embed/image-pipeline dispatch is no longer root-only (variant independence, site 6)", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} variant-edit root`);
    const original = `${FACT_PREFIX}${randomUUID()} variant original text`;
    const variantId = await createTestFact(original, { parentId: rootId });
    const res = await request(makeApp())
      .patch(`/admin/facts/${variantId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({
        text: "{Subj} keeps it locked as a variant.",
        confirmTextEdit: {
          phrase: APPROVED_FACT_TEXT_EDIT_PHRASE,
          reason: "verifying the confirmed-edit dispatch runs for a variant too.",
          expectedOldTextHash: hashFactText(original),
        },
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, variantId));
    assert.equal(row?.parentId, rootId, "still a variant — the dispatch decision is no longer gated on this");
  });

  it("validates before updating — rejects grammar-invalid text with 422 and does not write it", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} original text`;
    const factId = await createTestFact(original);
    const res = await request(makeApp())
      .patch(`/admin/facts/${factId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: "bad token {FOO}" });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /grammar validation failed/);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.ok(row);
    assert.equal(row.text, original, "text must not change on grammar-invalid update");
  });

  it("rejects pointing an ACTIVE fact's parentId at a fact that isn't an active root", async () => {
    const activeFact = await createTestFact(`${FACT_PREFIX}${randomUUID()} stays active`);
    const inactiveTarget = await createTestFact(`${FACT_PREFIX}${randomUUID()} inactive target`, { isActive: false });
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: inactiveTarget });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "PARENT_NOT_ACTIVE");

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.parentId, null, "parentId must not have been written");
  });

  it("allows pointing an ACTIVE fact's parentId at a genuine active root", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} genuine root`);
    const activeFact = await createTestFact(`${FACT_PREFIX}${randomUUID()} becomes a variant`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: rootId });
    assert.equal(res.status, 200);

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.parentId, rootId);
  });

  it("rejects a fact being set as its own parent", async () => {
    const activeFact = await createTestFact(`${FACT_PREFIX}${randomUUID()} self-parent attempt`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: activeFact });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SELF_PARENT");

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.parentId, null, "self-parent must not have been written");
  });

  it("rejects reparenting an active fact that itself has active variants", async () => {
    const newParent = await createTestFact(`${FACT_PREFIX}${randomUUID()} would-be new parent`);
    const rootWithChild = await createTestFact(`${FACT_PREFIX}${randomUUID()} root with a child`);
    const childId = await createTestFact(`${FACT_PREFIX}${randomUUID()} its active child`, { parentId: rootWithChild });
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootWithChild}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: newParent });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "HAS_ACTIVE_VARIANTS");

    const rows = await db.select({ id: factsTable.id, parentId: factsTable.parentId, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [rootWithChild, childId]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(rootWithChild)?.parentId, null, "reparent must not have been written");
    assert.equal(byId.get(childId)?.isActive, true, "the child must still be active and unaffected");
  });

  it("allows reparenting an active fact once its active variants are deactivated first", async () => {
    const newParent = await createTestFact(`${FACT_PREFIX}${randomUUID()} eligible new parent`);
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} root, child now inactive`);
    await createTestFact(`${FACT_PREFIX}${randomUUID()} inactive child`, { parentId: rootId, isActive: false });
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: newParent });
    assert.equal(res.status, 200);

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, rootId));
    assert.equal(row.parentId, newParent);
  });

  it("allows an inactive fact's parentId to be set freely (activateFact revalidates later)", async () => {
    const inactiveFact = await createTestFact(`${FACT_PREFIX}${randomUUID()} inactive edit`, { isActive: false });
    const inactiveTarget = await createTestFact(`${FACT_PREFIX}${randomUUID()} inactive parent target`, { isActive: false });
    const res = await request(makeApp())
      .patch(`/admin/facts/${inactiveFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: inactiveTarget });
    assert.equal(res.status, 200);

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, inactiveFact));
    assert.equal(row.parentId, inactiveTarget);
  });

  // The reparent guards above run through the non-text PATCH branch. A PATCH
  // that ALSO carries `text` forks into confirmedFactTextEdit.ts instead — a
  // separate write path that used to apply `parentId` completely unguarded
  // (Codex round 6). These mirror the same three scenarios through that path,
  // sending back the fact's own unchanged text (the no-op-text branch, which
  // still applies non-text deltas like everything else here).
  it("rejects pointing an ACTIVE fact's parentId at a non-root when text is also present (text-edit path)", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} unchanged text with reparent`;
    const activeFact = await createTestFact(original);
    const inactiveTarget = await createTestFact(`${FACT_PREFIX}${randomUUID()} inactive target via text path`, { isActive: false });
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: original, parentId: inactiveTarget });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "PARENT_NOT_ACTIVE");

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.parentId, null, "parentId must not have been written");
  });

  it("allows pointing an ACTIVE fact's parentId at a genuine active root when text is also present (text-edit path)", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} unchanged text becomes variant`;
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} genuine root via text path`);
    const activeFact = await createTestFact(original);
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: original, parentId: rootId });
    assert.equal(res.status, 200);

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.parentId, rootId);
  });

  it("rejects reparenting a root that itself has active variants when text is also present (text-edit path)", async () => {
    const newParent = await createTestFact(`${FACT_PREFIX}${randomUUID()} would-be new parent via text path`);
    const original = `${FACT_PREFIX}${randomUUID()} root with a child, text path`;
    const rootWithChild = await createTestFact(original);
    const childId = await createTestFact(`${FACT_PREFIX}${randomUUID()} its active child via text path`, { parentId: rootWithChild });
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootWithChild}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: original, parentId: newParent });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "HAS_ACTIVE_VARIANTS");

    const rows = await db.select({ id: factsTable.id, parentId: factsTable.parentId, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [rootWithChild, childId]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(rootWithChild)?.parentId, null, "reparent must not have been written");
    assert.equal(byId.get(childId)?.isActive, true, "the child must still be active and unaffected");
  });

  it("deactivating a root via this PATCH cascades to its active variants", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} cascade-patch root`);
    const childId = await createTestFact(`${FACT_PREFIX}${randomUUID()} cascade-patch child`, { parentId: rootId });
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: false });
    assert.equal(res.status, 200);

    const rows = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [rootId, childId]));
    for (const r of rows) assert.equal(r.isActive, false);
  });

  // ── Activation is moderation-only ──────────────────────────────────────────
  //
  // A content-safety invariant, not a tidiness one. The admin Active toggle may
  // DEACTIVATE a fact (covered above), but a false→true flip here would bypass
  // the entire production gate approveForProduction/activateFact enforce — the
  // Visual Concept check, active-root parent revalidation, the pending_reviews
  // transition, production-approval recording and submitter notification. A
  // regression would silently let a deactivated fact go live around moderation,
  // which is precisely the failure nothing would have noticed before these.
  it("rejects flipping an INACTIVE fact to active — activation is moderation-only", async () => {
    const inactiveFact = await createDeactivatedFact(`${FACT_PREFIX}${randomUUID()} deactivated, wants back live`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${inactiveFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "ACTIVATION_REQUIRES_MODERATION");

    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, inactiveFact));
    assert.equal(row.isActive, false, "the fact must still be inactive — activation must not have been written");
  });

  // The guard returns before ANY write, so it rejects the whole request rather
  // than the isActive field alone. Without this, a guard that dropped isActive
  // and carried on would still pass the assertion above.
  it("rejects the whole request — a field sent alongside the activation attempt is not written either", async () => {
    const inactiveFact = await createDeactivatedFact(`${FACT_PREFIX}${randomUUID()} activation with a passenger field`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${inactiveFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: true, upvotes: 4242 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "ACTIVATION_REQUIRES_MODERATION");

    const [row] = await db.select({ isActive: factsTable.isActive, upvotes: factsTable.upvotes }).from(factsTable).where(eq(factsTable.id, inactiveFact));
    assert.equal(row.isActive, false, "the fact must still be inactive");
    assert.notEqual(row.upvotes, 4242, "the co-submitted field must not have been written either");
  });

  // A PATCH carrying `text` forks into confirmedFactTextEdit.ts — the same
  // second write path that used to apply `parentId` unguarded (Codex round 6).
  // The activation guard sits ahead of that fork, and this is what holds it
  // there.
  it("rejects flipping an INACTIVE fact to active when text is also present (text-edit path)", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} inactive, activation via text path`;
    const inactiveFact = await createDeactivatedFact(original);
    const res = await request(makeApp())
      .patch(`/admin/facts/${inactiveFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: original, isActive: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "ACTIVATION_REQUIRES_MODERATION");

    const [row] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, inactiveFact));
    assert.equal(row.isActive, false, "the fact must still be inactive — the text path must not activate either");
  });

  // The deliberate no-op half of the rule: asserting isActive=true on a fact
  // that is ALREADY active is not an activation, so it is dropped rather than
  // rejected. This is what stops the guard from breaking an ordinary admin save
  // that round-trips the fact's current state.
  it("accepts isActive=true on an ALREADY-ACTIVE fact as a harmless no-op", async () => {
    const activeFact = await createTestFact(`${FACT_PREFIX}${randomUUID()} already active, asserted active`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${activeFact}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: true, upvotes: 7 });
    assert.equal(res.status, 200);

    const [row] = await db.select({ isActive: factsTable.isActive, upvotes: factsTable.upvotes }).from(factsTable).where(eq(factsTable.id, activeFact));
    assert.equal(row.isActive, true, "the fact must still be active");
    assert.equal(row.upvotes, 7, "the rest of the request must still have been applied");
  });
});

// ── POST /admin/facts/:id/variants ────────────────────────────────────────────

describe("POST /admin/facts/:id/variants", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).post("/admin/facts/1/variants").send({ text: "hi" });
    assert.equal(res.status, 401);
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .post("/admin/facts/1/variants")
      .set("authorization", `Bearer ${userSid}`)
      .send({ text: "hi" });
    assert.equal(res.status, 403);
  });

  it("queues the variant as a Stage-1 review carrying the parent (no active variant fact)", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} root fact`);
    const res = await request(makeApp())
      .post(`/admin/facts/${rootId}/variants`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: "{Subj} keeps it locked in {POSS} back yard." });
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, true);
    assert.equal(typeof res.body.reviewId, "number");

    // A triage review was created carrying the parent; no fact was written.
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.ok(review, "triage review should exist");
    assert.equal(review.workflowStage, "triage_pending");
    assert.equal(review.parentFactId, rootId);
    assert.equal(review.submittedText, "{Subj} {keeps|keep} it locked in {POSS} back yard.");
    const variants = await db.select().from(factsTable).where(eq(factsTable.parentId, rootId));
    assert.equal(variants.length, 0, "no active variant fact is created — it goes through moderation");
  });

  it("returns 422 for a grammar-invalid variant and does not queue it (not a bulk path)", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} root fact`);
    const res = await request(makeApp())
      .post(`/admin/facts/${rootId}/variants`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: "bad token {FOO}" });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /grammar validation failed/);

    const variants = await db.select().from(factsTable).where(eq(factsTable.parentId, rootId));
    assert.equal(variants.length, 0, "invalid variant must not be written");
  });
});

// ── POST /admin/facts/import ──────────────────────────────────────────────────

describe("POST /admin/facts/import", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).post("/admin/facts/import").send({ facts: ["hi"] });
    assert.equal(res.status, 401);
  });

  it("queues valid rows for moderation and reports invalid rows in `failed` (partial success)", async () => {
    const suffix = randomUUID();
    const rawText = `${FACT_PREFIX}${suffix} {Subj} keeps it locked in {POSS} back yard.`;
    const expectedText = `${FACT_PREFIX}${suffix} {Subj} {keeps|keep} it locked in {POSS} back yard.`;
    const res = await request(makeApp())
      .post("/admin/facts/import")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ facts: [rawText, "bad token {FOO}"] });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].error, /grammar validation failed/);

    // The valid row became a Stage-1 review (normalized), NOT an active fact.
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.submittedText, expectedText));
    assert.ok(review, "valid row should have been queued as a review");
    assert.equal(review.workflowStage, "triage_pending");
    const factRows = await db.select().from(factsTable).where(eq(factsTable.text, expectedText));
    assert.equal(factRows.length, 0, "bulk import must not write the fact directly");
  });
});

// ── POST /admin/facts/import-csv ──────────────────────────────────────────────

describe("POST /admin/facts/import-csv", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).post("/admin/facts/import-csv").send({ csv: "hi there" });
    assert.equal(res.status, 401);
  });

  it("queues valid lines for moderation and reports invalid lines in `failed` (partial success)", async () => {
    const rawText = `${FACT_PREFIX}${randomUUID()} {Subj} keeps it locked in {POSS} back yard.`;
    const expectedText = rawText.replace("{Subj} keeps", "{Subj} {keeps|keep}");
    const csv = `${rawText}\nbad token {FOO} here\n`;
    const res = await request(makeApp())
      .post("/admin/facts/import-csv")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ csv });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].error, /grammar validation failed/);

    // The valid line became a Stage-1 review (normalized), NOT an active fact.
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.submittedText, expectedText));
    assert.ok(review, "valid line should have been queued as a review");
    assert.equal(review.workflowStage, "triage_pending");

    const factRows = await db.select().from(factsTable).where(eq(factsTable.text, expectedText));
    assert.equal(factRows.length, 0, "bulk CSV import must not write the fact directly");
  });

  // ── The 2000-row cap ───────────────────────────────────────────────────────
  //
  // The ADJACENT cap — the ≤2 MB byte limit on the raw string — is already
  // covered (admin.validation.security.test.ts, via ImportCsvBody). That is
  // exactly what made this hole read as covered at a glance: two caps guarding
  // the same endpoint, one proven and one not.
  //
  // The over-cap rows are deliberately VALID templates. Invalid ones would have
  // queued nothing whether the cap fired or not, which would make the
  // "queued nothing" assertion below unfalsifiable — it would still pass if the
  // cap were moved AFTER the queue write. Valid rows mean that assertion can
  // only hold because the request was rejected before any row was processed.
  // The at-cap row below is invalid on purpose for the opposite reason: it only
  // needs to be COUNTED (the cap is applied to the split lines, before any
  // validation runs), and staying invalid keeps 2000 rows out of the database.
  const overCapMarker = randomUUID();

  it("rejects an import of more than 2000 rows, by ROW COUNT and not by byte size", async () => {
    const rows = Array.from(
      { length: 2001 },
      (_, i) => `${FACT_PREFIX}${overCapMarker}-${i} {Subj} keeps it locked in {POSS} back yard.`,
    );
    const csv = rows.join("\n");
    // Pin that this is the row cap firing and not the 2 MB byte cap: the
    // payload has to be comfortably inside the byte limit for the assertion
    // below to mean anything.
    assert.ok(
      Buffer.byteLength(csv, "utf8") < 2_000_000,
      "the over-cap payload must stay well under the 2 MB byte limit, or this proves the wrong cap",
    );

    const res = await request(makeApp())
      .post("/admin/facts/import-csv")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ csv });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Too many rows \(2001\); import at most 2000 per call/);
    assert.equal(res.body.success, undefined, "an over-cap import must not report partial success");

    // Rejected up front, so not one row of this batch was processed. Scoped to
    // this test's own marker, so it asserts nothing about the rest of the DB.
    const queued = await db
      .select({ id: pendingReviewsTable.id })
      .from(pendingReviewsTable)
      .where(like(pendingReviewsTable.submittedText, `%${overCapMarker}%`));
    assert.equal(queued.length, 0, "an over-cap import must queue nothing at all");
  });

  it("accepts an import of exactly 2000 rows — the cap is inclusive", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `bad token {FOO} ${randomUUID()} row ${i}`);
    const res = await request(makeApp())
      .post("/admin/facts/import-csv")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ csv: rows.join("\n") });
    assert.equal(res.status, 200, "exactly 2000 rows is at the cap, not over it");
    assert.equal(res.body.success, true);
    assert.equal(res.body.failed.length, 2000, "all 2000 rows must have been processed, not truncated");
  });
});

// ── DELETE /admin/facts/:id ───────────────────────────────────────────────────

describe("DELETE /admin/facts/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).delete("/admin/facts/some-id");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .delete("/admin/facts/some-id")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("soft-delete of a root cascades to its active variants", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} soft-delete root`);
    const childId = await createTestFact(`${FACT_PREFIX}${randomUUID()} soft-delete child`, { parentId: rootId });
    const res = await request(makeApp())
      .delete(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, false);

    const rows = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [rootId, childId]));
    for (const r of rows) assert.equal(r.isActive, false, "both root and its variant must be inactive");
  });

  it("hard-delete of a root cascades to its active variants (never left orphaned+active)", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} hard-delete root`);
    const childId = await createTestFact(`${FACT_PREFIX}${randomUUID()} hard-delete child`, { parentId: rootId });
    const res = await request(makeApp())
      .delete(`/admin/facts/${rootId}?hard=true`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);

    const [rootRow] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, rootId));
    assert.equal(rootRow, undefined, "root should be hard-deleted");
    const [childRow] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, childId));
    assert.equal(childRow.isActive, false, "the orphaned variant must be deactivated, not left active");
  });
});

// ── PATCH /admin/config/:key ──────────────────────────────────────────────────

describe("PATCH /admin/config/:key", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/config/some-key")
      .send({ value: "test" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/config/some-key")
      .set("authorization", `Bearer ${userSid}`)
      .send({ value: "test" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  // Migration 0097 seeds the NCMEC keys into admin_config, and this route
  // writes any key that exists there after validating nothing but data type and
  // min/max. Without the refusal below, an admin could set
  // ncmec_submission_enabled = true and ncmec_ispws_environment = production
  // through a route that knows nothing about backlog audits — and once the
  // worker registers, that configuration files real reports with the activation
  // gate bypassed.
  it("refuses every reserved NCMEC key, even for an admin", async () => {
    for (const key of NCMEC_RESERVED_CONFIG_KEYS) {
      const res = await request(makeApp())
        .patch(`/admin/config/${key}`)
        .set("authorization", `Bearer ${adminSid}`)
        .send({ value: "true" });
      assert.equal(res.status, 403, `${key} was not refused`);
      assert.equal(res.body.error, NCMEC_RESERVED_KEY_REFUSAL);
    }
  });

  it("refuses a reserved key before it inspects the body", async () => {
    // A 400 "value is required" would tell the caller the wrong thing about why
    // the write failed — the key could never have been written here at all.
    const res = await request(makeApp())
      .patch("/admin/config/ncmec_submission_enabled")
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, NCMEC_RESERVED_KEY_REFUSAL);
  });

  it("still writes ncmec_safety_alert_email, which is deliberately not reserved", async () => {
    // It cannot cause a filing, and reserving it would make a routine
    // operational edit need a bespoke endpoint. It is guarded by the activation
    // gate instead — production is refused unless a recipient resolves.
    //
    // Seeded here rather than assumed present: the sharded test runner clones
    // each worker database from a `pg_dump --schema-only` template, so 0097's
    // seed INSERTs from the shared "pretest" migrate run never reach a worker's
    // admin_config — only the schema does. Seeding it (idempotently, matching
    // 0097's own row shape) makes this test self-contained regardless of which
    // database state it runs against.
    const [existing] = await db
      .select({ value: adminConfigTable.value })
      .from(adminConfigTable)
      .where(eq(adminConfigTable.key, "ncmec_safety_alert_email"));
    if (!existing) {
      await db.insert(adminConfigTable).values({
        key: "ncmec_safety_alert_email",
        value: "",
        dataType: "text",
        label: "NCMEC Safety Alert Email",
        isPublic: false,
      }).onConflictDoNothing();
    }
    const originalValue = existing?.value ?? "";
    try {
      const res = await request(makeApp())
        .patch("/admin/config/ncmec_safety_alert_email")
        .set("authorization", `Bearer ${adminSid}`)
        .send({ value: "safety@example.test" });
      assert.equal(res.status, 200);
    } finally {
      if (existing) {
        await db
          .update(adminConfigTable)
          .set({ value: originalValue })
          .where(eq(adminConfigTable.key, "ncmec_safety_alert_email"));
      } else {
        await db.delete(adminConfigTable).where(eq(adminConfigTable.key, "ncmec_safety_alert_email"));
      }
    }
  });
});

describe("GET /admin/facts/:id/text-edit-history", () => {
  it("requires admin", async () => {
    const res = await request(makeApp()).get("/admin/facts/1/text-edit-history");
    assert.equal(res.status, 401);
  });

  it("returns fact-scoped entries newest-first with a deleted-actor fallback", async () => {
    const factId = await createTestFact(`${FACT_PREFIX}${randomUUID()} history fact`);
    // Two rows: one by the admin, one by an already-deleted admin (performedBy null).
    await db.insert(factTextEditHistoryTable).values([
      { factId, oldText: "a", newText: "b", reason: "first edit reason here", performedBy: null },
      { factId, oldText: "b", newText: "c", reason: "second edit reason here", performedBy: adminUserId },
    ]);
    const res = await request(makeApp())
      .get(`/admin/facts/${factId}/text-edit-history`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    // Newest-first: the second insert (by id desc) comes first.
    assert.equal(res.body.entries[0].newText, "c");
    assert.ok(res.body.entries[0].actor, "actor present for a live admin");
    assert.equal(res.body.entries[1].newText, "b");
    assert.equal(res.body.entries[1].actor, null, "null actor for a deleted admin");
  });

  it("404s for a missing fact", async () => {
    const res = await request(makeApp())
      .get("/admin/facts/999999999/text-edit-history")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 404);
  });
});

// ── Bulk import: size caps, dedup, and the inclusive cap ──────────────────────

describe("POST /admin/facts/import — caps and dedup", () => {
  const validRow = (marker: string, i: number) =>
    `${FACT_PREFIX}${marker}-${i} {Subj} {keeps|keep} it locked in {POSS} back yard.`;

  it("rejects 1001 valid facts with 400 Invalid input and queues none of them", async () => {
    const marker = randomUUID();
    const facts = Array.from({ length: 1001 }, (_, i) => validRow(marker, i));
    const res = await request(makeApp())
      .post("/admin/facts/import")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ facts });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid input");

    // Every row is a valid template, so "queued nothing" can only hold because the
    // request was refused before any row was processed.
    const queued = await db
      .select({ id: pendingReviewsTable.id })
      .from(pendingReviewsTable)
      .where(like(pendingReviewsTable.submittedText, `%${marker}%`));
    assert.equal(queued.length, 0, "an over-cap import must queue nothing at all");
  });

  it("accepts exactly 1000 facts and processes all of them — the cap is inclusive", async () => {
    const marker = randomUUID();
    const facts = Array.from({ length: 1000 }, (_, i) => validRow(marker, i));
    const res = await request(makeApp())
      .post("/admin/facts/import")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ facts });
    assert.equal(res.status, 200, "exactly 1000 is at the cap, not over it");
    assert.equal(res.body.success, true);
    assert.equal(res.body.queued, 1000, "all 1000 must be queued, not truncated");
    assert.equal(res.body.failed.length, 0);

    const queued = await db
      .select({ id: pendingReviewsTable.id })
      .from(pendingReviewsTable)
      .where(like(pendingReviewsTable.submittedText, `%${marker}%`));
    assert.equal(queued.length, 1000, "every row must have a review");
  });

  it("skips a text matching an existing fact and one matching an unresolved review, queuing no new review", async () => {
    const marker = randomUUID();
    const factText = validRow(marker, 1);
    const reviewText = validRow(marker, 2);
    await createTestFact(factText);
    await db.insert(pendingReviewsTable).values({
      submittedText: reviewText,
      status: "pending",
      workflowStage: "triage_pending",
      submittedById: adminUserId,
    } as typeof pendingReviewsTable.$inferInsert);

    for (const text of [factText, reviewText]) {
      const res = await request(makeApp())
        .post("/admin/facts/import")
        .set("authorization", `Bearer ${adminSid}`)
        .send({ facts: [text] });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued, 0, `${text} must not be queued again`);
      assert.equal(res.body.skipped, 1);
    }

    // No review was added for the fact-matching text, and the review-matching text
    // still has exactly the one it started with.
    const factReviews = await db.select({ id: pendingReviewsTable.id }).from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.submittedText, factText));
    assert.equal(factReviews.length, 0, "a text matching an existing fact must not get a review");
    const reviewRows = await db.select({ id: pendingReviewsTable.id }).from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.submittedText, reviewText));
    assert.equal(reviewRows.length, 1, "a text matching an unresolved review must not get a second one");
  });
});

describe("POST /admin/facts/import-csv — byte cap", () => {
  it("rejects a csv over 2,000,000 characters (but under the 2 MiB limit and 2000 rows) with 400 Invalid input and queues nothing", async () => {
    const marker = randomUUID();
    // 100 valid, ~20 KB lines: >2,000,000 characters, <2 MiB on the wire, <2000 rows —
    // so neither the request-size limit nor the row cap can be what refuses it.
    const filler = "x".repeat(20_000);
    const csv = Array.from(
      { length: 100 },
      (_, i) => `${FACT_PREFIX}${marker}-${i} {Subj} {keeps|keep} it locked in {POSS} back yard. ${filler}`,
    ).join("\n");
    assert.ok(csv.length > 2_000_000, "precondition: the csv must exceed the 2,000,000-character cap");
    assert.ok(Buffer.byteLength(csv, "utf8") < 2 * 1024 * 1024, "precondition: it must stay under the 2 MiB request limit");

    const res = await request(makeApp())
      .post("/admin/facts/import-csv")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ csv });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid input");

    const queued = await db
      .select({ id: pendingReviewsTable.id })
      .from(pendingReviewsTable)
      .where(like(pendingReviewsTable.submittedText, `%${marker}%`));
    assert.equal(queued.length, 0, "an over-cap csv must queue nothing at all");
  });
});

// ── PATCH /admin/facts/:id — the approved-fact-text lock over HTTP ────────────

describe("PATCH /admin/facts/:id — approved text lock", () => {
  async function insertReview(stagingFactId: number, workflowStage: string): Promise<number> {
    const [rev] = await db.insert(pendingReviewsTable).values({
      submittedText: "x",
      status: "pending",
      stagingFactId,
      workflowStage,
      candidateVersionId: null,
      submittedById: adminUserId,
    } as typeof pendingReviewsTable.$inferInsert).returning({ id: pendingReviewsTable.id });
    return rev!.id;
  }

  function confirmFor(oldText: string) {
    return {
      phrase: APPROVED_FACT_TEXT_EDIT_PHRASE,
      reason: "verifying the confirmed edit over HTTP.",
      expectedOldTextHash: hashFactText(oldText),
    };
  }

  it("answers 409 REQUIRES_CONFIRMATION with the impact for changed text on a live fact, and 200 once confirmed", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} live original`;
    const factId = await createTestFact(original);
    const newText = `${FACT_PREFIX}${randomUUID()} live reworded`;

    const unconfirmed = await request(makeApp())
      .patch(`/admin/facts/${factId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: newText });
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.code, FACT_TEXT_EDIT_CODES.REQUIRES_CONFIRMATION);
    assert.equal(unconfirmed.body.impact.protected, true);
    assert.equal(unconfirmed.body.impact.protectionReason, "active");
    assert.equal(unconfirmed.body.impact.currentStoredText, original);
    assert.equal(unconfirmed.body.impact.normalizedProposedText, newText);
    assert.equal(unconfirmed.body.impact.expectedOldTextHash, hashFactText(original));
    const [untouched] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(untouched?.text, original, "an unconfirmed edit must not write");

    const confirmed = await request(makeApp())
      .patch(`/admin/facts/${factId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: newText, confirmTextEdit: confirmFor(original) });
    assert.equal(confirmed.status, 200);
    const [stored] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(stored?.text, newText, "the confirmed edit must be stored");
  });

  it("restarts prep on an inactive staging fact at concept_review: 200, review to prep_pending, one enrichment job queued", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} staging original`;
    const factId = await createTestFact(original, { isActive: false });
    jobFactIds.push(factId);
    const reviewId = await insertReview(factId, "concept_review");
    const newText = `${FACT_PREFIX}${randomUUID()} staging reworded`;

    const res = await request(makeApp())
      .patch(`/admin/facts/${factId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: newText });
    assert.equal(res.status, 200);

    const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(fact?.text, newText);
    const [review] = await db.select({ stage: pendingReviewsTable.workflowStage })
      .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review?.stage, "prep_pending");
    const jobs = await db.select({ status: asyncJobsTable.status }).from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `enrichment:fact:${factId}`));
    assert.equal(jobs.length, 1, "exactly one enrichment job must be queued");
    assert.ok(["pending", "processing"].includes(jobs[0]!.status), "and it must be nonterminal");
  });

  async function rootWithReviewingVariant(): Promise<{ rootId: number; variantId: number; original: string }> {
    const original = `${FACT_PREFIX}${randomUUID()} root original`;
    const rootId = await createTestFact(original);
    const variantId = await createTestFact(`${FACT_PREFIX}${randomUUID()} variant staging`, { parentId: rootId, isActive: false });
    await insertReview(variantId, "concept_review");
    return { rootId, variantId, original };
  }

  it("a confirmed text edit on a live root returns 200 and stores the new text while its variant has a pending concept_review review", async () => {
    const { rootId, original } = await rootWithReviewingVariant();
    const newText = `${FACT_PREFIX}${randomUUID()} root reworded`;
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: newText, confirmTextEdit: confirmFor(original) });
    assert.equal(res.status, 200);
    const [stored] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, rootId));
    assert.equal(stored?.text, newText);
  });

  it("an unconfirmed edit of that root answers 409 with an impact whose refreshInFlight is false", async () => {
    const { rootId } = await rootWithReviewingVariant();
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: `${FACT_PREFIX}${randomUUID()} root reworded` });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, FACT_TEXT_EDIT_CODES.REQUIRES_CONFIRMATION);
    assert.equal(res.body.impact.refreshInFlight, false, "a variant mid-review is not a refresh in flight on the root");
  });

  it("a confirmed text edit on a root returns 200 and stores the new text while its variant has a nonterminal enrichment job", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} root original`;
    const rootId = await createTestFact(original);
    const variantId = await createTestFact(`${FACT_PREFIX}${randomUUID()} variant live`, { parentId: rootId });
    jobFactIds.push(variantId);
    await db.insert(asyncJobsTable).values({
      queue: "enrichment",
      payload: { factId: variantId },
      dedupeKey: `enrichment:fact:${variantId}`,
      status: "processing",
    } as typeof asyncJobsTable.$inferInsert);
    await insertReview(variantId, "prep_pending");

    const newText = `${FACT_PREFIX}${randomUUID()} root reworded`;
    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: newText, confirmTextEdit: confirmFor(original) });
    assert.equal(res.status, 200);
    const [stored] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, rootId));
    assert.equal(stored?.text, newText);
  });

  it("leaves each variant's lastProcessedSignature and enrichment unchanged, and not stale for reprocess, after a confirmed root edit", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} root original`;
    const rootId = await createTestFact(original);
    const signature = await currentProcessingSignatureFromConfig();
    const variantIds = [
      await createTestFact(`${FACT_PREFIX}${randomUUID()} variant one`, { parentId: rootId }),
      await createTestFact(`${FACT_PREFIX}${randomUUID()} variant two`, { parentId: rootId }),
    ];
    await db.update(factsTable).set({ lastProcessedSignature: signature as unknown as Record<string, unknown> })
      .where(inArray(factsTable.id, variantIds));
    const snapshot = async () => (await db
      .select({ id: factsTable.id, sig: factsTable.lastProcessedSignature, enrichment: factsTable.enrichment })
      .from(factsTable).where(inArray(factsTable.id, variantIds)).orderBy(factsTable.id));
    const before = await snapshot();
    for (const v of before) {
      assert.equal(computeProcessingSignatureStaleness(v.sig, signature).stale, false, "precondition: variants start fresh");
    }

    const res = await request(makeApp())
      .patch(`/admin/facts/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: `${FACT_PREFIX}${randomUUID()} root reworded`, confirmTextEdit: confirmFor(original) });
    assert.equal(res.status, 200);

    const after = await snapshot();
    assert.deepEqual(after, before, "a root edit must not touch any variant's signature or enrichment");
    for (const v of after) {
      assert.equal(computeProcessingSignatureStaleness(v.sig, signature).stale, false, "and no variant becomes stale");
    }
  });
});

// ── Membership: admin grants, effective tier, grace-sweep status ──────────────

describe("admin lifetime grants", () => {
  // adminLabel() falls back to the email when the actor has no display name.
  const adminLabelText = () => `${adminUserId}@test.local`;

  const grant = (userId: string, reason?: string) =>
    request(makeApp())
      .post(`/admin/users/${userId}/grant-lifetime`)
      .set("authorization", `Bearer ${adminSid}`)
      .send(reason === undefined ? {} : { reason });
  const revoke = (userId: string, reason?: string) =>
    request(makeApp())
      .post(`/admin/users/${userId}/revoke-lifetime`)
      .set("authorization", `Bearer ${adminSid}`)
      .send(reason === undefined ? {} : { reason });
  const membership = (userId: string) =>
    request(makeApp()).get(`/admin/users/${userId}/membership`).set("authorization", `Bearer ${adminSid}`);
  const storedTier = async (userId: string) =>
    (await db.select({ tier: usersTable.membershipTier }).from(usersTable).where(eq(usersTable.id, userId)))[0]?.tier;
  const grantRows = (userId: string) =>
    db.select().from(membershipEntitlementsTable).where(and(
      eq(membershipEntitlementsTable.userId, userId),
      eq(membershipEntitlementsTable.sourceType, "admin_grant"),
    ));

  it("grant-lifetime answers success and the target user's tier becomes legendary, in the response and in the database", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const res = await grant(userId, "comped for the UAT run");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user.membershipTier, "legendary");
    assert.equal(await storedTier(userId), "legendary");
  });

  it("after a grant, the membership read returns an admin_grant entry with label and reason, no amount or payment id, and an admin_grant history row", async () => {
    const userId = await createTestUser({ tier: "registered" });
    assert.equal((await grant(userId, "comped for the UAT run")).status, 200);

    const res = await membership(userId);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasActiveAdminGrant, true);
    const entry = res.body.lifetimeEntitlement;
    assert.equal(entry.sourceType, "admin_grant");
    assert.equal(entry.status, "active");
    assert.equal(entry.grantedByAdminLabel, adminLabelText());
    assert.equal(entry.grantReason, "comped for the UAT run");
    assert.equal(entry.amount, null, "a comp is not a payment: no amount");
    assert.equal(entry.stripePaymentIntentId, null, "a comp is not a payment: no payment id");
    assert.ok(
      (res.body.history as Array<{ event: string }>).some((h) => h.event === "admin_grant"),
      "an admin_grant history row must exist",
    );
  });

  it("revoke-lifetime as admin answers 200 with success true, and the user's stored tier then reads registered", async () => {
    const userId = await createTestUser({ tier: "registered" });
    assert.equal((await grant(userId)).status, 200);
    assert.equal(await storedTier(userId), "legendary");

    const res = await revoke(userId, "no longer comped");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(await storedTier(userId), "registered");
  });

  it("after a revoke the membership read still returns the grant, marked revoked with the revoker label, and an admin_revoke history row", async () => {
    const userId = await createTestUser({ tier: "registered" });
    assert.equal((await grant(userId)).status, 200);
    assert.equal((await revoke(userId, "no longer comped")).status, 200);

    const res = await membership(userId);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasActiveAdminGrant, false);
    const entry = res.body.lifetimeEntitlement;
    assert.ok(entry, "the revoked grant must not be deleted");
    assert.equal(entry.sourceType, "admin_grant");
    assert.equal(entry.status, "revoked");
    assert.equal(entry.revokedByAdminLabel, adminLabelText());
    assert.ok(
      (res.body.history as Array<{ event: string }>).some((h) => h.event === "admin_revoke"),
      "an admin_revoke history row must exist",
    );
  });

  it("a second grant after a revoke succeeds and the user is legendary again, with a new active grant row", async () => {
    const userId = await createTestUser({ tier: "registered" });
    assert.equal((await grant(userId)).status, 200);
    assert.equal((await revoke(userId)).status, 200);
    assert.equal(await storedTier(userId), "registered");

    const again = await grant(userId);
    assert.equal(again.status, 200);
    assert.equal(again.body.user.membershipTier, "legendary");
    assert.equal(await storedTier(userId), "legendary");

    const rows = await grantRows(userId);
    assert.equal(rows.length, 2, "the revoked grant is kept and a new row is added");
    assert.deepEqual(rows.map((r) => r.lifecycleStatus).sort(), ["active", "revoked"]);
  });

  it("a second grant returns 400 'User already has an active admin grant', leaving one active row so one revoke drops the user", async () => {
    const userId = await createTestUser({ tier: "registered" });
    assert.equal((await grant(userId)).status, 200);

    const second = await grant(userId);
    assert.equal(second.status, 400);
    assert.equal(second.body.error, "User already has an active admin grant");

    const rows = await grantRows(userId);
    assert.equal(rows.filter((r) => r.lifecycleStatus === "active").length, 1, "exactly one active grant row");

    assert.equal((await revoke(userId)).status, 200);
    assert.equal(await storedTier(userId), "registered", "one revoke must be enough to drop the user");
  });

  it("deactivate then reinstate returns a user with an active admin grant to legendary and a user with none to registered", async () => {
    const granted = await createTestUser({ tier: "registered" });
    assert.equal((await grant(granted)).status, 200);
    const plain = await createTestUser({ tier: "registered" });

    for (const userId of [granted, plain]) {
      const off = await request(makeApp())
        .patch(`/admin/users/${userId}`)
        .set("authorization", `Bearer ${adminSid}`)
        .send({ isActive: false });
      assert.equal(off.status, 200);
    }
    // Stored tiers drift while deactivated (a webhook that landed in the meantime,
    // say): reinstatement must re-derive from sources, not trust what is stored.
    await db.update(usersTable).set({ membershipTier: "registered" }).where(eq(usersTable.id, granted));
    await db.update(usersTable).set({ membershipTier: "legendary" }).where(eq(usersTable.id, plain));

    for (const userId of [granted, plain]) {
      const on = await request(makeApp())
        .patch(`/admin/users/${userId}`)
        .set("authorization", `Bearer ${adminSid}`)
        .send({ isActive: true });
      assert.equal(on.status, 200);
    }
    assert.equal(await storedTier(granted), "legendary", "an active admin grant survives the round trip");
    assert.equal(await storedTier(plain), "registered", "no source, no Legendary");
  });
});

describe("POST /admin/users — membershipTier legendary", () => {
  it("answers 201 and records an active admin_grant row with a reason and an admin_grant history event", async () => {
    const email = `${USER_PREFIX}create-${randomUUID()}@test.local`;
    const res = await request(makeApp())
      .post("/admin/users")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ email, password: "long-enough-pw-1", displayName: "Created Legend", membershipTier: "legendary" });
    assert.equal(res.status, 201);
    const userId = res.body.user.id as string;
    createdUserIds.push(userId);
    assert.equal(res.body.user.membershipTier, "legendary");

    const grants = await db.select().from(membershipEntitlementsTable).where(and(
      eq(membershipEntitlementsTable.userId, userId),
      eq(membershipEntitlementsTable.sourceType, "admin_grant"),
    ));
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.lifecycleStatus, "active");
    assert.ok(grants[0]!.grantReason?.trim(), "the grant must carry a reason");
    const history = await db.select({ event: membershipHistoryTable.event }).from(membershipHistoryTable)
      .where(eq(membershipHistoryTable.userId, userId));
    assert.ok(history.some((h) => h.event === "admin_grant"), "an admin_grant history event must be written");
  });
});

describe("GET /admin/users — effective tier", () => {
  it("reports legendary for a live member and registered for a lapsed one and a free user", async () => {
    const marker = randomUUID().slice(0, 8);
    const mk = async (tier: "registered" | "legendary", validUntil: Date | null) => {
      const id = `${USER_PREFIX}tier-${marker}-${randomUUID().slice(0, 6)}`;
      await db.insert(usersTable).values({
        id,
        email: `${id}@test.local`,
        membershipTier: tier,
        membershipValidUntil: validUntil,
      });
      return id;
    };
    const live = await mk("legendary", new Date(Date.now() + 24 * 60 * 60 * 1000));
    // Stored legendary but past its horizon: authorization already demotes it, so
    // the list must too.
    const lapsed = await mk("legendary", new Date(Date.now() - 60 * 60 * 1000));
    const free = await mk("registered", null);

    const res = await request(makeApp())
      .get("/admin/users")
      .query({ search: `tier-${marker}` })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    const tierOf = (id: string) =>
      (res.body.users as Array<{ id: string; membershipTier: string }>).find((u) => u.id === id)?.membershipTier;
    assert.equal(tierOf(live), "legendary");
    assert.equal(tierOf(lapsed), "registered");
    assert.equal(tierOf(free), "registered");
  });
});

describe("GET /admin/membership/grace-sweep", () => {
  const status = () =>
    request(makeApp()).get("/admin/membership/grace-sweep").set("authorization", `Bearer ${adminSid}`);
  const seedLapsedLegendary = async (): Promise<string> => {
    const id = `${USER_PREFIX}lapsed-${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      membershipTier: "legendary",
      membershipValidUntil: new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  };

  // The sweep's health is in-process state, so these four read it in order:
  // never run first, then drift counted with no sweep, then an overdue sweep,
  // and finally a fresh successful one.
  it("before any sweep has run, reports neverRun true and alerting false", async () => {
    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.body.health.neverRun, true);
    assert.equal(res.body.health.alerting, false);
  });

  it("driftedCount counts a seeded lapsed legendary user", async () => {
    const before = (await status()).body.driftedCount as number;
    const id = await seedLapsedLegendary();
    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.body.driftedCount, before + 1);
    assert.ok(
      (res.body.drifted as Array<{ id: string }>).some((u) => u.id === id),
      "the seeded user must be listed as drifted",
    );
  });

  it("with the alert threshold exceeded, reports alerting true and lists the drifted user", async () => {
    const id = await seedLapsedLegendary();
    // The last successful sweep was 7 hours ago; the default alert threshold is 6.
    await runGraceSweepOnce({ asOf: new Date(Date.now() - 7 * 60 * 60 * 1000) });
    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.body.health.alerting, true);
    assert.ok(
      (res.body.drifted as Array<{ id: string }>).some((u) => u.id === id),
      "the drifted user must be listed alongside the alert",
    );
  });

  it("after a successful sweep, reports neverRun false, neverSucceeded false, alerting false and a lastSuccessAt", async () => {
    await runGraceSweepOnce();
    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.body.health.neverRun, false);
    assert.equal(res.body.health.neverSucceeded, false);
    assert.equal(res.body.health.alerting, false);
    assert.equal(typeof res.body.health.lastSuccessAt, "string");
  });
});

// ── PATCH /admin/config/:key — NCMEC keys ─────────────────────────────────────

describe("PATCH /admin/config/:key — NCMEC key values", () => {
  type SeedRow = { key: string; value: string; dataType: "text" | "integer"; label: string; minValue?: number; maxValue?: number };
  // Mirrors migration 0097's rows. Seeded when absent because the sharded runner
  // clones schema only, never 0097's seed INSERTs.
  const UNRESERVED: Array<SeedRow & { newValue: string }> = [
    { key: "ncmec_safety_alert_email", value: "", dataType: "text", label: "NCMEC Safety Alert Email", newValue: "safety-config@example.test" },
    { key: "async_job_ncmec_submit_max_attempts", value: "8", dataType: "integer", label: "NCMEC Submit — Max Attempts", minValue: 1, maxValue: 20, newValue: "9" },
    { key: "async_job_ncmec_submit_retry_delay_4_ms", value: "86400000", dataType: "integer", label: "NCMEC Submit — 4th Retry Delay (ms)", minValue: 60000, maxValue: 604800000, newValue: "90000000" },
  ];
  const RESERVED_LITERAL_REFUSAL =
    "This key controls NCMEC CyberTipline filing and cannot be written through the generic config route. Use the safety admin surface, which validates the resulting configuration before applying it.";

  const rowOf = async (key: string) =>
    (await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, key)))[0];

  it("writes and stores the new value of each of the three unreserved NCMEC keys", async () => {
    for (const seed of UNRESERVED) {
      const existing = await rowOf(seed.key);
      if (!existing) {
        await db.insert(adminConfigTable).values({
          key: seed.key,
          value: seed.value,
          dataType: seed.dataType,
          label: seed.label,
          minValue: seed.minValue ?? null,
          maxValue: seed.maxValue ?? null,
          isPublic: false,
        }).onConflictDoNothing();
      }
      try {
        const res = await request(makeApp())
          .patch(`/admin/config/${seed.key}`)
          .set("authorization", `Bearer ${adminSid}`)
          .send({ value: seed.newValue });
        assert.equal(res.status, 200, `${seed.key} was refused: ${JSON.stringify(res.body)}`);
        assert.equal((await rowOf(seed.key))?.value, seed.newValue, `${seed.key}: a 200 must mean the value is stored`);
      } finally {
        if (existing) {
          await db.update(adminConfigTable).set({ value: existing.value }).where(eq(adminConfigTable.key, seed.key));
        } else {
          await db.delete(adminConfigTable).where(eq(adminConfigTable.key, seed.key));
        }
      }
    }
  });

  it("refuses each reserved key with the literal refusal copy and leaves its stored row unchanged", async () => {
    for (const key of NCMEC_RESERVED_CONFIG_KEYS) {
      const existing = await rowOf(key);
      let seeded = false;
      if (!existing) {
        await db.insert(adminConfigTable).values({
          key, value: "false", dataType: "text", label: key, isPublic: false,
        }).onConflictDoNothing();
        seeded = true;
      }
      try {
        const before = await rowOf(key);
        const res = await request(makeApp())
          .patch(`/admin/config/${key}`)
          .set("authorization", `Bearer ${adminSid}`)
          .send({ value: "attempted-write" });
        assert.equal(res.status, 403, `${key} was not refused`);
        // Spelled out here on purpose: asserting against the exported constant
        // would pass if the copy were reworded, and this copy is what the admin reads.
        assert.equal(res.body.error, RESERVED_LITERAL_REFUSAL);
        assert.deepEqual(await rowOf(key), before, `${key}: a refused save must leave the stored row untouched`);
      } finally {
        if (seeded) await db.delete(adminConfigTable).where(eq(adminConfigTable.key, key));
      }
    }
  });
});
