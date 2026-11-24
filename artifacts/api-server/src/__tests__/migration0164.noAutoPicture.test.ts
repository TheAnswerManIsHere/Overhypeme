/**
 * Migration 0164 (plan docs/plans/PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md, "Data
 * Model and Migration Impact"): users.no_auto_picture is added, and every owner
 * whose profile photo was already taken down has it set from the takedown's
 * audit row. No picture is touched; a re-run changes nothing and keeps a flag
 * set for another reason (a removal, which leaves no audit row).
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
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0164_no_auto_picture.sql"), "utf8");
const P = `t_0164_${randomUUID().slice(0, 8)}_`;

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  client.on("notice", (m) => { if (m.message?.startsWith("[0164]")) notices.push(m.message); });
  try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  return notices;
}

const flagOf = async (id: string) =>
  ((await db.execute(sql`SELECT no_auto_picture AS f, profile_image_url AS p FROM users WHERE id = ${id}`)).rows[0]) as { f: boolean; p: string | null };

describe("migration 0164: no automatic picture after a profile takedown", () => {
  const u = { takenDown: `${P}down`, otherPhoto: `${P}other`, meme: `${P}meme`, removed: `${P}removed`, plain: `${P}plain` };
  const picture = `/api/storage/objects/uploads/${P}.jpg`;
  let first: string[] = [];
  let second: string[] = [];

  before(async () => {
    for (const id of Object.values(u)) {
      await db.execute(sql`INSERT INTO users (id, email, profile_image_url) VALUES (${id}, ${`${id}@test.local`}, ${id === u.plain ? picture : null})`);
    }
    await db.execute(sql`UPDATE users SET no_auto_picture = true WHERE id = ${u.removed}`);
    const audit = async (detail: Record<string, unknown>) =>
      db.execute(sql`INSERT INTO admin_actions (actor_id, action, detail) VALUES (NULL, 'content_takedown', ${JSON.stringify(detail)}::jsonb)`);
    await audit({ kind: "photo", key: "/objects/x", ownerId: u.takenDown, reason: "r", wasProfile: true });
    await audit({ kind: "photo", key: "/objects/y", ownerId: u.otherPhoto, reason: "r", wasProfile: false });
    await audit({ kind: "meme", key: "slug", ownerId: u.meme, reason: "r", wasProfile: false });
    first = await runMigration();
    second = await runMigration();
  });
  after(async () => {
    await db.execute(sql`DELETE FROM admin_actions WHERE action = 'content_takedown' AND detail->>'ownerId' LIKE ${P + "%"}`);
    await db.execute(sql`DELETE FROM users WHERE id LIKE ${P + "%"}`);
  });

  it("sets the flag only for an owner whose profile photo was taken down", async () => {
    assert.equal((await flagOf(u.takenDown)).f, true);
    assert.equal((await flagOf(u.otherPhoto)).f, false, "a photo that was not their picture");
    assert.equal((await flagOf(u.meme)).f, false, "a meme takedown");
    assert.equal((await flagOf(u.plain)).f, false);
  });

  it("touches no picture, and keeps a flag set for another reason", async () => {
    assert.equal((await flagOf(u.plain)).p, picture);
    assert.equal((await flagOf(u.removed)).f, true);
  });

  it("reports its counts, and a second run changes nothing", () => {
    assert.match(first[0] ?? "", /members set from earlier takedowns: [1-9]\d*/);
    assert.match(second[0] ?? "", /column added: 0, members set from earlier takedowns: 0, failed 0/);
  });
});
