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
import { usersTable, factsTable, factTextEditHistoryTable } from "@workspace/db/schema";
import { like, eq } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { hashFactText } from "../lib/enrichmentVersioning.js";
import { APPROVED_FACT_TEXT_EDIT_PHRASE } from "@workspace/api-zod";


const USER_PREFIX = "troutesadmin-";
const FACT_PREFIX = "t-routes-admin-fact-";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
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

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%`));
}

async function createTestFact(
  text: string,
  opts: { parentId?: number; isActive?: boolean } = {},
): Promise<number> {
  const [fact] = await db.insert(factsTable).values({
    text,
    parentId: opts.parentId,
    isActive: opts.isActive ?? true,
  }).returning({ id: factsTable.id });
  return fact!.id;
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

  it("normalizes text and computes derived metadata for the variant row", async () => {
    const rootId = await createTestFact(`${FACT_PREFIX}${randomUUID()} root fact`);
    const res = await request(makeApp())
      .post(`/admin/facts/${rootId}/variants`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ text: "{Subj} keeps it locked in {POSS} back yard." });
    assert.equal(res.status, 201);
    assert.equal(res.body.variant.text, "{Subj} {keeps|keep} it locked in {POSS} back yard.");
    assert.equal(res.body.variant.hasPronouns, true);
    assert.ok(res.body.variant.canonicalText);
    assert.equal(typeof res.body.variant.splitTokenIndex, "number");
  });

  it("returns 422 for a grammar-invalid variant and does not write it (not a bulk path)", async () => {
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

  it("writes valid rows with derived metadata and reports invalid rows in `failed` (partial success)", async () => {
    const suffix = randomUUID();
    const rawText = `${FACT_PREFIX}${suffix} {Subj} keeps it locked in {POSS} back yard.`;
    const expectedText = `${FACT_PREFIX}${suffix} {Subj} {keeps|keep} it locked in {POSS} back yard.`;
    const res = await request(makeApp())
      .post("/admin/facts/import")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ facts: [rawText, "bad token {FOO}"] });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.facts.length, 1);
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].error, /grammar validation failed/);

    const inserted = res.body.facts[0] as Record<string, unknown>;
    assert.equal(inserted.text, expectedText);
    assert.ok(inserted.canonicalText);
    assert.equal(typeof inserted.splitTokenIndex, "number");

    const rows = await db.select().from(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%bad token%`));
    assert.equal(rows.length, 0, "invalid row must not be written");
  });
});

// ── POST /admin/facts/import-csv ──────────────────────────────────────────────

describe("POST /admin/facts/import-csv", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).post("/admin/facts/import-csv").send({ csv: "hi there" });
    assert.equal(res.status, 401);
  });

  it("writes valid lines with derived metadata and reports invalid lines in `failed` (partial success)", async () => {
    const rawText = `${FACT_PREFIX}${randomUUID()} {Subj} keeps it locked in {POSS} back yard.`;
    const expectedText = rawText.replace("{Subj} keeps", "{Subj} {keeps|keep}");
    const csv = `${rawText}\nbad token {FOO} here\n`;
    const res = await request(makeApp())
      .post("/admin/facts/import-csv")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ csv });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].error, /grammar validation failed/);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.text, expectedText));
    assert.ok(row, "valid line should have been inserted");
    assert.equal(row.text, expectedText);
    assert.ok(row.canonicalText);

    const invalidRows = await db.select().from(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%bad token%`));
    assert.equal(invalidRows.length, 0, "invalid line must not be written");
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
