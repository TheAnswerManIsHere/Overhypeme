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
  factGagsTable,
  adminActionsTable,
} from "@workspace/db/schema";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { like, eq, inArray, or, and } from "drizzle-orm";

import {
  NCMEC_RESERVED_CONFIG_KEYS,
  NCMEC_RESERVED_KEY_REFUSAL,
} from "../lib/moderation/ncmecConfig.js";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData, BOOTSTRAP_ADMIN_EMAIL } from "../lib/auth.js";
import {
  FACT_TEXT_EDIT_CODES,
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
  computeProcessingSignatureStaleness,
} from "@workspace/api-zod";
import { currentProcessingSignatureFromConfig } from "../lib/processingSignature.js";
import { runGraceSweepOnce } from "../lib/membershipSchedules.js";


const USER_PREFIX = "troutesadmin-";
const FACT_PREFIX = "t-routes-admin-fact-";

function makeApp(): Express {
  const app = express();
  // Mirror the real server's body limit (app.ts: express.json({ limit: "2mb" })).
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
  // Triage reviews created by the import endpoints reference the test
  // admin via submitted_by_id (no ON DELETE cascade), so they must be removed
  // before the users they point at.
  await db.delete(pendingReviewsTable).where(like(pendingReviewsTable.submittedById, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%`));
}

async function createTestFact(
  text: string,
  opts: { isActive?: boolean } = {},
): Promise<number> {
  const active = opts.isActive ?? true;
  if (active) {
    const fact = await insertLiveFact({ text, enrichment: buildPlaceholderFactEnrichment() }, buildPlaceholderGag());
    return fact.id;
  }
  const [fact] = await db.insert(factsTable).values({ text, isActive: false }).returning({ id: factsTable.id });
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
  const [row] = await db.select({ isActive: factsTable.isActive })
    .from(factsTable).where(eq(factsTable.id, id));
  assert.equal(row.isActive, false, "precondition: the fact must be deactivated");
  const [gag] = await db.select({ approvedContent: factGagsTable.approvedContent })
    .from(factGagsTable).where(and(eq(factGagsTable.factId, id), eq(factGagsTable.slot, 1)));
  assert.ok(
    (gag?.approvedContent as { coreSceneOverride?: string } | null)?.coreSceneOverride?.trim(),
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

  it("the inactive view lists inactive facts as their own rows, and leaves active ones out", async () => {
    const suffix = randomUUID();
    const activeId = await createTestFact(`${FACT_PREFIX}inactive-view-active-${suffix}`, { isActive: true });
    const inactiveId = await createTestFact(`${FACT_PREFIX}inactive-view-inactive-${suffix}`, { isActive: false });

    const res = await request(makeApp())
      .get("/admin/facts")
      .query({ visibility: "inactive", search: suffix, limit: "100" })
      .set("authorization", `Bearer ${adminSid}`);

    assert.equal(res.status, 200);
    const ids = (res.body.facts as Array<{ id: number }>).map((f) => f.id);
    assert.deepEqual(ids, [inactiveId]);
    assert.ok(!ids.includes(activeId));
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

  it("refuses a change to a fact's wording, confirmed or not, and writes nothing (plan PLAN_THREE_GAGS.md, increment 3)", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} original text`;
    const factId = await createTestFact(original);
    for (const body of [
      { text: "{Subj} keeps it locked in {POSS} back yard." },
      { text: "{Subj} keeps it locked in {POSS} back yard.", confirmTextEdit: { phrase: "anything", reason: "a long enough reason here", expectedOldTextHash: "x" } },
      { text: "bad token {FOO}" },
    ]) {
      const res = await request(makeApp()).patch(`/admin/facts/${factId}`).set("authorization", `Bearer ${adminSid}`).send(body);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, "WORDING_LOCKED");
    }
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(row?.text, original);
    await assert.rejects(db.update(factsTable).set({ text: "edited around the route" }).where(eq(factsTable.id, factId)), "the database refuses it too");
  });

  it("accepts a PATCH that carries the stored wording unchanged, applying its other fields", async () => {
    const original = `${FACT_PREFIX}${randomUUID()} unchanged text`;
    const factId = await createTestFact(original);
    const res = await request(makeApp()).patch(`/admin/facts/${factId}`).set("authorization", `Bearer ${adminSid}`).send({ text: original, shareCount: 7 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(row?.text, original);
    assert.equal(row?.shareCount, 7);
  });

  it("deactivating a fact via this PATCH touches only that fact", async () => {
    const targetId = await createTestFact(`${FACT_PREFIX}${randomUUID()} deactivate target`);
    const otherId = await createTestFact(`${FACT_PREFIX}${randomUUID()} deactivate bystander`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: false });
    assert.equal(res.status, 200);

    const rows = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [targetId, otherId]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    assert.equal(byId.get(targetId), false);
    assert.equal(byId.get(otherId), true, "another fact is untouched");
  });

  it("ignores a parentId in the body: no fact can be linked to another", async () => {
    const targetId = await createTestFact(`${FACT_PREFIX}${randomUUID()} link target`);
    const otherId = await createTestFact(`${FACT_PREFIX}${randomUUID()} link other`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ parentId: otherId, useCase: "x" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal("parentId" in res.body.fact, false);
    assert.equal("useCase" in res.body.fact, false);
  });

  // ── Activation is moderation-only ──────────────────────────────────────────
  //
  // A content-safety invariant, not a tidiness one. The admin Active toggle may
  // DEACTIVATE a fact (covered above), but a false→true flip here would bypass
  // the entire production gate approveForProduction/activateFact enforce — the
  // approved-gag check, the pending_reviews transition, production-approval recording and submitter notification. A
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
    // Re-moderation was removed with resubmission (increment 1.2a): the refusal
    // must not point an admin at it. It also fires for a fact still in
    // moderation, so it names the one way a fact goes live.
    assert.doesNotMatch(res.body.error, /re-?moderat/i);
    assert.match(res.body.error, /Approve for production/);

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

  // A PATCH carrying `text` unchanged takes the same path. The activation guard sits ahead of that fork, and this is what holds it
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

// ── The admin variant routes are gone with variants ───────────────────────────

describe("admin variant routes — retired", () => {
  it("POST /admin/facts/:id/variants and DELETE /admin/facts/variants/:id no longer exist", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} a fact`);
    const add = await request(makeApp())
      .post(`/admin/facts/${rootId}/variants`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: "{Subj} keeps it locked in {POSS} back yard." });
    assert.equal(add.status, 404);
    const del = await request(makeApp())
      .delete(`/admin/facts/variants/${rootId}`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.ok(del.status === 404 || del.status === 400, `got ${del.status}`);
    const [still] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, rootId));
    assert.equal(still?.isActive, true, "nothing was deactivated");
  });
});

// ── The import routes are gone (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 1) ──

describe("admin import routes — removed", () => {
  for (const [path, body] of [["/admin/facts/import", { facts: ["{NAME} gone."] }], ["/admin/facts/import-csv", { csv: "{NAME} gone." }]] as const) {
    it(`POST ${path} is gone`, async () => {
      const res = await request(makeApp()).post(path).set("authorization", `Bearer ${adminSid}`).send(body);
      assert.equal(res.status, 404);
    });
  }
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

  it("soft-delete touches only that fact", async () => {
    const targetId = await createTestFact(`${FACT_PREFIX}${randomUUID()} soft-delete target`);
    const otherId = await createTestFact(`${FACT_PREFIX}${randomUUID()} soft-delete bystander`);
    const res = await request(makeApp())
      .delete(`/admin/facts/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, false);

    const rows = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(inArray(factsTable.id, [targetId, otherId]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    assert.equal(byId.get(targetId), false);
    assert.equal(byId.get(otherId), true, "another fact is untouched");
  });

  it("there is no hard delete: ?hard=true deactivates, and the fact row stays (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1F)", async () => {
    const targetId = await createTestFact(`${FACT_PREFIX}${randomUUID()} hard-delete target`);
    const res = await request(makeApp())
      .delete(`/admin/facts/${targetId}?hard=true`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, false);

    const [kept] = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, targetId));
    assert.ok(kept, "the fact row, and with it every member's memes, pictures and comments, is kept");
    assert.equal(kept.isActive, false);

    // The deactivation is on the fact's admin-action record (plan 1I, 3C).
    const actions = await db.select({ action: adminActionsTable.action, actorId: adminActionsTable.actorId })
      .from(adminActionsTable).where(eq(adminActionsTable.factId, targetId));
    assert.deepEqual(actions, [{ action: "deactivate", actorId: adminUserId }]);
  });

  it("an edit that turns Active off records a deactivation; one that changes a field records an edit", async () => {
    const targetId = await createTestFact(`${FACT_PREFIX}${randomUUID()} patch target`);
    const res = await request(makeApp())
      .patch(`/admin/facts/${targetId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: false, upvotes: 7 });
    assert.equal(res.status, 200);
    const actions = await db.select({ action: adminActionsTable.action, detail: adminActionsTable.detail })
      .from(adminActionsTable).where(eq(adminActionsTable.factId, targetId)).orderBy(adminActionsTable.id);
    assert.deepEqual(actions, [
      { action: "deactivate", detail: {} },
      { action: "fact_edit", detail: { changed: { upvotes: 7 } } },
    ]);
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

// ── PATCH /admin/facts/:id — the approved-fact-text lock over HTTP ────────────

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

  it("the retired soft delete and set-inactive edit change nothing (launch Phase 5, Increment 7a)", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const patch = await request(makeApp())
      .patch(`/admin/users/${userId}`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ isActive: false });
    assert.equal(patch.status, 400, "isActive alone is no longer an edit");
    const del = await request(makeApp())
      .delete(`/admin/users/${userId}`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(del.status, 400, "a soft delete is refused");
    const [row] = await db.select({ isActive: usersTable.isActive }).from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row!.isActive, true, "the account is untouched");
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
