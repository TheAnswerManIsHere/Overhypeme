/**
 * Phase-4 /api/memes save-path integration tests.
 *
 * Covers:
 *   - Idempotency window (same inputs within 60s collapse to one meme)
 *   - Daily save cap (rolling 24 h)
 *   - Soft-deleted memes don't count against the cap
 *   - Slug uniqueness + retry
 *   - PuLID tier gate
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable } from "@workspace/db/schema";
import { eq, like, and, inArray } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import { deriveUserRole } from "../lib/userRole.js";

const USER_PREFIX = "t_phase4_save_";
const FACT_TEXT_PREFIX = "t_p4s_fact_";

interface TestUserOpts {
  membershipTier?: "unregistered" | "registered" | "legendary";
  isAdmin?: boolean;
}

async function createTestUser(opts: TestUserOpts = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.membershipTier ?? "registered",
    isAdmin: opts.isAdmin ?? false,
    displayName: "TestUser",
    pronouns: "they/them",
  });
  return id;
}

function makeAuthedApp(userId: string): Express {
  const app = express();
  app.use(express.json());
  app.use(async (req: Request, _res: Response, next: NextFunction) => {
    const [u] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (u) {
      // Mirror authMiddleware's shape closely enough to satisfy the route.
      req.user = {
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        displayName: u.displayName,
        pronouns: u.pronouns,
        profileImageUrl: u.profileImageUrl,
        membershipTier: u.membershipTier,
        isAdmin: !!u.isAdmin,
        isRealAdmin: !!u.isAdmin,
        captchaVerified: !!u.captchaVerified,
        nsfwModeEnabled: !!u.nsfwModeEnabled,
        // Derived exactly as authMiddleware derives it, rather than pinned to
        // "registered". A hardcoded role made the admin-vs-tier distinction
        // invisible to these tests — which is the distinction the private-
        // visibility gate turns on.
        userRole: deriveUserRole(u.membershipTier, !!u.isAdmin),
        realUserRole: deriveUserRole(u.membershipTier, !!u.isAdmin),
      } as Express.User;
    }
    req.isAuthenticated = function (this: Request) { return this.user != null; } as Request["isAuthenticated"];
    next();
  });
  app.use(memesRouter);
  return app;
}

function makeAnonApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.isAuthenticated = function (this: Request) { return this.user != null; } as Request["isAuthenticated"];
    next();
  });
  app.use(memesRouter);
  return app;
}

const insertedFactIds: number[] = [];

async function insertFact(text: string, opts: { submittedById?: string } = {}): Promise<number> {
  const prefixedText = `${FACT_TEXT_PREFIX}${text}`;
  const [row] = await db
    .insert(factsTable)
    .values({ text: prefixedText, submittedById: opts.submittedById, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: prefixedText })
    .returning();
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(memesTable).where(eq(memesTable.createdById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  // Prefix-based cleanup catches both in-flight facts and orphans from a crashed run.
  const orphanFactIds = (await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`)))
    .map((r) => r.id);
  if (orphanFactIds.length > 0) {
    await db.delete(memesTable).where(inArray(memesTable.factId, orphanFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, orphanFactIds));
  }
  insertedFactIds.length = 0;
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /api/memes — auth gate", () => {
  it("returns 401 for an anonymous caller", async () => {
    const factId = await insertFact("a fact");
    const res = await request(makeAnonApp())
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
      });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/memes — slug shape", () => {
  it("returns a 10-char nanoid slug", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("a fact", { submittedById: userId });

    const res = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
      })
      .expect(201);

    assert.match(res.body.permalinkSlug, /^[A-Za-z0-9]{10}$/);
    assert.equal(res.body.permalinkSlug, res.body.slug);
    assert.equal(res.body.permalinkUrl, `/m/${res.body.permalinkSlug}`);
  });
});

describe("POST /api/memes — idempotency", () => {
  it("returns the same meme when called twice with identical inputs in <60s", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("idempotent", { submittedById: userId });

    const body = {
      factId,
      imageSource: { type: "template", templateId: "fire" },
    };

    const a = await request(makeAuthedApp(userId)).post("/memes").send(body).expect(201);
    const b = await request(makeAuthedApp(userId)).post("/memes").send(body).expect(200);

    assert.equal(b.body.id, a.body.id, "second POST must return the first meme's id");
    assert.equal(b.body.permalinkSlug, a.body.permalinkSlug);
    assert.equal(b.body.idempotent, true);

    // Only one row should be in memes for that user.
    const rows = await db.select().from(memesTable).where(eq(memesTable.createdById, userId));
    assert.equal(rows.length, 1);
  });

  it("creates a distinct meme when framingTransform differs", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("distinct framing", { submittedById: userId });

    const a = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "fire" },
        framingTransform: { offsetX: 0, offsetY: 0 },
      })
      .expect(201);

    const b = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "fire" },
        framingTransform: { offsetX: 10, offsetY: 0 },
      })
      .expect(201);

    assert.notEqual(a.body.id, b.body.id);
  });
});

describe("POST /api/memes — daily save cap", () => {
  it("blocks the 31st save in a 24h window for a free-tier user", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const factId = await insertFact("cap fact", { submittedById: userId });

    // Insert 30 memes directly to simulate the user's recent history,
    // since slamming 30 POSTs through the canvas is slow.
    const now = new Date();
    const memesToInsert = Array.from({ length: 30 }, (_, i) => ({
      factId,
      templateId: "action",
      imageUrl: `/meme-${i}.jpg`,
      permalinkSlug: `cap${i.toString().padStart(7, "0")}`,
      createdById: userId,
      createdAt: new Date(now.getTime() - i * 60_000),
      aspectRatio: "landscape",
    }));
    await db.insert(memesTable).values(memesToInsert);

    const res = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
      });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "daily_cap_reached");
  });

  it("excludes soft-deleted memes from the cap count", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const factId = await insertFact("soft del cap", { submittedById: userId });

    // 30 memes — but all soft-deleted, so the cap query sees zero.
    const now = new Date();
    const memesToInsert = Array.from({ length: 30 }, (_, i) => ({
      factId,
      templateId: "action",
      imageUrl: `/meme-${i}.jpg`,
      permalinkSlug: `del${i.toString().padStart(7, "0")}`,
      createdById: userId,
      createdAt: new Date(now.getTime() - i * 60_000),
      deletedAt: new Date(),
      aspectRatio: "landscape",
    }));
    await db.insert(memesTable).values(memesToInsert);

    const res = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
      });
    assert.equal(res.status, 201);
  });
});

describe("POST /api/memes — pulid tier gate", () => {
  it("rejects pulid imageTransform from a non-legendary user with 403", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const factId = await insertFact("legendary fact", { submittedById: userId });

    const res = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "upload", uploadKey: "/objects/uploads/foo/bar.jpg" },
        imageTransform: "pulid",
      });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "tier_mismatch");
  });
});

/**
 * Private visibility is a legendary-LEVEL entitlement, resolved from the
 * caller's role — not from `membership_tier` alone. The regression: the gate
 * read `hasFeature(membershipTier, "meme_private_visibility")`, and an admin's
 * stored tier is `registered` unless they also hold a paid entitlement, so an
 * admin's explicit `isPublic: false` was silently coerced to `true`. The save
 * returned 201 and the meme was world-readable at its permalink.
 *
 * The general invariant under test, not just the reported instance: a save
 * that asks for private either stores private or fails — it never returns
 * success having published the meme.
 */
describe("POST /api/memes — private visibility gate", () => {
  async function saveWith(userId: string, isPublic: boolean | undefined) {
    const factId = await insertFact("visibility", { submittedById: userId });
    const body: Record<string, unknown> = {
      factId,
      imageSource: { type: "template", templateId: "action" },
    };
    if (isPublic !== undefined) body["isPublic"] = isPublic;
    return request(makeAuthedApp(userId)).post("/memes").send(body);
  }

  async function storedIsPublic(memeId: number): Promise<boolean> {
    const [row] = await db
      .select({ isPublic: memesTable.isPublic })
      .from(memesTable)
      .where(eq(memesTable.id, memeId))
      .limit(1);
    return row.isPublic;
  }

  it("stores isPublic=false for an admin whose membership tier is only registered", async () => {
    const userId = await createTestUser({ membershipTier: "registered", isAdmin: true });
    const res = await saveWith(userId, false);
    assert.equal(res.status, 201);
    assert.equal(await storedIsPublic(res.body.id), false);
  });

  it("stores isPublic=false for a legendary user", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const res = await saveWith(userId, false);
    assert.equal(res.status, 201);
    assert.equal(await storedIsPublic(res.body.id), false);
  });

  it("rejects an explicit private request from a registered non-admin instead of publishing it", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const res = await saveWith(userId, false);
    assert.equal(res.status, 403);
    // The failure must be visible to the caller, not a 201 hiding a public meme.
    assert.equal(res.body.id, undefined);
  });

  it("still defaults to public when isPublic is omitted, at every tier", async () => {
    for (const opts of [
      { membershipTier: "registered" as const },
      { membershipTier: "legendary" as const },
      { membershipTier: "registered" as const, isAdmin: true },
    ]) {
      const userId = await createTestUser(opts);
      const res = await saveWith(userId, undefined);
      assert.equal(res.status, 201);
      assert.equal(await storedIsPublic(res.body.id), true);
    }
  });

  it("stores isPublic=true when a legendary user explicitly asks for public", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const res = await saveWith(userId, true);
    assert.equal(res.status, 201);
    assert.equal(await storedIsPublic(res.body.id), true);
  });
});

describe("POST /api/memes — soft-deleted slugs are not reissued", () => {
  it("a soft-deleted meme's slug remains unique (UNIQUE constraint blocks reuse)", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("slug uniqueness", { submittedById: userId });

    const a = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({ factId, imageSource: { type: "template", templateId: "action" } })
      .expect(201);
    const slugA = a.body.permalinkSlug;

    // Soft-delete it.
    await db.update(memesTable).set({ deletedAt: new Date() }).where(eq(memesTable.id, a.body.id));

    // Force the second meme to attempt the same slug — verify the constraint
    // holds. We can't directly cause nanoid to collide; instead we assert no
    // existing live row owns the same slug after a fresh insert.
    const b = await request(makeAuthedApp(userId))
      .post("/memes")
      .send({
        factId,
        imageSource: { type: "template", templateId: "fire" },
        framingTransform: { offsetX: 5, offsetY: 5 }, // different inputs to avoid idem hit
      })
      .expect(201);
    assert.notEqual(b.body.permalinkSlug, slugA);

    // Both rows present, both with distinct slugs.
    const rows = await db
      .select()
      .from(memesTable)
      .where(and(eq(memesTable.createdById, userId)));
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].permalinkSlug, rows[1].permalinkSlug);
  });
});
