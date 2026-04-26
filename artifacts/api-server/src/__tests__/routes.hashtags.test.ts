/**
 * Integration tests for routes/hashtags.ts.
 *
 * Mounts the router on an ephemeral Express app and drives it via supertest.
 * Talks to the real test DB; cleans up rows tagged with the prefix
 * "t_routes_h_" in afterEach.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { hashtagsTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import hashtagsRouter from "../routes/hashtags.js";

const TAG_PREFIX = "t_routes_h_";

function makeApp(): Express {
  const app = express();
  app.use(hashtagsRouter);
  return app;
}

async function insertTag(name: string, factCount: number): Promise<void> {
  await db.insert(hashtagsTable).values({ name, factCount });
}

async function cleanup(): Promise<void> {
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `${TAG_PREFIX}%`));
}

describe("GET /hashtags", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns hashtags ordered by factCount descending", async () => {
    await insertTag(`${TAG_PREFIX}low`, 1);
    await insertTag(`${TAG_PREFIX}high`, 100);
    await insertTag(`${TAG_PREFIX}mid`, 10);

    const res = await request(makeApp()).get("/hashtags");
    assert.equal(res.status, 200);

    const ours = (res.body.hashtags as Array<{ name: string; factCount: number }>)
      .filter((h) => h.name.startsWith(TAG_PREFIX));
    assert.deepEqual(
      ours.map((h) => h.name),
      [`${TAG_PREFIX}high`, `${TAG_PREFIX}mid`, `${TAG_PREFIX}low`],
    );
  });

  it("filters with case-insensitive LIKE when ?search is provided", async () => {
    await insertTag(`${TAG_PREFIX}Sports`, 5);
    await insertTag(`${TAG_PREFIX}Music`, 5);

    const res = await request(makeApp()).get("/hashtags").query({ search: "SPORT" });
    assert.equal(res.status, 200);

    const names = (res.body.hashtags as Array<{ name: string }>).map((h) => h.name);
    assert.ok(names.includes(`${TAG_PREFIX}Sports`), "Sports should match");
    assert.ok(!names.includes(`${TAG_PREFIX}Music`), "Music should NOT match");
  });

  it("respects ?limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertTag(`${TAG_PREFIX}n${i}`, 100 - i);
    }

    const res = await request(makeApp()).get("/hashtags").query({ limit: "2" });
    assert.equal(res.status, 200);
    assert.equal(res.body.hashtags.length, 2);
  });

  it("returns row shape { id, name, factCount } only — no extra columns leak", async () => {
    await insertTag(`${TAG_PREFIX}only`, 7);

    const res = await request(makeApp()).get("/hashtags").query({ search: TAG_PREFIX });
    const row = (res.body.hashtags as Array<Record<string, unknown>>).find(
      (h) => h.name === `${TAG_PREFIX}only`,
    );
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ["factCount", "id", "name"]);
    assert.equal(row.name, `${TAG_PREFIX}only`);
    assert.equal(row.factCount, 7);
    assert.equal(typeof row.id, "number");
  });
});
