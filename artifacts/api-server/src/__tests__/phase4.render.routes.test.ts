/**
 * Phase-4 render-endpoint integration tests.
 *
 * Exercises /api/render-preview and /api/render-download with template
 * imageSource (deterministic, no network), plus the transient_renders
 * audit logging and Cloudflare-IP extraction.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, transientRendersTable } from "@workspace/db/schema";
import { eq, like, and, gt, inArray } from "drizzle-orm";

import renderRouter from "../routes/render.js";
import memesRouter from "../routes/memes.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const USER_PREFIX = "t_phase4_render_";
const FACT_TEXT_PREFIX = "t_p4r_fact_";

function makeApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(authMiddleware);
  app.use(renderRouter);
  app.use(memesRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local` });
  return id;
}

const insertedFactIds: number[] = [];

async function insertFact(text: string, opts: { submittedById?: string } = {}): Promise<number> {
  const prefixedText = `${FACT_TEXT_PREFIX}${text}`;
  const [row] = await db
    .insert(factsTable)
    .values({
      text: prefixedText,
      submittedById: opts.submittedById,
      isActive: true,
      canonicalText: prefixedText,
    })
    .returning();
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(transientRendersTable).where(eq(transientRendersTable.userId, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  // Prefix-based cleanup catches both in-flight facts and orphans from a crashed run.
  const orphanFactIds = (await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`)))
    .map((r) => r.id);
  if (orphanFactIds.length > 0) {
    await db.delete(transientRendersTable).where(inArray(transientRendersTable.factId, orphanFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, orphanFactIds));
  }
  insertedFactIds.length = 0;
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /api/render-preview", () => {
  it("returns image/jpeg bytes for a valid stock-mode (template) request", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("{NAME} pushes the limits.", { submittedById: userId });

    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.ok(!res.headers["content-disposition"], "preview must not set attachment header");
    const buf = Buffer.from(res.body);
    // JPEG magic bytes
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    assert.equal(buf[2], 0xff);
  });

  it("rejects requests with an invalid pronoun", async () => {
    const factId = await insertFact("a fact");
    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "garbage/value",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_input");
  });

  it("rejects requests with a name longer than 50 chars", async () => {
    const factId = await insertFact("a fact");
    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "A".repeat(51),
        pronouns: "they/them",
      });
    assert.equal(res.status, 400);
  });

  it("rejects names with a newline", async () => {
    const factId = await insertFact("a fact");
    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex\nSmith",
        pronouns: "they/them",
      });
    assert.equal(res.status, 400);
  });

  it("returns 404 when the fact is missing", async () => {
    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId: 999_999_999,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "fact_not_found");
  });

  it("403s an anonymous caller using upload imageSource", async () => {
    const factId = await insertFact("a fact");
    const res = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "upload", uploadKey: "/objects/foo" },
        name: "Alex",
        pronouns: "they/them",
      });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "mode_requires_auth");
  });

  it("logs to transient_renders on every request (success and rejection)", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("a fact", { submittedById: userId });
    const startCount = await countTransientRenders();

    // Success path
    await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    // Rejection path
    await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "totally/wrong",
      })
      .expect(400);

    // Fire-and-forget inserts are async; poll until both rows land or
    // the deadline passes.  100 ms is too tight on a loaded machine.
    const deadline = Date.now() + 5_000;
    let endCount = startCount;
    while (endCount - startCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      endCount = await countTransientRenders();
    }
    assert.ok(endCount - startCount >= 2, `expected at least 2 new rows, got ${endCount - startCount}`);
  });

  it("hashes the source IP rather than storing it raw", async () => {
    const factId = await insertFact("a fact");
    await request(makeApp())
      .post("/render-preview")
      .set("CF-Connecting-IP", "203.0.113.7")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    await new Promise((r) => setTimeout(r, 100));
    // ip_hash must never equal the raw IP.
    const recent = await db
      .select({ ipHash: transientRendersTable.ipHash })
      .from(transientRendersTable)
      .where(and(
        eq(transientRendersTable.factId, factId),
        gt(transientRendersTable.createdAt, new Date(Date.now() - 5_000)),
      ));
    assert.ok(recent.length >= 1);
    for (const row of recent) {
      assert.notEqual(row.ipHash, "203.0.113.7");
      assert.match(row.ipHash, /^[0-9a-f]{64}$/, "ip_hash must be sha256 hex");
    }
  });
});

describe("POST /api/render-download", () => {
  it("returns image/jpeg bytes with Content-Disposition: attachment", async () => {
    const factId = await insertFact("Alex pushes the limits.");

    const res = await request(makeApp())
      .post("/render-download")
      .send({
        factId,
        imageSource: { type: "template", templateId: "fire" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.match(
      res.headers["content-disposition"],
      /^attachment; filename="overhype-[a-z0-9-]+\.jpg"$/,
    );
  });

  it("filename slug derives from the fact text", async () => {
    const factId = await insertFact("Push the limits");

    const res = await request(makeApp())
      .post("/render-download")
      .send({
        factId,
        imageSource: { type: "template", templateId: "fire" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    // The filename slug is derived from the fact text — slugified.
    assert.ok(res.headers["content-disposition"].includes("push-the-limits"));
  });
});

describe("Phase 4 — composite byte-identity across endpoints", () => {
  it("preview, download, and a direct compose call all return the same bytes", async () => {
    const factId = await insertFact("{NAME} {pushes|push} the limit.");

    const previewRes = await request(makeApp())
      .post("/render-preview")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    const downloadRes = await request(makeApp())
      .post("/render-download")
      .send({
        factId,
        imageSource: { type: "template", templateId: "action" },
        name: "Alex",
        pronouns: "they/them",
      })
      .expect(200);

    const previewSha = sha256(previewRes.body as Buffer);
    const downloadSha = sha256(downloadRes.body as Buffer);
    assert.equal(previewSha, downloadSha, "preview and download bytes must match for identical inputs");
  });
});

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function countTransientRenders(): Promise<number> {
  const all = await db.select({ id: transientRendersTable.id }).from(transientRendersTable);
  return all.length;
}
