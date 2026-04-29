/**
 * Integration tests for routes/import.ts (POST /admin/import/facts).
 *
 * The endpoint is gated by requireApiKey middleware (X-API-Key vs.
 * ADMIN_API_KEY). Tests exercise the auth gate, the body-shape guards,
 * Zod per-item validation, dryRun mode, and the real-write happy path
 * including the exact-text dedup against existing rows.
 *
 * Sets ADMIN_API_KEY at module load so the auth middleware is configured.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

const TEST_API_KEY = "t-routes-import-key-secret";
process.env.ADMIN_API_KEY = TEST_API_KEY;

import importRouter from "../routes/import.js";

const TEXT_PREFIX = "t_routes_imp_";
const HASHTAG_PREFIX = "t_routes_imp_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(importRouter);
  return app;
}

async function cleanup() {
  // factHashtags cascades on facts delete. Hashtags cleaned up by name prefix.
  const facts = await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${TEXT_PREFIX}%`));
  if (facts.length) {
    await db.delete(factsTable).where(inArray(factsTable.id, facts.map((f) => f.id)));
  }
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `${HASHTAG_PREFIX}%`));
}

before(cleanup);
after(cleanup);

const validItem = (suffix = randomUUID()) => ({
  text: `${TEXT_PREFIX}sample fact ${suffix}`,
  hashtags: [],
});

describe("POST /admin/import/facts — auth gate", () => {
  it("returns 401 when X-API-Key is missing", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .send([validItem()]);
    assert.equal(res.status, 401);
  });

  it("returns 401 when X-API-Key is wrong", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", "WRONG")
      .send([validItem()]);
    assert.equal(res.status, 401);
  });
});

describe("POST /admin/import/facts — body-shape validation", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("rejects bodies that are neither an array nor an { facts: [] } object", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send({ wrong: "shape" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /JSON array/);
  });

  it("rejects an empty array", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([]);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must not be empty/);
  });

  it("rejects more than 500 items", async () => {
    const arr = Array.from({ length: 501 }, () => validItem());
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send(arr);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Maximum 500/);
  });

  it("accepts the { facts: [...] } envelope shape", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send({ facts: [validItem()] });
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 1);
  });
});

describe("POST /admin/import/facts — dryRun", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("validates without writing when dryRun=true", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts?dryRun=true")
      .set("x-api-key", TEST_API_KEY)
      .send([
        validItem(),
        validItem(),
        // invalid — too short
        { text: "short" },
      ]);
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.wouldCreate, 2);
    assert.equal(res.body.failed.length, 1);

    const facts = await db
      .select()
      .from(factsTable)
      .where(like(factsTable.text, `${TEXT_PREFIX}%`));
    assert.equal(facts.length, 0, "dry run must not write");
  });

  it("treats dryRun=1 the same as dryRun=true", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts?dryRun=1")
      .set("x-api-key", TEST_API_KEY)
      .send([validItem()]);
    assert.equal(res.body.dryRun, true);
  });
});

describe("POST /admin/import/facts — write path", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("inserts the valid items, returns 201 with counts, and skips invalid ones", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([
        validItem(),
        validItem(),
        { text: "bad" }, // too short
      ]);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 2);
    assert.equal(res.body.failed.length, 1);
    assert.equal(res.body.failed[0].index, 2);
  });

  it("skips items whose text already exists in the DB", async () => {
    const text = `${TEXT_PREFIX}duplicate-${randomUUID()}`;
    // Pre-seed
    await db.insert(factsTable).values({ text, isActive: true });

    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text, hashtags: [] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 0);
    assert.equal(res.body.skipped, 1);
  });

  it("creates and links hashtags for inserted facts", async () => {
    const tag = `${HASHTAG_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text: `${TEXT_PREFIX}with-tag-${randomUUID()}`, hashtags: [tag] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 1);

    const [hashtag] = await db
      .select()
      .from(hashtagsTable)
      .where(eq(hashtagsTable.name, tag.toLowerCase()));
    assert.ok(hashtag, "hashtag row should exist");
    assert.equal(hashtag.factCount, 1);

    const links = await db
      .select()
      .from(factHashtagsTable)
      .where(eq(factHashtagsTable.hashtagId, hashtag.id));
    assert.equal(links.length, 1);
  });

  it("rejects hashtags with disallowed characters via Zod", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text: validItem().text, hashtags: ["bad tag!"] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 0);
    assert.equal(res.body.failed.length, 1);
    assert.match(JSON.stringify(res.body.failed[0]), /letters, numbers, and underscores/);
  });
});
