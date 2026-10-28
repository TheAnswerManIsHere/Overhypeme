/**
 * Launch Phase 4, removal 11 — orphans after verification (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins three things:
 *   1. The fact-links routes and the admin resource-governance read answer
 *      404 through the whole app, even to an admin, while the fact detail
 *      response still embeds the fact's links (external_links stays).
 *   2. Migration 0110 captures what it would otherwise lose before dropping
 *      ratings, hero_examples, affiliate_clicks (with its two enums) and the
 *      six video-shaped engines columns, and before deleting the
 *      ai_gallery_display_limit setting: every hero_examples row, every rating
 *      0035 did not copy into reactions (and not the ones it did), every
 *      engine's non-empty video values (and not the empty ones), and the
 *      setting's row.
 *   3. A re-run is a no-op that captures nothing.
 *
 * The test database is built from the schema baseline, whose cutoff is past
 * 0110, so the dropped objects are already absent here. The migration case recreates them first,
 * which is the state the Repl's dev database is in when 0110 runs there.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, factsTable, enginesTable, reactionsTable, externalLinksTable } from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0110_prune_orphans.sql"),
  "utf8",
);

const PREFIX = "t_p4r11_";
const LOG = "0110_prune_orphans";
const VIDEO_COLUMNS = [
  "allowed_durations_sec", "default_duration_sec", "supported_modes",
  "default_mode", "audio_handling", "estimated_cost_usd_per_second",
];

let adminId: string;
let adminSid: string;
let factId: number;

async function dropRecreated() {
  await db.execute(sql`DROP TABLE IF EXISTS ratings`);
  await db.execute(sql`DROP TABLE IF EXISTS hero_examples`);
  await db.execute(sql`DROP TABLE IF EXISTS affiliate_clicks`);
  await db.execute(sql`DROP TYPE IF EXISTS affiliate_destination`);
  await db.execute(sql`DROP TYPE IF EXISTS affiliate_source_type`);
  for (const c of VIDEO_COLUMNS) await db.execute(sql.raw(`ALTER TABLE engines DROP COLUMN IF EXISTS ${c}`));
}

async function cleanup() {
  await dropRecreated();
  await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = ${LOG}`);
  await db.delete(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
  await db.delete(reactionsTable).where(like(reactionsTable.userId, `${PREFIX}%`));
  if (factId) await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

async function objectsLeft(): Promise<string[]> {
  const tables = await db.execute(sql`
    SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name IN ('ratings', 'hero_examples', 'affiliate_clicks')`);
  const types = await db.execute(sql`
    SELECT typname AS name FROM pg_type WHERE typname IN ('affiliate_destination', 'affiliate_source_type')`);
  const cols = await db.execute(sql`
    SELECT 'engines.' || column_name AS name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'engines'
       AND column_name IN ('allowed_durations_sec', 'default_duration_sec', 'supported_modes',
                           'default_mode', 'audio_handling', 'estimated_cost_usd_per_second')`);
  return [...tables.rows, ...types.rows, ...cols.rows].map((r) => (r as { name: string }).name).sort();
}

async function captures(): Promise<Array<Record<string, Array<Record<string, unknown>>>>> {
  const res = await db.execute(sql`
    SELECT deleted_rows FROM feature_permissions_migration_log WHERE migration_name = ${LOG} ORDER BY id`);
  return (res.rows as Array<{ deleted_rows: Record<string, Array<Record<string, unknown>>> }>).map((r) => r.deleted_rows);
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
  const [f] = await db.insert(factsTable).values({
    text: "{NAME} out-pruned the orphans.", submittedById: adminId, isActive: true,
    // Active facts require a non-empty Visual Concept (Phase 2 CHECK constraint).
    enrichment: buildPlaceholderFactEnrichment(),
  })
    .returning({ id: factsTable.id });
  factId = f!.id;
});

after(cleanup);

describe("the orphan routes are gone", () => {
  const gone: Array<[method: "get" | "delete", url: () => string]> = [
    ["get", () => `/api/facts/${factId}/links`],
    ["delete", () => `/api/facts/${factId}/links/1`],
    ["get", () => "/api/admin/resource-governance"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url().replace(String(factId), ":factId")} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url()).set("Authorization", `Bearer ${adminSid}`);
      assert.equal(res.status, 404);
    });
  }

  it("the fact detail response still carries the fact's links", async () => {
    await db.insert(externalLinksTable).values({ factId, url: "https://example.com/kept", addedById: adminId });
    const res = await request(createApp()).get(`/api/facts/${factId}`);
    assert.equal(res.status, 200);
    assert.deepEqual((res.body.links as Array<{ url: string }>).map((l) => l.url), ["https://example.com/kept"]);
  });
});

describe("migration 0110 captures, then drops the orphans", () => {
  it("captures the hero rows, the uncopied rating and the non-empty engine values, then drops everything", async () => {
    // The pre-0110 schema, as the Repl's dev database still has it.
    await db.execute(sql`
      CREATE TABLE ratings (
        fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating varchar(10) NOT NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        UNIQUE (fact_id, user_id))`);
    await db.execute(sql`
      CREATE TABLE hero_examples (
        id serial PRIMARY KEY, artifact_type varchar(8) NOT NULL, asset_url text NOT NULL,
        poster_url text, caption_label text NOT NULL DEFAULT '', sort_order integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now())`);
    await db.execute(sql`CREATE TYPE affiliate_destination AS ENUM ('zazzle')`);
    await db.execute(sql`CREATE TYPE affiliate_source_type AS ENUM ('fact', 'meme')`);
    await db.execute(sql`
      CREATE TABLE affiliate_clicks (
        id serial PRIMARY KEY, user_id varchar, source_type affiliate_source_type NOT NULL,
        source_id varchar NOT NULL, destination affiliate_destination NOT NULL, source varchar(64),
        clicked_at timestamp with time zone NOT NULL DEFAULT now())`);
    await db.execute(sql.raw(`ALTER TABLE engines
      ADD COLUMN allowed_durations_sec jsonb, ADD COLUMN default_duration_sec integer,
      ADD COLUMN supported_modes jsonb, ADD COLUMN default_mode varchar(32),
      ADD COLUMN audio_handling varchar(32) NOT NULL DEFAULT 'none',
      ADD COLUMN estimated_cost_usd_per_second numeric(10, 6)`));

    // Row states. Ratings: one 0035 copied into reactions, one it did not.
    const copier = `${PREFIX}copied_${randomUUID()}`;
    const lost = `${PREFIX}lost_${randomUUID()}`;
    await db.insert(usersTable).values([
      { id: copier, email: `${copier}@test.local` },
      { id: lost, email: `${lost}@test.local` },
    ]);
    await db.execute(sql`INSERT INTO ratings (fact_id, user_id, rating) VALUES (${factId}, ${copier}, 'up'), (${factId}, ${lost}, 'down')`);
    await db.insert(reactionsTable).values({ userId: copier, targetType: "fact", targetId: factId, reactionType: "up" });
    // Hero examples: an admin-curated image row.
    await db.execute(sql`INSERT INTO hero_examples (artifact_type, asset_url, caption_label) VALUES ('image', 'https://cdn.test/hero.jpg', 'Curated')`);
    // Telemetry: counted, not captured.
    await db.execute(sql`INSERT INTO affiliate_clicks (source_type, source_id, destination) VALUES ('fact', '1', 'zazzle')`);
    // Engines: one with a non-empty video value, one with only the empty values.
    await db.insert(enginesTable).values([
      { id: `${PREFIX}video_valued`, provider: "fal", endpointId: `${PREFIX}a`, label: "valued", kind: "image", paramSchema: { params: [] } as unknown },
      { id: `${PREFIX}empty`, provider: "fal", endpointId: `${PREFIX}b`, label: "empty", kind: "image", paramSchema: { params: [] } as unknown },
    ]);
    await db.execute(sql`UPDATE engines SET audio_handling = 'prompt_cue', default_duration_sec = 6 WHERE id = ${`${PREFIX}video_valued`}`);
    await db.execute(sql`UPDATE engines SET supported_modes = '[]'::jsonb WHERE id = ${`${PREFIX}empty`}`);
    // The orphan setting, as an admin left it.
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES ('ai_gallery_display_limit', '4', 'integer', 'AI Gallery Display Limit', true)
      ON CONFLICT (key) DO UPDATE SET value = '4'`);
    assert.equal((await objectsLeft()).length, 11, "the premise: three tables, two enums and six columns exist");

    await db.execute(sql.raw(MIGRATION_SQL));

    assert.deepEqual(await objectsLeft(), [], "every orphan object is dropped");
    const logged = await captures();
    assert.equal(logged.length, 1, "one capture row");
    const [captured] = logged;
    assert.deepEqual(captured!.hero_examples!.map((h) => [h.artifact_type, h.asset_url, h.caption_label]), [["image", "https://cdn.test/hero.jpg", "Curated"]]);
    assert.deepEqual(captured!.ratings_not_in_reactions!.map((r) => [r.user_id, r.rating]), [[lost, "down"]], "only the rating reactions does not hold");
    const engines = captured!.engines_video_columns!.filter((e) => String(e.id).startsWith(PREFIX));
    assert.deepEqual(engines.map((e) => [e.id, e.audio_handling, e.default_duration_sec]), [[`${PREFIX}video_valued`, "prompt_cue", 6]], "only the engine with a video value");
    assert.deepEqual(captured!.admin_config!.map((c) => [c.key, c.value]), [["ai_gallery_display_limit", "4"]], "the setting as the admin left it");
    const setting = await db.execute(sql`SELECT 1 FROM admin_config WHERE key = 'ai_gallery_display_limit'`);
    assert.equal(setting.rows.length, 0, "the setting row is deleted");
    assert.equal((await db.select().from(enginesTable).where(inArray(enginesTable.id, [`${PREFIX}video_valued`, `${PREFIX}empty`]))).length, 2, "engine rows themselves are kept");
  });

  it("is a no-op on a second run, and captures nothing", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await objectsLeft(), []);
    assert.equal((await captures()).length, 1, "no second capture row");
  });
});
