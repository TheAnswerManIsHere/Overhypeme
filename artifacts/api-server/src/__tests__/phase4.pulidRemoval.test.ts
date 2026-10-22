/**
 * Launch Phase 4, removal 3 — PuLID is gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins two things (that a save no longer writes a PuLID label is
 * phase4.validators.test.ts's):
 *   1. Every PuLID route answers 404 through the whole app, the user generate
 *      route (the remix builder's stylise toggle) included.
 *   2. Migration 0104 retires PuLID's data by row state: the PuLID engine, its
 *      pricing row, the run-time estimate and its fal_active_endpoints entry
 *      go while the image engines and fal_safety_tolerance_pulid stay;
 *      meme_pulid_stylize and meme_ai_background are captured, then deleted;
 *      a PuLID-labelled meme and image are untouched. Idempotent.
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
} from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0104_retire_pulid.sql"),
  "utf8",
);

const PREFIX = "t_p4r3_";
const FEATURES = ["meme_pulid_stylize", "meme_ai_background"] as const;
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
  await db.execute(sql`DELETE FROM upload_image_metadata WHERE user_id LIKE ${`${PREFIX}%`}`);
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
    .values({ text: "{NAME} outstared a lighthouse.", submittedById: adminId, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  factId = fact!.id;
  factIds.push(factId);
});

after(cleanup);

describe("PuLID routes are gone", () => {
  const gone: Array<[method: "get" | "post" | "delete", url: () => string]> = [
    ["post", () => "/api/memes/pulid-jobs"],
    ["get", () => "/api/memes/pulid-jobs/job-1"],
    ["post", () => "/api/memes/pulid-jobs/job-1/proceed-with-no-face-fallback"],
    ["delete", () => "/api/memes/pulid-jobs/job-1"],
    ["post", () => `/api/memes/ai/${factId}/generate`],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url().replace(String(factId), ":factId")} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url())
        .set("Authorization", `Bearer ${adminSid}`)
        .send({ factId, referenceImagePath: "/objects/uploads/x.jpg" });
      assert.equal(res.status, 404);
    });
  }
});

describe("migration 0104 retires PuLID's data", () => {
  const ENDPOINTS_KEY = "fal_active_endpoints";
  let savedEndpoints: string | null = null;

  async function meme(slug: string, imageTransform: "pulid" | null) {
    memeSlugs.push(slug);
    await db.insert(memesTable).values({
      factId,
      templateId: "photo_upload",
      imageUrl: `/api/memes/${slug}/image`,
      permalinkSlug: slug,
      imageTransform,
    });
  }

  /** Recreates the pre-0104 PuLID rows the migration must retire, beside rows it must keep. */
  async function seedPreMigrationState() {
    // The test database was migrated before the suite (pretest), so 0104 may
    // already have logged a capture there; count only this test's own run.
    await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = '0104_retire_pulid'`);
    await db.insert(enginesTable).values([
      { id: `${PREFIX}pulid`, provider: "fal", endpointId: "fal-ai/flux-pulid", label: "PuLID (test)", description: "Synthetic — phase4.pulidRemoval.test.ts.", kind: "image", tierRequirement: "legendary", isDefault: false, isActive: true, sortOrder: 999, audioHandling: "none", paramSchema: { params: [] } as unknown },
      { id: `${PREFIX}image`, provider: "fal", endpointId: `${PREFIX}vendor/edit`, label: "Image (test)", description: "Synthetic — phase4.pulidRemoval.test.ts.", kind: "image", tierRequirement: "legendary", isDefault: false, isActive: true, sortOrder: 999, audioHandling: "none", paramSchema: { params: [] } as unknown },
    ]);
    await db.insert(falPricingCacheTable).values([
      { endpointId: "fal-ai/flux-pulid", unitPrice: "0.0333", unit: "megapixels", fetchedAt: new Date() },
      { endpointId: `${PREFIX}vendor/edit`, unitPrice: "0.04", unit: "image", fetchedAt: new Date() },
    ]).onConflictDoNothing();
    await meme(`p4p${randomUUID().slice(0, 8)}`, "pulid"); // permalink_slug is varchar(16)
    await meme(`p4n${randomUUID().slice(0, 8)}`, null);
    await db.execute(sql`
      INSERT INTO upload_image_metadata (object_path, user_id, width, height, is_low_res, file_size_bytes, transform, fact_id)
      VALUES (${`/objects/uploads/${PREFIX}pulid.jpg`}, ${adminId}, 512, 512, false, 1000, 'pulid', ${factId})`);
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES ('pulid_expected_run_ms_ema', '16101', 'integer', 'PuLID run-time estimate', false)
      ON CONFLICT (key) DO NOTHING`);
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES ('fal_safety_tolerance_pulid', '1', 'text', 'fal.ai safety tolerance (FLUX Pro)', false)
      ON CONFLICT (key) DO NOTHING`);
    const [saved] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    savedEndpoints = saved?.value ?? null;
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, is_public)
      VALUES (${ENDPOINTS_KEY}, '["fal-ai/flux-pro/v1.1", "fal-ai/flux-pulid"]', 'string', 'fal.ai Active Endpoint IDs', false)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    for (const key of FEATURES) {
      await db.execute(sql`INSERT INTO feature_flags (key, display_name) VALUES (${key}, ${key}) ON CONFLICT (key) DO NOTHING`);
      await db.execute(sql`
        INSERT INTO tier_feature_permissions (tier, feature_key, enabled)
        VALUES ('legendary', ${key}, true), ('registered', ${key}, false)
        ON CONFLICT (tier, feature_key) DO NOTHING`);
    }
  }

  after(async () => {
    await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = '0104_retire_pulid'`);
    await db.execute(sql`DELETE FROM fal_pricing_cache WHERE endpoint_id = 'fal-ai/flux-pulid'`);
    if (savedEndpoints === null) {
      await db.delete(adminConfigTable).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    } else {
      await db.update(adminConfigTable).set({ value: savedEndpoints }).where(eq(adminConfigTable.key, ENDPOINTS_KEY));
    }
  });

  it("retires PuLID's rows, keeps the image ones and the PuLID-labelled data", async () => {
    await seedPreMigrationState();
    const [{ revision: revBefore }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;

    await db.execute(sql.raw(MIGRATION_SQL));

    const engines = await db.select({ id: enginesTable.id }).from(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
    assert.deepEqual(engines.map((e) => e.id), [`${PREFIX}image`]);
    const prices = await db.select({ e: falPricingCacheTable.endpointId }).from(falPricingCacheTable)
      .where(inArray(falPricingCacheTable.endpointId, ["fal-ai/flux-pulid", `${PREFIX}vendor/edit`]));
    assert.deepEqual(prices.map((p) => p.e), [`${PREFIX}vendor/edit`]);

    const config = await db.select({ key: adminConfigTable.key, value: adminConfigTable.value }).from(adminConfigTable)
      .where(inArray(adminConfigTable.key, ["pulid_expected_run_ms_ema", "fal_safety_tolerance_pulid", ENDPOINTS_KEY]));
    assert.deepEqual(config.map((c) => c.key).sort(), [ENDPOINTS_KEY, "fal_safety_tolerance_pulid"].sort(),
      "the run-time estimate goes; the FLUX Pro safety tolerance stays despite its name");
    assert.deepEqual(JSON.parse(config.find((c) => c.key === ENDPOINTS_KEY)!.value), ["fal-ai/flux-pro/v1.1"]);

    const memes = await db.select({ imageTransform: memesTable.imageTransform, deletedAt: memesTable.deletedAt })
      .from(memesTable).where(inArray(memesTable.permalinkSlug, memeSlugs));
    assert.equal(memes.length, 2);
    assert.ok(memes.every((m) => m.deletedAt === null), "no meme is soft-deleted");
    assert.ok(memes.some((m) => m.imageTransform === "pulid"), "the PuLID label stays as historical data");
    const uim = (await db.execute(sql`SELECT transform FROM upload_image_metadata WHERE user_id = ${adminId}`)).rows as Array<{ transform: string }>;
    assert.deepEqual(uim.map((r) => r.transform), ["pulid"]);

    const grid = (await db.execute(sql`
      SELECT (SELECT count(*) FROM feature_flags WHERE key IN ('meme_pulid_stylize', 'meme_ai_background'))::int AS flags,
             (SELECT count(*) FROM tier_feature_permissions WHERE feature_key IN ('meme_pulid_stylize', 'meme_ai_background'))::int AS perms`)).rows as Array<{ flags: number; perms: number }>;
    assert.deepEqual(grid[0], { flags: 0, perms: 0 });
    const log = (await db.execute(sql`
      SELECT deleted_rows FROM feature_permissions_migration_log WHERE migration_name = '0104_retire_pulid'`)).rows as Array<{ deleted_rows: { feature_flags: Array<{ key: string }>; tier_feature_permissions: unknown[] } }>;
    assert.equal(log.length, 1, "the retired feature rows are captured before the delete");
    assert.deepEqual(log[0]!.deleted_rows.feature_flags.map((f) => f.key).sort(), [...FEATURES].sort());
    assert.equal(log[0]!.deleted_rows.tier_feature_permissions.length, 4);
    const [{ revision: revAfter }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    const hasRevisionRow = ((await db.execute(sql`SELECT 1 FROM entitlement_grid_revision WHERE id = 1`)).rows.length) > 0;
    assert.equal(revAfter, hasRevisionRow ? revBefore + 1 : revBefore, "the grid revision bumps when the grid changes");
  });

  it("is idempotent: a second run changes nothing and logs no second capture", async () => {
    const [{ revision: revBefore }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    await db.execute(sql.raw(MIGRATION_SQL));
    const log = (await db.execute(sql`SELECT 1 FROM feature_permissions_migration_log WHERE migration_name = '0104_retire_pulid'`)).rows;
    assert.equal(log.length, 1);
    const [{ revision: revAfter }] = (await db.execute(sql`SELECT coalesce((SELECT revision FROM entitlement_grid_revision WHERE id = 1), 0)::int AS revision`)).rows as Array<{ revision: number }>;
    assert.equal(revAfter, revBefore);
    const engines = await db.select({ id: enginesTable.id }).from(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
    assert.deepEqual(engines.map((e) => e.id), [`${PREFIX}image`]);
  });
});
