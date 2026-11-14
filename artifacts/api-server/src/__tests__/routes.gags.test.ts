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
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import gagsRouter from "../routes/gags.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { availableGags, primaryGag } from "../lib/gags/resolver.js";
import { applyReviewGagOps, cancelReviewGagOps, gagContentEqual } from "../lib/gags/gagStore.js";
import { loadGagRenderTarget, ensureDefaultReviewRenders, reviewRenderStates } from "../lib/reviewRenderScenarios.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visualPromptStrategyOverrideSchema } from "@workspace/api-zod";

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
    // Children before parents: gags point at renders and reviews, renders and
    // refresh candidates at reviews. Inactive first so the live-fact rule allows
    // deleting the gags.
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START));
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

describe("the default gag: approved first, across every slot", () => {
  it("a pending-only gag in a freed lower slot does not displace the approved one above it", async () => {
    const { factId, gagId } = await liveFact();
    const content = scene("{NAME} the approved slot-2 gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await request(app).post(url(factId, `/${secondId}/approve`)).send({ attemptId: await render(factId, secondId, content) });
    assert.equal((await request(app).post(url(factId, `/${gagId}/remove`)).send({})).status, 200);
    // A new gag takes the freed slot 1, pending.
    const fresh = await request(app).post(url(factId)).send({ content: scene("{NAME} pending in slot 1.") });
    assert.equal(fresh.body.gags.find((g: { slot: number }) => g.slot === 1).state, "new");

    const primary = await primaryGag(factId);
    assert.equal(primary!.gag.id, secondId, "the default is the approved gag, not the lower-slot pending one");
    assert.equal(primary!.content.coreSceneOverride, content.coreSceneOverride);
    assert.equal((await availableGags(factId))[0]!.gagId, secondId, "and it agrees with the list a picker reads");
  });

  it("a fact with nothing approved falls back to its lowest-slot pending gag", async () => {
    const [fact] = await db.insert(factsTable).values({ text: `{NAME} staging ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    await db.insert(factGagsTable).values([
      { factId: fact!.id, slot: 2, pendingContent: scene("{NAME} pending two.") as never },
      { factId: fact!.id, slot: 1, pendingContent: scene("{NAME} pending one.") as never },
    ]);
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} pending one.");
  });
});

describe("a gag the migration carried over can be approved (Codex, PR #956 round 2)", () => {
  it("a render of a carried-over gag in its legacy shape is approved, and a render of other content is still refused", async () => {
    // The shape migration 0139 moves byte for byte: no defaulted lists, a retired key.
    const legacy = { version: 1, enabled: true, coreSceneOverride: "{NAME} lifts the moon (legacy shape)." };
    const f = await insertLiveFact({ text: `{NAME} legacy ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, legacy as never);
    factIds.push(f.id);
    const gagId = f.gags[0]!.id;
    // The snapshot a real render stores: the render target the loader builds.
    const loaded = await loadGagRenderTarget(gagId);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const drew = (loaded as { target: { enrichment: { visualPromptStrategyOverride: unknown } } }).target.enrichment.visualPromptStrategyOverride;
    const [real] = await db.insert(imagePromptAttemptsTable).values({
      factId: f.id, gagId, renderJobId: randomUUID(), generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
      factEnrichmentSnapshot: (loaded as { target: { enrichment: unknown } }).target.enrichment as never,
      archetypeStrategyVersion: "v2", generatedImageObjectPath: `/objects/ai-bg-v2/${f.id}/${randomUUID()}.png`,
    }).returning({ id: imagePromptAttemptsTable.id });
    assert.notDeepEqual(drew, legacy, "precondition: the snapshot is the normalised form, not the stored one");

    const other = await request(app).post(url(f.id, `/${gagId}/approve`)).send({ attemptId: await render(f.id, gagId, scene("{NAME} a different scene.")) });
    assert.equal(other.body.code, "CONTENT_CHANGED", "a render of other content is still refused");
    const ok = await request(app).post(url(f.id, `/${gagId}/approve`)).send({ attemptId: real!.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await gagRow(gagId)).approvedExampleAttemptId, real!.id, "the render is the gag's example");
  });

  it("every schema-valid gag in the legacy fixture is equal to its own normalised form", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows = readFileSync(path.join(here, "../../fixtures/legacy/fact_gags.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    let checked = 0;
    for (const r of rows) {
      for (const c of [r["approved_content"], r["pending_content"]]) {
        if (c == null) continue;
        const parsed = visualPromptStrategyOverrideSchema.safeParse(c);
        if (!parsed.success) continue;
        assert.ok(gagContentEqual(c, parsed.data), `fixture gag ${String(r["id"])} differs from its normalised form`);
        checked++;
      }
    }
    assert.ok(checked > 40, `checked ${checked}`);
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

  it("advancing to Test Renders starts no paid batch for a gag the review marked for removal (Codex, PR #956 round 2)", async () => {
    const { factId, gagId } = await liveFact();
    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await request(app).post(url(factId, `/${secondId}/approve`)).send({ attemptId: await render(factId, secondId, content) });

    const reviewId = await openRefresh(factId);
    // A change saved to gag 2, then gag 2 removed: the draft stays (a decline keeps it).
    assert.equal((await request(app).put(url(factId, `/${secondId}`)).send({ content: scene("{NAME} a change, then removed."), reviewId })).status, 200);
    assert.equal((await request(app).post(url(factId, `/${secondId}/remove`)).send({ reviewId })).status, 200);
    const before = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, secondId));

    // No vendor call: the i2i reference upload is stubbed, as the render tests do.
    __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
    try {
      await ensureDefaultReviewRenders(reviewId, { force: true });
    } finally {
      __setReferenceFalUploadForTest(null);
    }
    const after = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, secondId));
    assert.equal(after.length, before.length, "no attempt for the gag being removed");
    const gate = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable)
      .where(and(eq(imagePromptAttemptsTable.gagId, gagId), eq(imagePromptAttemptsTable.reviewId, reviewId)));
    assert.ok(gate.length > 0, "the surviving gate gag gets its batch");
  });

  it("the list's render state counts each surviving gag: one finishing never hides another (Codex, PR #956 round 2)", async () => {
    const { factId, gagId } = await liveFact();
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} gag two.") });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    const reviewId = await openRefresh(factId);
    const attempt = async (gid: number, state: "running" | "failed" | "done", at: string) => {
      await db.insert(imagePromptAttemptsTable).values({
        factId, gagId: gid, reviewId, reviewRenderScenarioKey: "generic_t2i", renderJobId: randomUUID(),
        generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
        sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
        factEnrichmentSnapshot: {} as never, archetypeStrategyVersion: "v2",
        generatedImageObjectPath: state === "done" ? `/objects/x/${randomUUID()}.png` : null,
        error: state === "failed" ? "vendor failed" : null, createdAt: new Date(at),
      });
    };
    // The earlier gag still drawing, the later one finished.
    await attempt(gagId, "running", "2026-01-01T00:00:00Z");
    await attempt(secondId, "done", "2026-01-01T00:01:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "running");
    // The earlier gag failed (a newer attempt of it), the later one finished.
    await attempt(gagId, "failed", "2026-01-01T00:02:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "needs_attention");
    // The failed gag marked for removal by this review: no longer counted.
    await db.update(factGagsTable).set({ pendingRemove: true, pendingReviewId: reviewId }).where(eq(factGagsTable.id, gagId));
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
    // A superseded failure of a gag does not poison its later success.
    await db.update(factGagsTable).set({ pendingRemove: false, pendingReviewId: null }).where(eq(factGagsTable.id, gagId));
    await attempt(gagId, "done", "2026-01-01T00:03:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
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

