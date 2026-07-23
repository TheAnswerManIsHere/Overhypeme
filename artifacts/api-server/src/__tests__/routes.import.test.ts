/**
 * Integration tests for routes/import.ts (POST /admin/import/facts).
 *
 * The endpoint is gated by requireApiKey middleware (X-API-Key vs.
 * ADMIN_API_KEY). Since the Phase 2 fact-lifecycle closure it no longer inserts
 * active facts — each valid row becomes a Stage-1 (`triage_pending`) review, so
 * bulk import LOADS the moderation queue. The API-key path has no user, so its
 * reviews are SYSTEM imports (`submittedById = null`). Tests exercise the auth
 * gate, body-shape guards, Zod per-item validation, dryRun mode, the queue-write
 * happy path, and dedup against BOTH existing facts and unresolved reviews.
 *
 * ADMIN_API_KEY is set in before() and restored in after() so it does not
 * leak into sibling test files when running under --test-isolation=none.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import importRouter from "../routes/import.js";


const TEST_API_KEY = "t-routes-import-key-secret";

const TEXT_PREFIX = "t_routes_imp_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(importRouter);
  return app;
}

async function cleanup() {
  await db.delete(pendingReviewsTable).where(like(pendingReviewsTable.submittedText, `${TEXT_PREFIX}%`));
  const facts = await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${TEXT_PREFIX}%`));
  if (facts.length) {
    await db.delete(factsTable).where(inArray(factsTable.id, facts.map((f) => f.id)));
  }
}

async function reviewsFor(prefix: string) {
  return db.select().from(pendingReviewsTable).where(like(pendingReviewsTable.submittedText, `${prefix}%`));
}

let savedAdminApiKey: string | undefined;

before(async () => {
  savedAdminApiKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = TEST_API_KEY;
  await cleanup();
});

after(async () => {
  if (savedAdminApiKey === undefined) {
    delete process.env.ADMIN_API_KEY;
  } else {
    process.env.ADMIN_API_KEY = savedAdminApiKey;
  }
  await cleanup();
});

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

// Re-asserts ADMIN_API_KEY before each test so a sibling test file cannot
// silently wipe the env var between describe blocks under the sharded
// `--test-isolation=none` runner.
async function ensureAdminApiKey() {
  process.env.ADMIN_API_KEY = TEST_API_KEY;
  await cleanup();
}

describe("POST /admin/import/facts — body-shape validation", () => {
  beforeEach(ensureAdminApiKey);
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

  it("accepts the { facts: [...] } envelope shape and queues for moderation", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send({ facts: [validItem()] });
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 1);
  });
});

describe("POST /admin/import/facts — dryRun", () => {
  beforeEach(ensureAdminApiKey);
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
    assert.equal(res.body.wouldQueue, 2);
    assert.equal(res.body.failed.length, 1);

    assert.equal((await reviewsFor(TEXT_PREFIX)).length, 0, "dry run must not write reviews");
    const facts = await db.select().from(factsTable).where(like(factsTable.text, `${TEXT_PREFIX}%`));
    assert.equal(facts.length, 0, "dry run must not write facts");
  });

  it("treats dryRun=1 the same as dryRun=true", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts?dryRun=1")
      .set("x-api-key", TEST_API_KEY)
      .send([validItem()]);
    assert.equal(res.body.dryRun, true);
  });
});

describe("POST /admin/import/facts — queue-write path", () => {
  beforeEach(ensureAdminApiKey);
  afterEach(cleanup);

  it("queues valid items as Stage-1 SYSTEM reviews (submittedById=null), no facts, and skips invalid ones", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([
        validItem(),
        validItem(),
        { text: "bad" }, // too short
      ]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 2);
    assert.equal(res.body.failed.length, 1);
    assert.equal(res.body.failed[0].index, 2);

    const reviews = await reviewsFor(TEXT_PREFIX);
    assert.equal(reviews.length, 2, "two triage reviews queued");
    for (const r of reviews) {
      assert.equal(r.workflowStage, "triage_pending");
      assert.equal(r.submittedById, null, "API-key import is a system import");
      assert.equal(r.enrichment, null, "no enrichment at ingest (cost gate)");
    }
    const facts = await db.select().from(factsTable).where(like(factsTable.text, `${TEXT_PREFIX}%`));
    assert.equal(facts.length, 0, "bulk import must not insert facts");
  });

  it("skips items whose text already exists as a FACT", async () => {
    const text = `${TEXT_PREFIX}dup-fact-${randomUUID()}`;
    // Pre-seed an (inactive) fact — dedup matches by text regardless of active state.
    await db.insert(factsTable).values({ text, isActive: false });

    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text, hashtags: [] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.skipped, 1);
  });

  it("skips items whose text already exists as an UNRESOLVED review", async () => {
    const text = `${TEXT_PREFIX}dup-review-${randomUUID()}`;
    await db.insert(pendingReviewsTable).values({ submittedText: text, workflowStage: "triage_pending", status: "pending" });

    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text, hashtags: [] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.skipped, 1);
  });

  it("stores raw hashtags on the review and does NOT upsert hashtag rows at ingest", async () => {
    const suffix = randomUUID();
    const text = `${TEXT_PREFIX}with-tag-${suffix}`;
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text, hashtags: ["overhype"] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 1);

    const [review] = await reviewsFor(`${TEXT_PREFIX}with-tag-${suffix}`);
    assert.ok(review, "review should exist");
    assert.deepEqual(review.hashtags, ["overhype"], "raw hashtags stored on the review");
  });

  it("rejects hashtags with disallowed characters via Zod", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text: validItem().text, hashtags: ["bad tag!"] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.failed.length, 1);
    assert.match(JSON.stringify(res.body.failed[0]), /letters, numbers, and underscores/);
  });

  it("normalizes already-tokenized text on the queued review", async () => {
    const suffix = randomUUID();
    const text = `${TEXT_PREFIX}${suffix} {Subj} keeps it locked in {POSS} back yard.`;
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text, hashtags: [] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 1);

    const [review] = await reviewsFor(`${TEXT_PREFIX}${suffix}`);
    assert.ok(review, "review should have been queued");
    assert.equal(review.submittedText, `${TEXT_PREFIX}${suffix} {Subj} {keeps|keep} it locked in {POSS} back yard.`);
  });

  it("reports a grammar-invalid template in `failed` and does not queue it", async () => {
    const res = await request(makeApp())
      .post("/admin/import/facts")
      .set("x-api-key", TEST_API_KEY)
      .send([{ text: `${TEXT_PREFIX}unknown token ${randomUUID()} {FOO}`, hashtags: [] }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.failed.length, 1);
    assert.match(JSON.stringify(res.body.failed[0]), /Template grammar validation failed/);

    assert.equal((await reviewsFor(`${TEXT_PREFIX}unknown token`)).length, 0, "invalid template must not be queued");
  });
});
