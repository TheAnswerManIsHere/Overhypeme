/**
 * Migration 0166 (plan docs/plans/PLAN_SIGNUP_RETURN.md, "Data Model and
 * Migration Impact"): users.signup_return_to is added as nullable text, with no
 * backfill, so every existing account has no captured page; a re-run adds
 * nothing and keeps a stored page.
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
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0166_signup_return_to.sql"), "utf8");
const P = `t_0166_${randomUUID().slice(0, 8)}_`;

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  client.on("notice", (m) => { if (m.message?.startsWith("[0166]")) notices.push(m.message); });
  try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  return notices;
}

describe("migration 0166: the page a sign-up came from", () => {
  const plain = `${P}plain`;
  const kept = `${P}kept`;
  let rerun: string[] = [];

  before(async () => {
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${plain}, ${`${plain}@test.local`}), (${kept}, ${`${kept}@test.local`})`);
    await db.execute(sql`UPDATE users SET signup_return_to = '/fact/1' WHERE id = ${kept}`);
    rerun = await runMigration();
  });
  after(async () => { await db.execute(sql`DELETE FROM users WHERE id LIKE ${P + "%"}`); });

  it("is nullable text, so no accepted destination is too long", async () => {
    const col = (await db.execute(sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'signup_return_to'`)).rows[0] as { data_type: string; is_nullable: string };
    assert.equal(col.data_type, "text");
    assert.equal(col.is_nullable, "YES");
  });

  it("leaves an account with no captured page null, and a re-run adds nothing and keeps a stored page", async () => {
    const rows = (await db.execute(sql`SELECT id, signup_return_to AS v FROM users WHERE id LIKE ${P + "%"} ORDER BY id`)).rows as { id: string; v: string | null }[];
    assert.equal(rows.find((r) => r.id === plain)!.v, null);
    assert.equal(rows.find((r) => r.id === kept)!.v, "/fact/1");
    assert.match(rerun[0] ?? "", /signup_return_to added=0/);
  });
});
