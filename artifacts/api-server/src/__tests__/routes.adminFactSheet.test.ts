/**
 * The fact sheet's server side (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
 * items 18–20, design 3A; Issue #1018, the increment 3.1 outline):
 *
 *   - GET /admin/facts/:id/sheet opens an approved fact, live or deactivated,
 *     and is a 404 for a staging fact; it carries the Overview's groups, the
 *     hashtags, the note with the research it was written from, and the
 *     fact's attention reasons;
 *   - PUT /admin/facts/:id/hashtags replaces the hashtags at once, keeps each
 *     hashtag's fact count, refuses an empty list, and records what changed;
 *   - PUT /admin/facts/:id/humor-note saves at once, records it, and asks for
 *     no gag ideas (no `gag_ideas_requested` record and no queued job);
 *   - both edits refuse a staging fact, and an unchanged save records nothing.
 *
 * 401/403 coverage is in routes.admin.auth.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import {
  factsTable,
  usersTable,
  adminActionsTable,
  hashtagsTable,
  factHashtagsTable,
  factReadingsTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const RUN = randomUUID().slice(0, 8);
const USER_PREFIX = "tfactsheet-";
const TAG = (s: string) => `fs${RUN}${s}`.toLowerCase();

let adminId = "";
let app: Express;
const factIds: number[] = [];

async function liveFact(extra: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const f = await insertLiveFact({
    text: `{NAME} sheet ${RUN} ${randomUUID().slice(0, 6)}`,
    enrichment: buildPlaceholderFactEnrichment(),
    submittedById: adminId,
    upvotes: 4, downvotes: 1,
    ...extra,
  } as never, buildPlaceholderGag());
  factIds.push(f.id);
  return f.id;
}

async function stagingFact(): Promise<number> {
  const [f] = await db.insert(factsTable).values({ text: `{NAME} staged ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false }).returning({ id: factsTable.id });
  factIds.push(f!.id);
  return f!.id;
}

async function tagsOf(factId: number): Promise<string[]> {
  const rows = await db.select({ name: hashtagsTable.name }).from(factHashtagsTable)
    .innerJoin(hashtagsTable, eq(hashtagsTable.id, factHashtagsTable.hashtagId))
    .where(eq(factHashtagsTable.factId, factId));
  return rows.map((r) => r.name).sort();
}

async function factCount(name: string): Promise<number> {
  const [row] = await db.select({ n: hashtagsTable.factCount }).from(hashtagsTable).where(eq(hashtagsTable.name, name));
  return row?.n ?? 0;
}

async function actions(factId: number, action: string) {
  return db.select().from(adminActionsTable).where(and(eq(adminActionsTable.factId, factId), eq(adminActionsTable.action, action)));
}

before(async () => {
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, displayName: "Sheet Admin", membershipTier: "registered", isAdmin: true });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
});

after(async () => {
  if (factIds.length) {
    await db.delete(adminActionsTable).where(inArray(adminActionsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `fs${RUN}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});

describe("GET /admin/facts/:id/sheet", () => {
  it("opens a live fact with its groups, hashtags, note, research and reasons", async () => {
    const factId = await liveFact({ humorNote: "The joke is the scale." });
    const [reading] = await db.insert(factReadingsTable).values({
      factId, status: "ok", draftNote: "draft", research: { references: [] } as never, completedAt: new Date(),
    }).returning({ id: factReadingsTable.id });
    await db.update(factsTable).set({ humorNoteReadingId: reading!.id, humorNoteApprovedBy: adminId, humorNoteApprovedAt: new Date() }).where(eq(factsTable.id, factId));
    // A later run does not replace the research the note was written from.
    await db.insert(factReadingsTable).values({ factId, status: "ok", draftNote: "later", research: { references: [] } as never });
    const put = await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [TAG("alpha")] });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const res = await request(app).get(`/api/admin/facts/${factId}/sheet`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.equal(b.id, factId);
    assert.equal(b.isActive, true);
    assert.equal(b.approvalSource, "legacy");
    assert.equal(typeof b.approvedAt, "string");
    assert.equal(b.submittedByName, "Sheet Admin");
    assert.equal(b.upvotes, 4);
    assert.deepEqual(b.usage, { memes: 0, aiPictures: 0, comments: 0 });
    assert.deepEqual(b.hashtags, [TAG("alpha")]);
    assert.equal(b.reading.approved.text, "The joke is the scale.");
    assert.equal(b.reading.approvedByName, "Sheet Admin");
    assert.equal(b.reading.latest.id, reading!.id, "the research shown is the run the note was written from");
    // The fixture's gag is carried over without examples: its set is missing.
    assert.equal(b.pictures.length, 1);
    assert.equal(b.pictures[0].approvedKinds.length, 0);
    assert.ok(b.attention.includes("example_missing"));
    assert.ok(!("embedding" in b));
  });

  it("opens a deactivated fact", async () => {
    const factId = await liveFact();
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    const res = await request(app).get(`/api/admin/facts/${factId}/sheet`);
    assert.equal(res.status, 200);
    assert.equal(res.body.isActive, false);
  });

  it("is a 404 for a staging fact and for an unknown id, and a 400 for a bad id", async () => {
    const staged = await stagingFact();
    assert.equal((await request(app).get(`/api/admin/facts/${staged}/sheet`)).status, 404);
    assert.equal((await request(app).get(`/api/admin/facts/2147483000/sheet`)).status, 404);
    assert.equal((await request(app).get(`/api/admin/facts/abc/sheet`)).status, 400);
  });
});

describe("PUT /admin/facts/:id/hashtags", () => {
  it("replaces the hashtags at once, keeps fact counts and records what changed", async () => {
    const factId = await liveFact();
    let res = await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [TAG("one"), TAG("two")] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await tagsOf(factId), [TAG("one"), TAG("two")]);
    assert.equal(await factCount(TAG("one")), 1);

    res = await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [TAG("two"), TAG("three")] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.hashtags, [TAG("three"), TAG("two")]);
    assert.deepEqual(await tagsOf(factId), [TAG("three"), TAG("two")]);
    assert.equal(await factCount(TAG("one")), 0, "a removed tag's count drops");
    assert.equal(await factCount(TAG("two")), 1, "a kept tag's count is unchanged");

    const rows = await actions(factId, "hashtags_save");
    assert.equal(rows.length, 2);
    const last = rows.sort((a, b) => a.id - b.id)[1]!;
    assert.equal(last.actorId, adminId);
    assert.deepEqual(last.detail, { added: [TAG("three")], removed: [TAG("one")] });
  });

  it("an unchanged list records nothing; an empty or all-denied list is refused", async () => {
    const factId = await liveFact();
    await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [TAG("same")] });
    await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [`#${TAG("same")}`] });
    assert.equal((await actions(factId, "hashtags_save")).length, 1);

    for (const hashtags of [[], ["overhype"]]) {
      const res = await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags });
      assert.equal(res.status, 400, JSON.stringify(hashtags));
    }
    assert.deepEqual(await tagsOf(factId), [TAG("same")]);
  });

  it("refuses a staging fact", async () => {
    const staged = await stagingFact();
    const res = await request(app).put(`/api/admin/facts/${staged}/hashtags`).send({ hashtags: [TAG("x")] });
    assert.equal(res.status, 404);
    assert.deepEqual(await tagsOf(staged), []);
  });
});

describe("PUT /admin/facts/:id/humor-note", () => {
  it("saves at once, records who, and asks for no gag ideas", async () => {
    const factId = await liveFact({ humorNote: "Old note." });
    const jobsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(asyncJobsTable).where(sql`${asyncJobsTable.payload} ->> 'factId' = ${String(factId)}`);

    const res = await request(app).put(`/api/admin/facts/${factId}/humor-note`).send({ text: "New note." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.humorNote.text, "New note.");

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(fact!.humorNote, "New note.");
    assert.equal(fact!.humorNoteApprovedBy, adminId);
    const rows = await actions(factId, "humor_note_save");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.detail, { text: "New note.", from: "Old note." });
    assert.equal((await actions(factId, "gag_ideas_requested")).length, 0);
    const jobsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(asyncJobsTable).where(sql`${asyncJobsTable.payload} ->> 'factId' = ${String(factId)}`);
    assert.equal(jobsAfter[0]!.n, jobsBefore[0]!.n, "no job was queued");

    // The same note again records nothing.
    await request(app).put(`/api/admin/facts/${factId}/humor-note`).send({ text: "New note." });
    assert.equal((await actions(factId, "humor_note_save")).length, 1);
  });

  it("refuses an empty note and a staging fact", async () => {
    const factId = await liveFact();
    assert.equal((await request(app).put(`/api/admin/facts/${factId}/humor-note`).send({ text: "  " })).status, 400);
    const staged = await stagingFact();
    assert.equal((await request(app).put(`/api/admin/facts/${staged}/humor-note`).send({ text: "Note." })).status, 404);
  });
});
