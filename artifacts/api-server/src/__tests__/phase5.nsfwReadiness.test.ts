/**
 * @purpose T8 and 0121, NSFW readiness with nothing shipped (launch Phase 5, intent item 9, S13): the profile and admin edits ignore the withdrawn NSFW opt-in, every classifier call is told false whatever the column holds, and migration 0121 gives content an `audience` ('general' by default, 'adult' the only other value), accounts a dormant `adult_verified_at`, and the grid a `beta_overlay` feature off for every tier, idempotently.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like, sql } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import usersRouter from "../routes/users.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { getAllTierFeatureMatrix, GRID_TIERS } from "../lib/featureAccess.js";

const PREFIX = "t-p5nsfw-";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../lib/db/migrations/0121_nsfw_readiness.sql");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", usersRouter, adminRouter);
  return app;
}

async function createUser(opts: { admin?: boolean } = {}): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, displayName: "Member", pronouns: "they/them",
    emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), dateOfBirth: "1990-01-01",
    isAdmin: opts.admin ?? false,
  });
  return id;
}

const sessionFor = (userId: string, isAdmin = false) =>
  createSession({ user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin } as SessionData, userId);

/** Migration 0122 (Increment 7c) dropped the column, so nothing a body sends can land anywhere. */
const nsfwColumnExists = async (): Promise<boolean> =>
  (await db.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'nsfw_mode_enabled'`)).rows.length > 0;

describe("the NSFW opt-in is withdrawn (T8)", () => {
  const cleanup = () => db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
  before(cleanup);
  after(cleanup);

  it("the profile edit ignores nsfwModeEnabled", async () => {
    const id = await createUser();
    const sid = await sessionFor(id);
    const res = await request(makeApp()).patch("/api/users/me").set("authorization", `Bearer ${sid}`).send({ nsfwModeEnabled: true });
    assert.ok(res.status < 500, res.text);
    assert.equal(await nsfwColumnExists(), false);
  });

  it("the admin edit ignores nsfwModeEnabled", async () => {
    const admin = await createUser({ admin: true });
    const member = await createUser();
    const sid = await sessionFor(admin, true);
    const res = await request(makeApp()).patch(`/api/admin/users/${member}`).set("authorization", `Bearer ${sid}`).send({ nsfwModeEnabled: true });
    assert.ok(res.status < 500, res.text);
    assert.equal(await nsfwColumnExists(), false);
  });

  it("every classifier call is told false, whatever an account's old column holds", () => {
    // The two callers (upload and meme generation) pass a literal false; no
    // code outside the classifier module reads the column any more.
    const src = path.resolve(here, "..");
    const files = fs.readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.startsWith("__tests__") && !f.includes("moderation/nsfwClassifier") && !f.includes("testing/legacyFixture"));
    const calls: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      for (const m of text.matchAll(/classifyAndDecide\([^)]*\)/g)) calls.push(`${f}: ${m[0]}`);
      for (const line of text.split("\n")) {
        if (/nsfwModeEnabled/.test(line) && !/nsfwModeEnabled: false/.test(line) && !/^\s*\/\//.test(line)) {
          assert.fail(`${f} still reads the withdrawn opt-in: ${line.trim()}`);
        }
      }
    }
    assert.ok(calls.length >= 2, `the upload and meme-generation callers are found:\n${calls.join("\n")}`);
    for (const c of calls) assert.match(c, /\{ nsfwModeEnabled: false \}\)$/, c);
  });
});

describe("0121: audience, adult verification and the beta overlay, all dormant", () => {
  it("content defaults to the general audience, and only general or adult is accepted", async () => {
    for (const table of ["facts", "memes", "user_ai_images"]) {
      const { rows } = await db.execute<{ column_default: string; is_nullable: string }>(sql`
        SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'audience'`);
      assert.equal(rows.length, 1, `${table}.audience exists`);
      assert.match(String(rows[0]!.column_default), /'general'/, `${table}.audience defaults to general`);
      assert.equal(rows[0]!.is_nullable, "NO");
      const { rows: checks } = await db.execute<{ def: string }>(sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = ${`${table}_audience_check`} AND conrelid = ${table}::regclass`);
      assert.equal(checks.length, 1, `${table} carries its audience check`);
      assert.match(checks[0]!.def, /general/);
      assert.match(checks[0]!.def, /adult/);
    }
    const { rows } = await db.execute<{ data_type: string }>(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'adult_verified_at'`);
    assert.equal(rows[0]?.data_type, "timestamp with time zone");
  });

  it("the beta overlay is in the grid, off for every tier, and a second run changes nothing", async () => {
    const before = await db.execute<{ revision: string }>(sql`SELECT revision FROM entitlement_grid_revision WHERE id = 1`);
    await db.execute(sql.raw(fs.readFileSync(MIGRATION, "utf8")));
    const after = await db.execute<{ revision: string }>(sql`SELECT revision FROM entitlement_grid_revision WHERE id = 1`);
    assert.equal(String(after.rows[0]!.revision), String(before.rows[0]!.revision), "a re-run does not bump the grid");

    const { features, permissions } = await getAllTierFeatureMatrix();
    assert.equal(features.filter((f) => f.key === "beta_overlay").length, 1);
    const rows = permissions.filter((p) => p.featureKey === "beta_overlay");
    assert.deepEqual(rows.map((r) => r.tier).sort(), [...GRID_TIERS].sort());
    assert.ok(rows.every((r) => r.enabled === false), "off for every tier");
  });
});
