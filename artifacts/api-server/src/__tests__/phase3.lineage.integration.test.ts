/**
 * Phase-3 lineage integration tests.
 *
 * Verifies the /users/me/uploads filters added in Phase 3 work end-to-end
 * against the real test DB, and that the new lineage columns
 * (transform / source_object_path / fact_id / transform_params_hash) on
 * upload_image_metadata persist and round-trip correctly.
 *
 * Test rows are prefixed with USER_PREFIX so they don't collide with
 * other suites running against the same DB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  uploadImageMetadataTable,
  memesTable,
} from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import usersRouter from "../routes/users.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_phase3_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(usersRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: false,
    membershipTier: "registered",
    displayName: null,
  });
  return id;
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
  };
  return createSession(sessionData, userId);
}

async function createTestFact(userId: string): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({ text: `phase3 fact ${randomUUID()}`, submittedById: userId })
    .returning();
  return fact.id;
}

async function cleanup() {
  // Delete child rows first (memes & uploads), then facts, then users.
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(memesTable).where(eq(memesTable.createdById, u.id));
    await db.delete(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("Phase 3 — lineage columns on upload_image_metadata", () => {
  it("the migration added image_transform to memes", async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'memes' AND column_name = 'image_transform'
    `);
    assert.equal(rows.rows.length, 1);
    const col = rows.rows[0] as { data_type: string; character_maximum_length: number | null };
    assert.equal(col.data_type, "character varying");
    assert.equal(col.character_maximum_length, 24);
  });

  it("the migration added all four lineage columns to upload_image_metadata", async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'upload_image_metadata'
        AND column_name IN ('transform','source_object_path','fact_id','transform_params_hash')
      ORDER BY column_name
    `);
    const names = rows.rows.map((r) => r.column_name);
    assert.deepEqual(names, ["fact_id", "source_object_path", "transform", "transform_params_hash"]);
  });

  it("the dedup index exists with the expected predicate", async () => {
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'upload_image_metadata' AND indexname = 'IDX_uim_pulid_dedup'
    `);
    assert.equal(rows.rows.length, 1);
    // Postgres normalizes the predicate; just confirm the discriminating bit.
    assert.match(rows.rows[0]!.indexdef, /transform/);
    assert.match(rows.rows[0]!.indexdef, /'pulid'/);
  });

  it("inserts a raw upload then a PuLID derivative; both round-trip with correct lineage", async () => {
    const userId = await createTestUser();
    const factId = await createTestFact(userId);

    const sourcePath = `t/${randomUUID()}/source.jpg`;
    await db.insert(uploadImageMetadataTable).values({
      objectPath: sourcePath,
      width: 1024,
      height: 1024,
      fileSizeBytes: 12345,
      userId,
      // No lineage fields → raw upload
    });

    const stylingPath = `t/${randomUUID()}/styled.jpg`;
    await db.insert(uploadImageMetadataTable).values({
      objectPath: stylingPath,
      width: 1024,
      height: 1024,
      fileSizeBytes: 23456,
      userId,
      transform: "pulid",
      sourceObjectPath: sourcePath,
      factId,
      transformParamsHash: "deadbeef",
    });

    const rows = await db
      .select()
      .from(uploadImageMetadataTable)
      .where(eq(uploadImageMetadataTable.userId, userId));

    const raw = rows.find((r) => r.objectPath === sourcePath)!;
    const styled = rows.find((r) => r.objectPath === stylingPath)!;
    assert.equal(raw.transform, null);
    assert.equal(raw.factId, null);
    assert.equal(styled.transform, "pulid");
    assert.equal(styled.factId, factId);
    assert.equal(styled.sourceObjectPath, sourcePath);
    assert.equal(styled.transformParamsHash, "deadbeef");
  });

  it("rejects an invalid transform value via CHECK constraint", async () => {
    const userId = await createTestUser();
    await assert.rejects(
      () =>
        db.insert(uploadImageMetadataTable).values({
          objectPath: `t/${randomUUID()}/bad.jpg`,
          width: 1,
          height: 1,
          fileSizeBytes: 1,
          userId,
          transform: "totally-made-up",
        }),
      // Drizzle wraps the underlying pg error; constraint name isn't in the
      // message string. The 23514 code (check_violation) is what we care about.
      (err: unknown) => {
        const e = err as { cause?: { code?: string }; code?: string; message?: string };
        return e?.cause?.code === "23514"
          || e?.code === "23514"
          || /check\s*constraint|uim_transform_chk/i.test(e?.message ?? "");
      },
    );
  });
});

describe("Phase 3 — GET /users/me/uploads filters", () => {
  it("default (no params) returns only raw uploads", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await createTestFact(userId);

    const rawPath = `t/${randomUUID()}/raw.jpg`;
    const aiPath  = `t/${randomUUID()}/ai.jpg`;
    await db.insert(uploadImageMetadataTable).values([
      { objectPath: rawPath, width: 100, height: 100, fileSizeBytes: 1, userId },
      { objectPath: aiPath,  width: 200, height: 200, fileSizeBytes: 2, userId,
        transform: "pulid", sourceObjectPath: rawPath, factId, transformParamsHash: "h" },
    ]);

    const res = await request(makeApp())
      .get("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    const paths: string[] = res.body.uploads.map((u: { objectPath: string }) => u.objectPath);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], rawPath);
  });

  it("transform=ai returns only AI derivatives", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await createTestFact(userId);

    const rawPath = `t/${randomUUID()}/raw.jpg`;
    const pulidPath = `t/${randomUUID()}/p.jpg`;
    const fbPath = `t/${randomUUID()}/f.jpg`;
    await db.insert(uploadImageMetadataTable).values([
      { objectPath: rawPath, width: 1, height: 1, fileSizeBytes: 1, userId },
      { objectPath: pulidPath, width: 1, height: 1, fileSizeBytes: 1, userId,
        transform: "pulid", sourceObjectPath: rawPath, factId, transformParamsHash: "h1" },
      { objectPath: fbPath, width: 1, height: 1, fileSizeBytes: 1, userId,
        transform: "pulid_fallback_text", sourceObjectPath: rawPath, factId, transformParamsHash: "h2" },
    ]);

    const res = await request(makeApp())
      .get("/users/me/uploads?transform=ai")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    const transforms: string[] = res.body.uploads.map((u: { transform: string }) => u.transform);
    transforms.sort();
    assert.deepEqual(transforms, ["pulid", "pulid_fallback_text"]);
  });

  it("transform=pulid + factId scopes to one fact's PuLID stylings", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factA = await createTestFact(userId);
    const factB = await createTestFact(userId);

    const sourcePath = `t/${randomUUID()}/src.jpg`;
    await db.insert(uploadImageMetadataTable).values({
      objectPath: sourcePath, width: 1, height: 1, fileSizeBytes: 1, userId,
    });

    const aPath = `t/${randomUUID()}/A.jpg`;
    const bPath = `t/${randomUUID()}/B.jpg`;
    await db.insert(uploadImageMetadataTable).values([
      { objectPath: aPath, width: 1, height: 1, fileSizeBytes: 1, userId,
        transform: "pulid", sourceObjectPath: sourcePath, factId: factA, transformParamsHash: "ha" },
      { objectPath: bPath, width: 1, height: 1, fileSizeBytes: 1, userId,
        transform: "pulid", sourceObjectPath: sourcePath, factId: factB, transformParamsHash: "hb" },
    ]);

    const res = await request(makeApp())
      .get(`/users/me/uploads?transform=pulid&factId=${factA}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.uploads.length, 1);
    assert.equal(res.body.uploads[0].objectPath, aPath);
    assert.equal(res.body.uploads[0].factId, factA);
  });

  it("transform=all returns raw + AI rows together", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await createTestFact(userId);

    const rawPath = `t/${randomUUID()}/raw.jpg`;
    const aiPath = `t/${randomUUID()}/ai.jpg`;
    await db.insert(uploadImageMetadataTable).values([
      { objectPath: rawPath, width: 1, height: 1, fileSizeBytes: 1, userId },
      { objectPath: aiPath, width: 1, height: 1, fileSizeBytes: 1, userId,
        transform: "pulid", sourceObjectPath: rawPath, factId, transformParamsHash: "h" },
    ]);

    const res = await request(makeApp())
      .get("/users/me/uploads?transform=all")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.uploads.length, 2);
  });

  it("response shape includes the four new lineage fields", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(uploadImageMetadataTable).values({
      objectPath: `t/${randomUUID()}/r.jpg`,
      width: 1, height: 1, fileSizeBytes: 1, userId,
    });

    const res = await request(makeApp())
      .get("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    const row = res.body.uploads[0];
    assert.ok("transform" in row, "transform field must be present");
    assert.ok("sourceObjectPath" in row, "sourceObjectPath field must be present");
    assert.ok("factId" in row, "factId field must be present");
    assert.ok("transformParamsHash" in row, "transformParamsHash field must be present");
  });
});

describe("Phase 3 — memes.image_transform", () => {
  it("accepts NULL, 'pulid', and 'pulid_fallback_text' but rejects garbage", async () => {
    const userId = await createTestUser();
    const factId = await createTestFact(userId);
    const slug = () => randomUUID().replace(/-/g, "").slice(0, 12);

    // Three valid inserts.
    await db.insert(memesTable).values([
      { factId, templateId: "tpl", imageUrl: "https://e/a.jpg", permalinkSlug: slug(), createdById: userId, imageTransform: null },
      { factId, templateId: "tpl", imageUrl: "https://e/b.jpg", permalinkSlug: slug(), createdById: userId, imageTransform: "pulid" },
      { factId, templateId: "tpl", imageUrl: "https://e/c.jpg", permalinkSlug: slug(), createdById: userId, imageTransform: "pulid_fallback_text" },
    ]);

    // One invalid insert.
    await assert.rejects(
      () =>
        db.insert(memesTable).values({
          factId,
          templateId: "tpl",
          imageUrl: "https://e/x.jpg",
          permalinkSlug: slug(),
          createdById: userId,
          imageTransform: "not-a-real-transform",
        }),
      (err: unknown) => {
        const e = err as { cause?: { code?: string }; code?: string; message?: string };
        return e?.cause?.code === "23514"
          || e?.code === "23514"
          || /check\s*constraint|memes_image_transform_chk/i.test(e?.message ?? "");
      },
    );
  });
});
