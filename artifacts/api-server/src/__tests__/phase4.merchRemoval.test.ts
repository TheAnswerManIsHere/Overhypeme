/**
 * Launch Phase 4, removal 4 — merch and Zazzle are gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins two things:
 *   1. Every merch route answers 404 through the whole app: the three Zazzle
 *      meme routes and the three affiliate routes, the admin stats included.
 *   2. Migration 0105 deletes the seven zazzle_* settings and nothing else,
 *      and a re-run is a no-op.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, adminConfigTable } from "@workspace/db/schema";
import { inArray, like, sql } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0105_retire_zazzle.sql"),
  "utf8",
);

const PREFIX = "t_p4r4_";
const ZAZZLE_KEYS = ["zazzle_at", "zazzle_rf", "zazzle_ax", "zazzle_sr", "zazzle_cg", "zazzle_ed", "zazzle_tc"];
const KEPT_KEY = `${PREFIX}kept`;
let adminSid: string;

async function cleanup() {
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, [...ZAZZLE_KEYS, KEPT_KEY]));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  const adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: adminId,
    email: `${adminId}@test.local`,
    isAdmin: true,
    membershipTier: "legendary",
    captchaVerified: true,
  });
  const data: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  adminSid = await createSession(data, adminId);
});

after(cleanup);

describe("merch routes are gone", () => {
  const gone: Array<[method: "get" | "post", url: string]> = [
    ["post", "/api/memes/any-slug/zazzle-export"],
    ["get", "/api/memes/any-slug/zazzle-redirect?source=meme-page"],
    ["get", "/api/memes/any-slug/zazzle-redirect-raw"],
    ["get", "/api/affiliate/zazzle-url"],
    ["post", "/api/affiliate/click"],
    ["get", "/api/affiliate/stats"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url)
        .set("Authorization", `Bearer ${adminSid}`)
        .send({ sourceType: "meme", sourceId: "any-slug", destination: "zazzle" });
      assert.equal(res.status, 404);
    });
  }
});

describe("migration 0105 deletes the Zazzle settings", () => {
  async function seedPreMigrationState() {
    await db.insert(adminConfigTable).values([
      ...ZAZZLE_KEYS.map((key) => ({ key, value: "x", dataType: "string", label: key, isPublic: false })),
      { key: KEPT_KEY, value: "kept", dataType: "string", label: "Kept (test)", isPublic: false },
    ]).onConflictDoNothing();
  }

  async function presentKeys(): Promise<string[]> {
    const rows = await db
      .select({ key: adminConfigTable.key })
      .from(adminConfigTable)
      .where(inArray(adminConfigTable.key, [...ZAZZLE_KEYS, KEPT_KEY]));
    return rows.map((r) => r.key).sort();
  }

  it("deletes all seven zazzle_* rows and keeps every other row", async () => {
    await seedPreMigrationState();
    assert.equal((await presentKeys()).length, 8);
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await presentKeys(), [KEPT_KEY]);
  });

  it("is a no-op on a second run", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.deepEqual(await presentKeys(), [KEPT_KEY]);
  });
});
