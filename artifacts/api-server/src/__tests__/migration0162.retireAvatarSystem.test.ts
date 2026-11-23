/**
 * Migration 0162 (plan docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md, "Data Model
 * and Migration Impact"): the custom_avatar feature is captured then deleted, a
 * picture that is not a first-party upload is cleared, and the avatar columns
 * are dropped.
 *
 * The test database is built past 0162, so the test recreates the state 0162
 * runs on: the two columns and the flag and tier rows are put back, the planted
 * users are written, and running the migration removes them again.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0162_retire_avatar_system.sql"), "utf8");
const P = `t_0162_${randomUUID().slice(0, 8)}_`;

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  client.on("notice", (m) => { if (m.message?.startsWith("[0162]")) notices.push(m.message); });
  try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  return notices;
}

const pictureOf = async (id: string) =>
  (await rows<{ p: string | null }>(sql`SELECT profile_image_url AS p FROM users WHERE id = ${id}`))[0]!.p;

describe("migration 0162: the avatar system is retired", () => {
  const users = { photo: `${P}photo`, provider: `${P}provider`, none: `${P}none`, sneaky: `${P}sneaky` };
  const firstParty = `/api/storage/objects/uploads/${P}.jpg`;
  let logBefore = 0;
  let first: string[] = [];
  let second: string[] = [];

  before(async () => {
    logBefore = (await rows<{ n: number }>(sql`SELECT coalesce(max(id), 0)::int AS n FROM feature_permissions_migration_log`))[0]!.n;
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_style varchar(30) DEFAULT 'bottts'`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_source varchar(10) DEFAULT 'avatar'`);
    await db.execute(sql`INSERT INTO feature_flags (key, display_name, description)
      VALUES ('custom_avatar', 'Custom Avatar Photo', 'planted') ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO tier_feature_permissions (tier, feature_key, enabled) VALUES
      ('unregistered', 'custom_avatar', false), ('registered', 'custom_avatar', false),
      ('legendary', 'custom_avatar', true), ('admin', 'custom_avatar', true) ON CONFLICT DO NOTHING`);
    for (const [k, id] of Object.entries(users)) {
      const picture = k === "photo" ? firstParty
        : k === "provider" ? "https://lh3.googleusercontent.com/a/abc=s96-c"
        : k === "sneaky" ? "/api/storage/objects/../../etc/passwd"
        : null;
      await db.execute(sql`INSERT INTO users (id, email, profile_image_url) VALUES (${id}, ${`${id}@test.local`}, ${picture})`);
    }
    first = await runMigration();
    second = await runMigration();
  });

  after(async () => {
    await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${P}%`}`);
    await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE id > ${logBefore} AND migration_name = '0162_retire_avatar_system'`);
  });

  it("captures the custom_avatar feature and its tier rows, then deletes them", async () => {
    assert.match(first[0]!, /features retired: 1, tier rows retired: 4,/);
    assert.equal((await rows(sql`SELECT 1 FROM feature_flags WHERE key = 'custom_avatar'`)).length, 0);
    assert.equal((await rows(sql`SELECT 1 FROM tier_feature_permissions WHERE feature_key = 'custom_avatar'`)).length, 0);
    const [log] = await rows<{ d: { feature_flags: unknown[]; tier_feature_permissions: unknown[] } }>(sql`
      SELECT deleted_rows AS d FROM feature_permissions_migration_log
       WHERE id > ${logBefore} AND migration_name = '0162_retire_avatar_system'`);
    assert.equal(log!.d.feature_flags.length, 1, "the flag row is captured for recovery");
    assert.equal(log!.d.tier_feature_permissions.length, 4, "and its tier rows");
  });

  it("keeps a first-party photo and clears every other picture", async () => {
    assert.equal(await pictureOf(users.photo), firstParty);
    assert.equal(await pictureOf(users.provider), null);
    assert.equal(await pictureOf(users.sneaky), null, "a path that climbs out of storage is not a photo");
    assert.equal(await pictureOf(users.none), null);
    assert.match(first[0]!, /provider pictures cleared: [1-9]\d*,/);
  });

  it("drops the avatar columns", async () => {
    assert.match(first[0]!, /avatar columns dropped: 2, failed 0/);
    const cols = await rows(sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name IN ('avatar_style', 'avatar_source')`);
    assert.equal(cols.length, 0);
  });

  it("a second run changes nothing", () => {
    assert.match(second[0]!, /features retired: 0, tier rows retired: 0, provider pictures cleared: 0, avatar columns dropped: 0, failed 0/);
  });
});
