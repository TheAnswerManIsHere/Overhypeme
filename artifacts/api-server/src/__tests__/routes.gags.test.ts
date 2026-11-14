/**
 * The gag lifecycle through its routes (plan docs/plans/PLAN_THREE_GAGS.md,
 * Testing Plan items 5, 6, 7, 9 and 10):
 *
 *   - a saved change is hidden: users keep the approved version until a test
 *     render of the change is approved as its example;
 *   - approval refuses another gag's render, an unfinished or failed one, a
 *     styled one and one drawn from other content, and accepts the rest;
 *   - every slot follows the same rules;
 *   - discard and remove, and the last approved gag of a live fact kept;
 *   - during a refresh, gags change only inside its review, and its pick or
 *     removal lands at promotion or is dropped on decline;
 *   - saving, discarding and removing enqueue nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, factEnrichmentVersionsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq, gte, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import gagsRouter from "../routes/gags.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { availableGags, primaryGag } from "../lib/gags/resolver.js";
import { applyReviewGagOps, cancelReviewGagOps } from "../lib/gags/gagStore.js";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (approved).");

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function liveFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} gags test ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A test render of `gagId` that drew `content`; finished unless told otherwise. */
async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, opts: { unfinished?: boolean; failed?: boolean; styled?: boolean } = {}): Promise<number> {
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: (opts.styled ? { styleId: "anime" } : {}) as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    generatedImageObjectPath: opts.unfinished || opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

const url = (factId: number, rest = "") => `/api/admin/facts/${factId}/gags${rest}`;
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const offeredScenes = async (factId: number) => (await availableGags(factId)).map((g) => g.content.coreSceneOverride);
const jobsSinceStart = async () => (await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START))).length;

before(async () => {
  adminId = `t-gags-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
});

after(async () => {
  if (factIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    // Inactive first so the live-fact rule does not refuse the gag deletes.
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("gag routes: a change is hidden until its example is approved", () => {
  it("a saved change leaves users on the approved version, and enqueues nothing", async () => {
    const { factId, gagId } = await liveFact();
    const jobsBefore = await jobsSinceStart();
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} lifts the sun (change).") });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = res.body.gags.find((g: { id: number }) => g.id === gagId);
    assert.equal(view.state, "approved_with_change");
    assert.equal(view.availableToUsers, true, "the approved version is still offered");
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "users still get the approved version");
    assert.equal((await primaryGag(factId))!.content.coreSceneOverride, A.coreSceneOverride);
    assert.equal(await jobsSinceStart(), jobsBefore, "saving spends nothing");
  });

  it("approval refuses another gag's render, an unfinished, a failed or a styled render, and one of other content", async () => {
    const { factId, gagId } = await liveFact();
    const change = scene("{NAME} lifts the sun (change).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change })).status, 200);
    const other = await request(app).post(url(factId)).send({ content: scene("{NAME} a second gag.") });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const otherId = other.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;

    const cases: Array<[string, number, number, string]> = [
      ["another gag's render", await render(factId, otherId, change), 404, "RENDER_NOT_APPROVABLE"],
      ["an unfinished render", await render(factId, gagId, change, { unfinished: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a failed render", await render(factId, gagId, change, { failed: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a styled render", await render(factId, gagId, change, { styled: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a render of other content", await render(factId, gagId, scene("{NAME} something else.")), 409, "CONTENT_CHANGED"],
    ];
    for (const [name, attemptId, status, code] of cases) {
      const r = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId });
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, name);
    }
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "nothing refused changed what users get");

    const good = await render(factId, gagId, change);
    const ok = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: good });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const row = await gagRow(gagId);
    assert.equal(row.approvedExampleAttemptId, good, "the approved render is the gag's example");
    assert.equal(row.approvedCarriedOver, false);
    assert.equal(row.pendingContent, null);
    assert.deepEqual(await offeredScenes(factId), [change.coreSceneOverride], "users now get the approved change");
  });
});

describe("gag routes: every slot follows the same rules", () => {
  for (const slot of [2, 3]) {
    it(`a gag added in slot ${slot} is hidden until its example is approved, then offered in slot order`, async () => {
      const { factId } = await liveFact();
      if (slot === 3) {
        const s2 = await request(app).post(url(factId)).send({ content: scene("{NAME} slot two."), slot: 2 });
        assert.equal(s2.status, 200, JSON.stringify(s2.body));
      }
      const content = scene(`{NAME} slot ${slot}.`);
      const res = await request(app).post(url(factId)).send({ content, slot });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const created = res.body.gags.find((g: { slot: number }) => g.slot === slot);
      assert.equal(created.state, "new");
      assert.equal(created.availableToUsers, false);
      assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "a new gag is hidden");

      const ok = await request(app).post(url(factId, `/${created.id}/approve`)).send({ attemptId: await render(factId, created.id, content) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const offered = await offeredScenes(factId);
      assert.equal(offered[0], A.coreSceneOverride, "slot 1 stays the default");
      assert.equal(offered.at(-1), content.coreSceneOverride, "the approved gag is offered, in slot order");
    });
  }

  it("refuses a fourth gag", async () => {
    const { factId } = await liveFact();
    for (const s of [2, 3]) assert.equal((await request(app).post(url(factId)).send({ content: scene(`{NAME} ${s}.`) })).status, 200);
    const fourth = await request(app).post(url(factId)).send({ content: scene("{NAME} four.") });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.code, "GAG_LIMIT");
  });
});

describe("gag routes: discard and remove", () => {
  it("discarding a change returns the gag to its approved version, and spends nothing", async () => {
    const { factId, gagId } = await liveFact();
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} a change.") });
    const jobsBefore = await jobsSinceStart();
    const res = await request(app).post(url(factId, `/${gagId}/discard`)).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await gagRow(gagId)).pendingContent, null);
    const again = await request(app).post(url(factId, `/${gagId}/discard`)).send({});
    assert.equal(again.body.code, "NOTHING_PENDING");
    assert.equal(await jobsSinceStart(), jobsBefore);
  });

  it("refuses removing a live fact's last approved gag, and removes one with another left", async () => {
    const { factId, gagId } = await liveFact();
    const last = await request(app).post(url(factId, `/${gagId}/remove`)).send({});
    assert.equal(last.status, 409);
    assert.equal(last.body.code, "LAST_APPROVED_GAG");

    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await request(app).post(url(factId, `/${secondId}/approve`)).send({ attemptId: await render(factId, secondId, content) });
    const jobsBefore = await jobsSinceStart();
    const removed = await request(app).post(url(factId, `/${gagId}/remove`)).send({});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(await offeredScenes(factId), [content.coreSceneOverride], "the remaining gag becomes the default");
    assert.equal(await jobsSinceStart(), jobsBefore, "removing spends nothing");
  });
});

describe("gag routes: during a refresh, gags change only inside its review", () => {
  async function openRefresh(factId: number): Promise<number> {
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "refresh", submittedById: adminId, status: "pending", workflowStage: "production_review",
      stagingFactId: factId, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const [cand] = await db.insert(factEnrichmentVersionsTable).values({
      factId, versionNo: 1, status: "candidate", source: "refresh_candidate", sourceReviewId: review!.id,
      enrichment: buildPlaceholderFactEnrichment() as never,
    } as never).returning({ id: factEnrichmentVersionsTable.id });
    await db.update(pendingReviewsTable).set({ candidateVersionId: cand!.id }).where(eq(pendingReviewsTable.id, review!.id));
    return review!.id;
  }

  it("refuses a change from outside the review, and lands the review's pick only at promotion", async () => {
    const { factId, gagId } = await liveFact();
    const reviewId = await openRefresh(factId);
    const change = scene("{NAME} the refresh's change.");

    const outside = await request(app).put(url(factId, `/${gagId}`)).send({ content: change });
    assert.equal(outside.status, 409);
    assert.equal(outside.body.code, "REFRESH_IN_REVIEW");

    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId })).status, 200);
    const picked = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change), reviewId });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    const row = await gagRow(gagId);
    assert.equal(row.pendingReviewId, reviewId, "the pick belongs to the review");
    assert.notEqual(row.pendingExampleAttemptId, null);
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "users keep the approved version until promotion");

    await db.transaction((tx) => applyReviewGagOps(tx, factId, reviewId, adminId));
    assert.deepEqual(await offeredScenes(factId), [change.coreSceneOverride], "the pick lands at promotion");
  });

  it("a removal made in a declined refresh changes nothing users get, and is not applied by a later one", async () => {
    const { factId, gagId } = await liveFact();
    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await request(app).post(url(factId, `/${secondId}/approve`)).send({ attemptId: await render(factId, secondId, content) });

    const reviewId = await openRefresh(factId);
    const removed = await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal((await gagRow(gagId)).pendingRemove, true);
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride, content.coreSceneOverride], "nothing removed before promotion");

    await db.transaction((tx) => cancelReviewGagOps(tx, reviewId));
    const after = await gagRow(gagId);
    assert.equal(after.pendingRemove, false);
    assert.equal(after.pendingReviewId, null, "a declined review's decision is no longer owned, so no later review applies it");
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride, content.coreSceneOverride]);
  });

  it("editing after picking cancels the pick", async () => {
    const { factId, gagId } = await liveFact();
    const reviewId = await openRefresh(factId);
    const change = scene("{NAME} picked.");
    await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId });
    await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change), reviewId });
    assert.notEqual((await gagRow(gagId)).pendingExampleAttemptId, null);
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} edited after the pick."), reviewId });
    assert.equal((await gagRow(gagId)).pendingExampleAttemptId, null, "the pick was for content the gag no longer holds");
    await db.transaction((tx) => applyReviewGagOps(tx, factId, reviewId, adminId));
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "with no pick, promotion approves nothing");
  });
});

describe("gag routes: only admins", () => {
  it("refuses a signed-out caller", async () => {
    const { factId } = await liveFact();
    const anon = buildTestApp({ kind: "unauthenticated" }, gagsRouter);
    const res = await request(anon).get(url(factId));
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });
});

