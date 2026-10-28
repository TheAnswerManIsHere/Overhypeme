/**
 * Launch Phase 4, removal 9 — the route-visit counters are gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins two things:
 *   1. The public counter routes and the admin read answer 404 through the
 *      whole app, even to an admin.
 *   2. Migration 0109 drops route_stats and route_stat_events, and a re-run is
 *      a no-op.
 *
 * The test database is built from the schema baseline, whose cutoff is past
 * 0109, so both tables are already absent here. The migration case recreates them first, which is
 * the state the Repl's dev database is in when 0109 runs there.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like, sql } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0109_retire_route_stats.sql"),
  "utf8",
);

const PREFIX = "t_p4r9_";
let adminSid: string;

async function tablesLeft(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name IN ('route_stats', 'route_stat_events')
     ORDER BY table_name`);
  return (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
}

async function cleanup() {
  await db.execute(sql`DROP TABLE IF EXISTS route_stat_events`);
  await db.execute(sql`DROP TABLE IF EXISTS route_stats`);
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  const adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", captchaVerified: true });
  const data: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  adminSid = await createSession(data, adminId);
});

after(cleanup);

describe("the route-visit counter routes are gone", () => {
  const gone: Array<[method: "get" | "post", url: string]> = [
    ["get", "/api/route-stats?n=3"],
    ["post", "/api/route-stats"],
    ["get", "/api/admin/route-stats"],
    ["get", "/api/admin/route-stats?since=7d"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url)
        .set("Authorization", `Bearer ${adminSid}`)
        .send({ route: "home" });
      assert.equal(res.status, 404);
    });
  }
});

describe("migration 0109 drops the counter tables", () => {
  it("drops both tables, rows and all", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS route_stats (
        route_key varchar(50) PRIMARY KEY NOT NULL,
        visit_count integer NOT NULL DEFAULT 0,
        updated_at timestamp with time zone NOT NULL DEFAULT now())`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS route_stat_events (
        id serial PRIMARY KEY,
        route_key varchar(50) NOT NULL,
        delta integer NOT NULL DEFAULT 1,
        recorded_at timestamp with time zone NOT NULL DEFAULT now())`);
    await db.execute(sql`INSERT INTO route_stats (route_key, visit_count) VALUES ('home', 3), ('search', 1)`);
    await db.execute(sql`INSERT INTO route_stat_events (route_key, delta) VALUES ('home', 3), ('search', 1)`);
    assert.deepEqual(await tablesLeft(), ["route_stat_events", "route_stats"], "the premise: both tables exist");

    await db.execute(sql.raw(MIGRATION_SQL));

    assert.deepEqual(await tablesLeft(), [], "both tables are dropped");
  });

  it("is a no-op on a second run", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await tablesLeft(), []);
  });
});
