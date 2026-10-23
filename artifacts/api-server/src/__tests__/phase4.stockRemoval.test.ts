/**
 * Launch Phase 4, removal 6 — stock photos, Pexels and the per-user image
 * preferences are gone (#744; plan docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md,
 * approved by David 2026-10-22).
 *
 * Pins four things:
 *   1. Every deleted route answers 404 through the whole app, even to an admin.
 *   2. A `stock` image source is refused by save and by both render routes, and
 *      an anonymous render is refused outright (no anonymous source remains).
 *   3. Staging prep enqueues enrichment only: no fact_pexels job, and the
 *      scheduler no longer has a pexels lane.
 *   4. Migration 0107 applies the plan's row-state matrix to memes, retires the
 *      fact_pexels jobs, captures the two settings before deleting them, drops
 *      the four columns, and a re-run is a no-op.
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
  asyncJobsTable,
  workerLaneHeartbeatsTable,
  featurePermissionsMigrationLogTable,
} from "@workspace/db/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { ALL_LANES } from "../lib/asyncJobs.js";
import { ensureFirstTimeStagingPrepJobs } from "../lib/firstTimeStagingPrep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0107_retire_stock_pexels.sql"),
  "utf8",
);
const MIGRATION_NAME = "0107_retire_stock_pexels";

const PREFIX = "t_p4r6_";
const CONFIG_KEYS = ["pexels_photos_per_gender", "bg_display_limit_stock"];
let adminId: string;
let adminSid: string;
let factId: number;

async function cleanup() {
  await db.delete(featurePermissionsMigrationLogTable).where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${PREFIX}%`));
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.dedupeKey, `${PREFIX}%`));
  await db.delete(workerLaneHeartbeatsTable).where(like(workerLaneHeartbeatsTable.instanceId, `${PREFIX}%`));
  const facts = await db.select({ id: factsTable.id }).from(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  if (facts.length > 0) {
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, facts.map((f) => `enrichment:fact:${f.id}`)));
  }
  await db.delete(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, CONFIG_KEYS));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", captchaVerified: true });
  const data: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  adminSid = await createSession(data, adminId);
  const [fact] = await db
    .insert(factsTable)
    .values({ text: `${PREFIX}fact`, canonicalText: `${PREFIX}fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  factId = fact.id;
});

after(cleanup);

describe("stock, Pexels and image-preference routes are gone", () => {
  const gone: Array<[method: "get" | "post" | "put", url: string]> = [
    ["get", "/api/memes/stock-photo?gender=person"],
    ["get", "/api/facts/1/pexels-images?gender=neutral"],
    ["get", "/api/facts/1/image-preference"],
    ["put", "/api/facts/1/image-preference"],
    ["get", "/api/facts/1/ai-meme-preference"],
    ["put", "/api/facts/1/ai-meme-preference"],
    ["get", "/api/admin/facts/1/pexels-images"],
    ["get", "/api/admin/reviews/1/pexels-images"],
    ["post", "/api/admin/facts/1/refresh-images"],
    ["post", "/api/admin/facts/backfill-images"],
    ["post", "/api/admin/backfill-pexels"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url).set("Authorization", `Bearer ${adminSid}`).send({});
      assert.equal(res.status, 404);
    });
  }
});

describe("a stock image source is refused, and so is any anonymous render", () => {
  const stock = { type: "stock", pexelsPhotoId: 42, photoUrl: "https://images.pexels.com/photos/42/x.jpeg" };

  it("POST /api/memes answers 400 and writes no meme", async () => {
    const res = await request(createApp())
      .post("/api/memes")
      .set("Authorization", `Bearer ${adminSid}`)
      .send({ factId, imageSource: stock });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid input");
    const rows = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.createdById, adminId));
    assert.equal(rows.length, 0);
  });

  for (const route of ["/api/render-preview", "/api/render-download"]) {
    it(`POST ${route} answers 400 invalid_input for a stock source`, async () => {
      const res = await request(createApp()).post(route).send({ factId, imageSource: stock, name: "Alex", pronouns: "they/them" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "invalid_input");
    });

    it(`POST ${route} answers 403 mode_requires_auth to an anonymous upload`, async () => {
      const res = await request(createApp())
        .post(route)
        .send({ factId, imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" }, name: "Alex", pronouns: "they/them" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, "mode_requires_auth");
    });
  }
});

describe("staging prep is enrichment only", () => {
  it("enqueues an enrichment job and no fact_pexels job; the scheduler has no pexels lane", async () => {
    const [staging] = await db
      .insert(factsTable)
      .values({ text: `${PREFIX}staging`, canonicalText: `${PREFIX}staging`, isActive: false })
      .returning({ id: factsTable.id });
    const dispatch = await ensureFirstTimeStagingPrepJobs(staging.id);
    assert.deepEqual(Object.keys(dispatch).sort(), ["enrichment", "factId"]);
    const jobs = await db
      .select({ queue: asyncJobsTable.queue })
      .from(asyncJobsTable)
      .where(sql`${asyncJobsTable.payload}->>'factId' = ${String(staging.id)}`);
    assert.deepEqual(jobs.map((j) => j.queue), ["enrichment"]);
    assert.equal((ALL_LANES as readonly string[]).includes("pexels"), false);
  });
});

describe("migration 0107 retires stock recipes, Pexels jobs and settings, and drops the columns", () => {
  const slugs = {
    liveRecipe: `${PREFIX}live`,
    liveRecipeNoUrl: `${PREFIX}liveid`,
    deletedRecipe: `${PREFIX}gone`,
    storedStock: `${PREFIX}stored`,
    uploadRecipe: `${PREFIX}upload`,
  };
  const earlier = new Date("2026-04-04T00:00:00Z");
  const instanceId = `${PREFIX}${randomUUID()}`;

  async function seedPreMigrationState() {
    const base = { factId, createdById: adminId, aspectRatio: "landscape" };
    await db.insert(memesTable).values([
      { ...base, templateId: "photo_stock", permalinkSlug: slugs.liveRecipe, imageUrl: "/x", imageSource: { type: "stock", pexelsPhotoId: 1, photoUrl: "https://images.pexels.com/1.jpg" } },
      { ...base, templateId: "photo_stock", permalinkSlug: slugs.liveRecipeNoUrl, imageUrl: "/x", imageSource: { type: "stock", pexelsPhotoId: 2 } },
      { ...base, templateId: "photo_stock", permalinkSlug: slugs.deletedRecipe, imageUrl: "/x", imageSource: { type: "stock", pexelsPhotoId: 3 }, deletedAt: earlier },
      { ...base, templateId: "photo_stock", permalinkSlug: slugs.storedStock, imageUrl: "/x", imageSource: null },
      { ...base, templateId: "photo_upload", permalinkSlug: slugs.uploadRecipe, imageUrl: "/x", imageSource: { type: "upload", uploadKey: "/objects/uploads/t_p4r6.jpg" } },
    ]);
    await db.insert(adminConfigTable).values([
      { key: "pexels_photos_per_gender", value: "42", dataType: "integer", label: "Pexels Photos Per Fact Per Gender", isPublic: false },
      { key: "bg_display_limit_stock", value: "20", dataType: "integer", label: "Background Picker: Stock Photo Limit", isPublic: true },
    ]).onConflictDoNothing();
    await db.insert(asyncJobsTable).values([
      { queue: "fact_pexels", payload: { factId }, dedupeKey: `${PREFIX}pending`, status: "pending" },
      { queue: "fact_pexels", payload: { factId }, dedupeKey: `${PREFIX}done`, status: "done" },
    ] as Array<typeof asyncJobsTable.$inferInsert>);
    await db.insert(workerLaneHeartbeatsTable).values({ instanceId, lane: "pexels", workerProtocolVersion: 1, lastScheduledAt: new Date() } as typeof workerLaneHeartbeatsTable.$inferInsert);
  }

  async function deletedAtBySlug(): Promise<Record<string, Date | null>> {
    const rows = await db
      .select({ slug: memesTable.permalinkSlug, deletedAt: memesTable.deletedAt })
      .from(memesTable)
      .where(inArray(memesTable.permalinkSlug, Object.values(slugs)));
    return Object.fromEntries(rows.map((r) => [r.slug, r.deletedAt]));
  }

  async function jobStatuses(): Promise<Record<string, string>> {
    const rows = await db
      .select({ key: asyncJobsTable.dedupeKey, status: asyncJobsTable.status })
      .from(asyncJobsTable)
      .where(like(asyncJobsTable.dedupeKey, `${PREFIX}%`));
    return Object.fromEntries(rows.map((r) => [r.key!, r.status]));
  }

  async function logRows() {
    return db
      .select({ deletedRows: featurePermissionsMigrationLogTable.deletedRows })
      .from(featurePermissionsMigrationLogTable)
      .where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
  }

  async function columnsLeft(): Promise<string[]> {
    const res = await db.execute(sql`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'facts' AND column_name IN ('pexels_images', 'pexels_status'))
           OR (table_name = 'user_fact_preferences' AND column_name IN ('image_index', 'ai_meme_image_index')))`);
    return (res.rows as Array<{ col: string }>).map((r) => r.col).sort();
  }

  it("soft-deletes only live stock recipes, retires only nonterminal Pexels jobs, and captures before deleting", async () => {
    await seedPreMigrationState();
    const live = await db
      .select({ id: memesTable.id })
      .from(memesTable)
      .where(inArray(memesTable.permalinkSlug, [slugs.liveRecipe, slugs.liveRecipeNoUrl]));
    const [pendingJob] = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `${PREFIX}pending`));

    await db.execute(sql.raw(MIGRATION_SQL));

    const after = await deletedAtBySlug();
    assert.ok(after[slugs.liveRecipe], "a live stock recipe with a stored photoUrl is soft-deleted");
    assert.ok(after[slugs.liveRecipeNoUrl], "a live Pexels-only stock recipe is soft-deleted");
    assert.equal(after[slugs.deletedRecipe]?.toISOString(), earlier.toISOString(), "an already soft-deleted recipe keeps its timestamp");
    assert.equal(after[slugs.storedStock], null, "a photo_stock-labelled stored image is untouched");
    assert.equal(after[slugs.uploadRecipe], null, "an upload recipe is untouched");

    assert.deepEqual(await jobStatuses(), { [`${PREFIX}pending`]: "failed", [`${PREFIX}done`]: "done" });
    const [retired] = await db.select({ lastError: asyncJobsTable.lastError }).from(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `${PREFIX}pending`));
    assert.match(retired.lastError ?? "", /stock photos and Pexels were removed/);

    const config = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, CONFIG_KEYS));
    assert.equal(config.length, 0, "both settings are deleted");
    const heartbeats = await db.select().from(workerLaneHeartbeatsTable).where(and(eq(workerLaneHeartbeatsTable.instanceId, instanceId), eq(workerLaneHeartbeatsTable.lane, "pexels")));
    assert.equal(heartbeats.length, 0, "the pexels lane's heartbeat is deleted");

    const logs = await logRows();
    assert.equal(logs.length, 1, "one capture row");
    const captured = logs[0].deletedRows as {
      admin_config: Array<{ key: string; value: string }>;
      soft_deleted_meme_ids: number[];
      retired_job_ids: number[];
    };
    assert.deepEqual(captured.admin_config.map((r) => [r.key, r.value]), [["bg_display_limit_stock", "20"], ["pexels_photos_per_gender", "42"]]);
    for (const m of live) assert.ok(captured.soft_deleted_meme_ids.includes(m.id), "a soft-deleted meme's id is captured");
    assert.ok(captured.retired_job_ids.includes(pendingJob.id), "the retired job's id is captured");

    assert.deepEqual(await columnsLeft(), [], "the four columns are dropped");
  });

  it("is a no-op on a second run", async () => {
    const memesBefore = await deletedAtBySlug();
    const jobsBefore = await jobStatuses();
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await deletedAtBySlug(), memesBefore);
    assert.deepEqual(await jobStatuses(), jobsBefore);
    assert.equal((await logRows()).length, 1, "a re-run writes no second capture row");
  });
});
