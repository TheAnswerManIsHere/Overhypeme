/**
 * Launch Phase 4, removal 5 — the gradient template backgrounds are gone
 * (#744; plan docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David
 * 2026-10-22).
 *
 * Pins three things:
 *   1. The template list and preview routes answer 404 through the whole app.
 *   2. A `template` image source is refused by save and by both render routes.
 *   3. Migration 0106 applies the plan's row-state matrix to memes, captures
 *      the gradient picker setting before deleting it, and a re-run is a no-op.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  memesTable,
  adminConfigTable,
  featurePermissionsMigrationLogTable,
} from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0106_retire_gradient_templates.sql"),
  "utf8",
);
const MIGRATION_NAME = "0106_retire_gradient_templates";

const PREFIX = "t_p4r5_";
const GRADIENT_KEY = "bg_display_limit_gradient";
let userId: string;
let sid: string;
let factId: number;

async function cleanup() {
  await db.delete(featurePermissionsMigrationLogTable).where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  await db.delete(adminConfigTable).where(eq(adminConfigTable.key, GRADIENT_KEY));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  userId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: userId, email: `${userId}@test.local`, captchaVerified: true });
  const data: SessionData = {
    user: { id: userId, membershipTier: "registered" } as unknown as SessionData["user"],
    access_token: "test-token",
    captchaVerified: true,
  };
  sid = await createSession(data, userId);
  const [fact] = await db
    .insert(factsTable)
    .values({ text: `${PREFIX}fact`, canonicalText: `${PREFIX}fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  factId = fact.id;
});

after(cleanup);

describe("template routes are gone", () => {
  for (const url of ["/api/memes/templates", "/api/memes/templates/action/preview?aspectRatio=square"]) {
    it(`GET ${url} answers 404`, async () => {
      const res = await request(createApp()).get(url);
      assert.equal(res.status, 404);
    });
  }
});

describe("a template image source is refused", () => {
  const template = { type: "template", templateId: "action" };

  it("POST /api/memes answers 400 and writes no meme", async () => {
    const res = await request(createApp())
      .post("/api/memes")
      .set("Authorization", `Bearer ${sid}`)
      .send({ factId, imageSource: template });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid input");
    const rows = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.createdById, userId));
    assert.equal(rows.length, 0);
  });

  for (const route of ["/api/render-preview", "/api/render-download"]) {
    it(`POST ${route} answers 400 invalid_input`, async () => {
      const res = await request(createApp())
        .post(route)
        .send({ factId, imageSource: template, name: "Alex", pronouns: "they/them" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "invalid_input");
    });
  }
});

describe("migration 0106 retires template recipes and the gradient setting", () => {
  const slugs = {
    liveRecipe: `${PREFIX}live`,
    deletedRecipe: `${PREFIX}gone`,
    storedGradient: `${PREFIX}stored`,
    uploadRecipe: `${PREFIX}upload`,
  };
  const earlier = new Date("2026-04-04T00:00:00Z");

  async function seedPreMigrationState() {
    const base = { factId, createdById: userId, aspectRatio: "landscape" };
    await db.insert(memesTable).values([
      { ...base, templateId: "fire", permalinkSlug: slugs.liveRecipe, imageUrl: "/x", imageSource: { type: "template", templateId: "fire" } },
      { ...base, templateId: "night", permalinkSlug: slugs.deletedRecipe, imageUrl: "/x", imageSource: { type: "template", templateId: "night" }, deletedAt: earlier },
      { ...base, templateId: "action", permalinkSlug: slugs.storedGradient, imageUrl: "/x", imageSource: null },
      { ...base, templateId: "photo_upload", permalinkSlug: slugs.uploadRecipe, imageUrl: "/x", imageSource: { type: "upload", uploadKey: "/objects/uploads/t_p4r5.jpg" } },
    ]);
    await db.insert(adminConfigTable).values({
      key: GRADIENT_KEY, value: "37", dataType: "integer", label: "Background Picker: Gradient Limit", isPublic: true,
    }).onConflictDoNothing();
  }

  async function deletedAtBySlug(): Promise<Record<string, Date | null>> {
    const rows = await db
      .select({ slug: memesTable.permalinkSlug, deletedAt: memesTable.deletedAt })
      .from(memesTable)
      .where(inArray(memesTable.permalinkSlug, Object.values(slugs)));
    return Object.fromEntries(rows.map((r) => [r.slug, r.deletedAt]));
  }

  async function logRows() {
    return db
      .select({ deletedRows: featurePermissionsMigrationLogTable.deletedRows })
      .from(featurePermissionsMigrationLogTable)
      .where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
  }

  it("soft-deletes only the live template recipe, keeps the rest, and captures before deleting", async () => {
    await seedPreMigrationState();
    const [liveRow] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, slugs.liveRecipe));

    await db.execute(sql.raw(MIGRATION_SQL));

    const after = await deletedAtBySlug();
    assert.ok(after[slugs.liveRecipe], "the live template recipe is soft-deleted");
    assert.equal(after[slugs.deletedRecipe]?.toISOString(), earlier.toISOString(), "an already soft-deleted recipe keeps its timestamp");
    assert.equal(after[slugs.storedGradient], null, "a gradient-labelled stored image is untouched");
    assert.equal(after[slugs.uploadRecipe], null, "an upload recipe is untouched");

    const config = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, GRADIENT_KEY));
    assert.equal(config.length, 0, "the gradient setting is deleted");

    const logs = await logRows();
    assert.equal(logs.length, 1, "one capture row");
    const captured = logs[0].deletedRows as { admin_config: Array<{ key: string; value: string }>; soft_deleted_meme_ids: number[] };
    assert.deepEqual(captured.admin_config.map((r) => [r.key, r.value]), [[GRADIENT_KEY, "37"]]);
    assert.ok(captured.soft_deleted_meme_ids.includes(liveRow.id), "the soft-deleted meme's id is captured");
  });

  it("is a no-op on a second run", async () => {
    const before = await deletedAtBySlug();
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await deletedAtBySlug(), before);
    assert.equal((await logRows()).length, 1, "a re-run writes no second capture row");
  });
});
