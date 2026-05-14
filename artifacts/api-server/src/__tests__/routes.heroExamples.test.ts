/**
 * MBFO-2: GET /api/hero-examples integration tests.
 *
 * Covers:
 *   - empty table → empty arrays for both keys
 *   - active rows returned, inactive excluded
 *   - ordering by sort_order then id
 *   - artifact_type filter narrows the response
 *   - invalid artifact_type → 400
 *   - no auth required (works unauthenticated)
 *   - row cap (MAX_PER_TYPE = 10)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import request from "supertest";

import { db } from "@workspace/db";
import { heroExamplesTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import heroExamplesRouter from "../routes/heroExamples.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "t2he";

async function cleanup() {
  await db.delete(heroExamplesTable).where(like(heroExamplesTable.assetUrl, `${PREFIX}%`));
}

async function insertRow(args: {
  artifactType: "image" | "video";
  suffix: string;
  sortOrder?: number;
  active?: boolean;
  posterUrl?: string | null;
  captionLabel?: string;
}): Promise<number> {
  const [row] = await db
    .insert(heroExamplesTable)
    .values({
      artifactType: args.artifactType,
      assetUrl: `${PREFIX}${args.suffix}`,
      posterUrl: args.posterUrl ?? null,
      captionLabel: args.captionLabel ?? "",
      sortOrder: args.sortOrder ?? 0,
      active: args.active ?? true,
    })
    .returning({ id: heroExamplesTable.id });
  return row.id;
}

before(async () => {
  await cleanup();
});

after(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

describe("GET /api/hero-examples — empty state", () => {
  it("returns empty arrays for both keys when no rows exist", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { image: [], video: [] });
  });
});

describe("GET /api/hero-examples — active filter", () => {
  it("excludes inactive rows", async () => {
    await insertRow({ artifactType: "image", suffix: "active01", active: true });
    await insertRow({ artifactType: "image", suffix: "inactive01", active: false });

    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples");

    assert.equal(res.status, 200);
    assert.equal(res.body.image.length, 1);
    assert.equal(res.body.image[0].assetUrl, `${PREFIX}active01`);
  });
});

describe("GET /api/hero-examples — ordering", () => {
  it("orders by sort_order asc, then id asc", async () => {
    const a = await insertRow({ artifactType: "image", suffix: "ord-a", sortOrder: 10 });
    const b = await insertRow({ artifactType: "image", suffix: "ord-b", sortOrder: 5 });
    const c = await insertRow({ artifactType: "image", suffix: "ord-c", sortOrder: 5 });

    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples");

    const ids = res.body.image.map((r: { id: number }) => r.id);
    // b (sort=5, lowest id) → c (sort=5, higher id) → a (sort=10)
    assert.deepEqual(ids, [b, c, a]);
  });
});

describe("GET /api/hero-examples — artifact_type filter", () => {
  it("filtered request returns only the requested key", async () => {
    await insertRow({ artifactType: "image", suffix: "img01" });
    await insertRow({ artifactType: "video", suffix: "vid01" });

    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples?artifact_type=video");

    assert.equal(res.status, 200);
    assert.equal(res.body.image, undefined);
    assert.equal(res.body.video.length, 1);
    assert.equal(res.body.video[0].assetUrl, `${PREFIX}vid01`);
  });

  it("rejects an unknown artifact_type with 400", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples?artifact_type=audio");
    assert.equal(res.status, 400);
  });
});

describe("GET /api/hero-examples — shape", () => {
  it("returns DTO with id, artifactType, assetUrl, posterUrl, captionLabel", async () => {
    await insertRow({
      artifactType: "video",
      suffix: "shape01",
      posterUrl: `${PREFIX}poster01`,
      captionLabel: "Hello",
    });

    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples?artifact_type=video");

    assert.equal(res.body.video.length, 1);
    const dto = res.body.video[0];
    assert.equal(typeof dto.id, "number");
    assert.equal(dto.artifactType, "video");
    assert.equal(dto.assetUrl, `${PREFIX}shape01`);
    assert.equal(dto.posterUrl, `${PREFIX}poster01`);
    assert.equal(dto.captionLabel, "Hello");
  });
});

describe("GET /api/hero-examples — cap", () => {
  it("returns at most 10 rows per type", async () => {
    for (let i = 0; i < 12; i++) {
      await insertRow({ artifactType: "image", suffix: `cap${i}`, sortOrder: i });
    }

    const app = buildTestApp({ kind: "unauthenticated" }, heroExamplesRouter);
    const res = await request(app).get("/api/hero-examples?artifact_type=image");

    assert.equal(res.body.image.length, 10);
  });
});
