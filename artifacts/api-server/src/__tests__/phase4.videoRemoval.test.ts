/**
 * Launch Phase 4, removal 2 — video is gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins three things:
 *   1. Every video route answers 404 through the whole app, the admin Video
 *      Styles routes included.
 *   2. The one retained endpoint that lived in the video route file,
 *      GET /api/look-styles (the admin image bench and the runtime prompt
 *      preview read it), still serves from its new home.
 *   3. Migration 0103 retires video's data by row state: a video meme is
 *      soft-deleted and an image meme is untouched; the video engines, the
 *      caption utility and their pricing rows go while image engines stay; the
 *      video hero rows, the video-direction prompt, the video endpoints in
 *      fal_active_endpoints and the video_generation feature go (the feature
 *      captured first); the video tables and memes columns are dropped.
 *      Idempotent.
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
  enginesTable,
  falPricingCacheTable,
  adminConfigTable,
  lookStylesTable,
} from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0103_retire_video.sql"),
  "utf8",
);

const PREFIX = "t_p4r2_";
const factIds: number[] = [];
const memeSlugs: string[] = [];
let adminId: string;
let adminSid: string;
let factId: number;

async function bearer(userId: string): Promise<string> {
  const data: SessionData = {
    user: { id: userId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  return createSession(data, userId);
}

async function cleanup() {
  if (memeSlugs.length) await db.delete(memesTable).where(inArray(memesTable.permalinkSlug, memeSlugs));
  if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
  await db.delete(falPricingCacheTable).where(like(falPricingCacheTable.endpointId, `${PREFIX}%`));
  await db.delete(lookStylesTable).where(like(lookStylesTable.id, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
  memeSlugs.length = 0;
  factIds.length = 0;
}

before(async () => {
  await cleanup();
  adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: adminId,
    email: `${adminId}@test.local`,
    isAdmin: true,
    membershipTier: "legendary",
    captchaVerified: true,
  });
  adminSid = await bearer(adminId);
  const [fact] = await db
    .insert(factsTable)
    .values({ text: "{NAME} outran a sunrise.", submittedById: adminId, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  factId = fact!.id;
  factIds.push(factId);
});

after(cleanup);

describe("video routes are gone", () => {
  const gone: Array<[method: "get" | "post" | "patch" | "delete", url: () => string]> = [
    ["post", () => "/api/videos/generate"],
    ["post", () => "/api/videos/generate-prompt"],
    ["get", () => `/api/videos/${factId}`],
    ["get", () => "/api/video/1"],
    ["get", () => "/api/engines?kind=video"],
    ["get", () => "/api/motion-presets"],
    ["get", () => "/api/video-styles"],
    ["get", () => "/api/video-styles/cinematic/preview-gif"],
    ["get", () => "/api/hero-examples"],
    ["post", () => "/api/memes/video-jobs"],
    ["get", () => "/api/memes/video-jobs/1"],
    ["post", () => "/api/memes/video-jobs/1/proceed"],
    ["delete", () => "/api/memes/video-jobs/1"],
    ["get", () => "/api/memes/video-jobs/_meta/default-engine"],
    ["get", () => "/api/admin/video-styles"],
    ["post", () => "/api/admin/video-styles"],
    ["patch", () => "/api/admin/video-styles/cinematic"],
    ["post", () => "/api/admin/video-styles/cinematic/preview-gif"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url().replace(String(factId), ":factId")} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url()).set("Authorization", `Bearer ${adminSid}`).send({});
      assert.equal(res.status, 404);
    });
  }
});

describe("the look-styles catalogue survives its move out of the video routes", () => {
  it("GET /api/look-styles lists active styles without their prompt suffixes", async () => {
    const id = `${PREFIX}look`;
    await db.insert(lookStylesTable).values({ id, label: "Test look", promptSuffix: "secret suffix", sortOrder: 9999 });
    const res = await request(createApp()).get("/api/look-styles");
    assert.equal(res.status, 200);
    const row = (res.body as Array<Record<string, unknown>>).find((s) => s.id === id);
    assert.ok(row, "the seeded style is listed");
    assert.equal(row.label, "Test look");
    assert.equal("promptSuffix" in row, false, "server-only suffixes are stripped");
  });
});

describe("migration 0103 retires video's data and schema", () => {
  const ENDPOINTS_KEY = "fal_active_endpoints";
  let savedEndpoints: string | null = null;

  async function engine(id: string, kind: string, endpointId: string) {
    await db.insert(enginesTable).values({
      id,
      provider: "fal",
      endpointId,
      label: id,
      description: "Synthetic engine — phase4.videoRemoval.test.ts.",
      kind,
      tierRequirement: "legendary",
      isDefault: false,
      isActive: true,
      sortOrder: 999,
      audioHandling: "none",
      paramSchema: { params: [] } as unknown,
    });
  }

  async function pricing(endpointId: string) {
    await db.insert(falPricingCacheTable).values({ endpointId, unitPrice: "0.05", unit: "second", fetchedAt: new Date() });
  }

  async function meme(slug: string, artifactType: "image" | "video") {
    memeSlugs.push(slug);
    await db.insert(memesTable).values({
      factId,
      templateId: artifactType === "video" ? "video" : "photo_upload",
      imageUrl: `/api/memes/${slug}/image`,
      permalinkSlug: slug,
      artifactType,
    });
  }

  /** Recreates the pre-0103 video schema and rows the migration must retire. */
  async function seedPreMigrationState() {
    await db.execute(sql.raw(`
      ALTER TABLE memes ADD COLUMN IF NOT EXISTS video_object_path text;
      ALTER TABLE memes ADD COLUMN IF NOT EXISTS video_job_id integer;
      ALTER TABLE memes ADD COLUMN IF NOT EXISTS motion_preset_id varchar(64);
      ALTER TABLE memes ADD COLUMN IF NOT EXISTS look_style_id varchar(64);
      DO $$ BEGIN
        CREATE TYPE video_job_status AS ENUM ('pending', 'completed', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS video_jobs (id serial PRIMARY KEY, status video_job_status NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS motion_presets (id varchar(64) PRIMARY KEY, label varchar(128) NOT NULL);
      CREATE TABLE IF NOT EXISTS video_styles (id varchar(64) PRIMARY KEY, label varchar(128) NOT NULL);
      INSERT INTO video_jobs (status) VALUES ('pending'), ('completed');
      INSERT INTO motion_presets (id, label) VALUES ('${PREFIX}mp', 'x') ON CONFLICT DO NOTHING;
    `));
    await meme(`p4v${randomUUID().slice(0, 8)}`, "video"); // permalink_slug is varchar(16)
    await meme(`p4i${randomUUID().slice(0, 8)}`, "image");
    await engine(`${PREFIX}video`, "video", `${PREFIX}vendor/image-to-video`);
    await engine(`${PREFIX}image`, "image", `${PREFIX}vendor/edit`);
    await pricing(`${PREFIX}vendor/image-to-video`);
    await pricing(`${PREFIX}vendor/auto-subtitle`);
    await pricing(`${PREFIX}vendor/edit`);
    await db.execute(sql`
      INSERT INTO hero_examples (artifact_type, asset_url) VALUES ('video', ${`https://cdn.test/${PREFIX}.mp4`}), ('image', ${`https://cdn.test/${PREFIX}.jpg`})`);
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES ('video_direction_system', 'direct the motion', 'text', 'Video direction', false)
      ON CONFLICT (key) DO NOTHING`);
    const [saved] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    savedEndpoints = saved?.value ?? null;
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES (${ENDPOINTS_KEY}, '["fal-ai/flux-pro/v1.1","xai/grok-imagine-video/image-to-video","fal-ai/workflow-utilities/auto-subtitle"]', 'string', 'fal.ai Active Endpoint IDs', false)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.execute(sql`
      INSERT INTO feature_flags (key, display_name) VALUES ('video_generation', 'Video Generation') ON CONFLICT (key) DO NOTHING`);
    await db.execute(sql`
      INSERT INTO tier_feature_permissions (tier, feature_key, enabled)
      VALUES ('legendary', 'video_generation', true), ('registered', 'video_generation', false)
      ON CONFLICT (tier, feature_key) DO NOTHING`);
  }

  after(async () => {
    await db.execute(sql`DELETE FROM hero_examples WHERE asset_url LIKE ${`https://cdn.test/${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = '0103_retire_video'`);
    if (savedEndpoints === null) {
      await db.delete(adminConfigTable).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    } else {
      await db.update(adminConfigTable).set({ value: savedEndpoints }).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    }
  });

  it("retires every video row state, keeps the image ones, and drops the video schema", async () => {
    await seedPreMigrationState();
    const [{ revision: revBefore }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;

    await db.execute(sql.raw(MIGRATION_SQL));

    const memes = await db
      .select({ slug: memesTable.permalinkSlug, artifactType: memesTable.artifactType, deletedAt: memesTable.deletedAt })
      .from(memesTable)
      .where(inArray(memesTable.permalinkSlug, memeSlugs));
    for (const m of memes) {
      if (m.artifactType === "video") assert.ok(m.deletedAt, "the video meme is soft-deleted, not removed");
      else assert.equal(m.deletedAt, null, "the image meme is untouched");
    }
    assert.equal(memes.length, 2);

    const engines = await db.select({ id: enginesTable.id }).from(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
    assert.deepEqual(engines.map((e) => e.id), [`${PREFIX}image`]);

    const prices = await db.select({ e: falPricingCacheTable.endpointId }).from(falPricingCacheTable).where(like(falPricingCacheTable.endpointId, `${PREFIX}%`));
    assert.deepEqual(prices.map((p) => p.e), [`${PREFIX}vendor/edit`]);

    const hero = (await db.execute(sql`SELECT artifact_type FROM hero_examples WHERE asset_url LIKE ${`https://cdn.test/${PREFIX}%`}`)).rows as Array<{ artifact_type: string }>;
    assert.deepEqual(hero.map((h) => h.artifact_type), ["image"]);

    const config = await db.select({ key: adminConfigTable.key, value: adminConfigTable.value }).from(adminConfigTable)
      .where(inArray(adminConfigTable.key, ["video_direction_system", ENDPOINTS_KEY]));
    assert.deepEqual(config.map((c) => c.key), [ENDPOINTS_KEY]);
    assert.deepEqual(JSON.parse(config[0]!.value), ["fal-ai/flux-pro/v1.1"]);

    const flags = (await db.execute(sql`
      SELECT (SELECT count(*) FROM feature_flags WHERE key = 'video_generation')::int AS flags,
             (SELECT count(*) FROM tier_feature_permissions WHERE feature_key = 'video_generation')::int AS perms`)).rows as Array<{ flags: number; perms: number }>;
    assert.deepEqual(flags[0], { flags: 0, perms: 0 });
    const log = (await db.execute(sql`
      SELECT deleted_rows FROM feature_permissions_migration_log WHERE migration_name = '0103_retire_video'`)).rows as Array<{ deleted_rows: { feature_flags: unknown[]; tier_feature_permissions: unknown[] } }>;
    assert.equal(log.length, 1, "the retired feature rows are captured before the delete");
    assert.equal(log[0]!.deleted_rows.feature_flags.length, 1);
    assert.equal(log[0]!.deleted_rows.tier_feature_permissions.length, 2);
    const [{ revision: revAfter }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    const hasRevisionRow = ((await db.execute(sql`SELECT 1 FROM entitlement_grid_revision WHERE id = 1`)).rows.length) > 0;
    assert.equal(revAfter, hasRevisionRow ? revBefore + 1 : revBefore, "the grid revision bumps when the grid changes");

    const schema = (await db.execute(sql`
      SELECT to_regclass('public.video_jobs')::text AS video_jobs,
             to_regclass('public.motion_presets')::text AS motion_presets,
             to_regclass('public.video_styles')::text AS video_styles,
             (SELECT count(*) FROM pg_type WHERE typname = 'video_job_status')::int AS enum_count,
             (SELECT count(*) FROM information_schema.columns
               WHERE table_name = 'memes'
                 AND column_name IN ('video_object_path', 'video_job_id', 'motion_preset_id', 'look_style_id'))::int AS meme_columns`)).rows[0];
    assert.deepEqual(schema, { video_jobs: null, motion_presets: null, video_styles: null, enum_count: 0, meme_columns: 0 });
  });

  it("is idempotent: a second run changes nothing and logs no second capture", async () => {
    const [{ revision: revBefore }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    await db.execute(sql.raw(MIGRATION_SQL));
    const log = (await db.execute(sql`SELECT 1 FROM feature_permissions_migration_log WHERE migration_name = '0103_retire_video'`)).rows;
    assert.equal(log.length, 1);
    const [{ revision: revAfter }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    assert.equal(revAfter, revBefore);
    const memes = await db.select({ deletedAt: memesTable.deletedAt, artifactType: memesTable.artifactType }).from(memesTable).where(inArray(memesTable.permalinkSlug, memeSlugs));
    assert.equal(memes.filter((m) => m.deletedAt !== null).length, 1, "still exactly the one video meme retired");
  });

  it("retires a video meme even when a schema push already dropped the video columns", async () => {
    // The state after `push-force` then `migrate`: the columns are gone (the
    // first case dropped them) but a live video meme survives.
    const slug = `p4w${randomUUID().slice(0, 8)}`;
    await meme(slug, "video");
    await db.execute(sql.raw(MIGRATION_SQL));
    const [row] = await db.select({ deletedAt: memesTable.deletedAt }).from(memesTable).where(eq(memesTable.permalinkSlug, slug));
    assert.ok(row?.deletedAt, "the video meme is soft-deleted without its video columns present");
  });
});
