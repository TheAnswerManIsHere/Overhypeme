/**
 * The gag writer knows every gag, and Draft more gags runs on a live fact
 * (plan docs/plans/PLAN_THREE_GAGS.md, increment 2, Testing Plan item 11):
 *
 *   - the request lists every gag in slot order, the version being worked on,
 *     a gag marked for removal left out; the input hash covers the same list;
 *   - Draft more gags is refused while a review is open, for a fact that is
 *     not live, and while a generation is still working;
 *   - one owner per generation: with a delayed generation double, a live
 *     draft that finishes after a review opened leaves the review's
 *     candidates and status untouched, in both completion orders, and its
 *     abandonment does too.
 *
 * No worker runs: the handler is invoked directly with a stub generator.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, factsTable, usersTable, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, factEnrichmentVersionsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  type VisualConceptProvenance,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import gagsRouter from "../routes/gags.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import {
  FACT_VISUAL_CONCEPTS_QUEUE,
  factVisualConceptsJobHandler,
  runVisualConceptsJob,
  type FactVisualConceptsJobPayload,
  type VisualConceptsJobDeps,
} from "../lib/visualConceptJobs.js";
import { sendFactBackToReview } from "../lib/sendBackToReview.js";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });

const PROVENANCE: VisualConceptProvenance = {
  engineId: "openai-gag-writer", model: "gpt-6-astra", reasoningEffort: "high", timeoutMs: 180_000, promptVersion: 4, fallbackReason: null,
};

type GenerateInput = Parameters<VisualConceptsJobDeps["generate"]>[0];

function stub(label: string, seen?: (input: GenerateInput) => void): VisualConceptsJobDeps["generate"] {
  return async (input) => {
    seen?.(input);
    return {
      jokeRead: `Read ${label}.`,
      candidates: [1, 2, 3].map((n) => ({ title: `${label} ${n}`, whyItWorks: "It lands.", sceneDescription: `{NAME} ${label} ${n}.`, tokenValid: true, bubbles: [] })),
      provenance: PROVENANCE,
    };
  };
}

/** A generator that waits until released: the delayed double. */
function delayed(label: string): { generate: VisualConceptsJobDeps["generate"]; started: Promise<void>; release: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { markStarted = r; });
  return {
    started,
    release: () => release(),
    generate: async (input) => {
      markStarted();
      await gate;
      return stub(label)(input);
    },
  };
}

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function liveFact(...gags: VisualPromptStrategyOverride[]): Promise<{ factId: number; gagIds: number[] }> {
  const f = await insertLiveFact({ text: `{NAME} live drafting ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, gags[0] ?? scene("{NAME} gag one."));
  factIds.push(f.id);
  const ids = [f.gags[0]!.id];
  for (const [i, g] of gags.slice(1).entries()) {
    const [row] = await db.insert(factGagsTable).values({ factId: f.id, slot: i + 2, approvedContent: g as never, approvedCarriedOver: true }).returning({ id: factGagsTable.id });
    ids.push(row!.id);
  }
  return { factId: f.id, gagIds: ids };
}

const factRow = async (factId: number) => (await db.select().from(factsTable).where(eq(factsTable.id, factId)))[0]!;
const liveJob = async (factId: number) =>
  (await db.select().from(asyncJobsTable).where(and(eq(asyncJobsTable.queue, FACT_VISUAL_CONCEPTS_QUEUE), gte(asyncJobsTable.createdAt, START))))
    .map((j) => j.payload as FactVisualConceptsJobPayload)
    .filter((p) => p.factId === factId && p.reviewId == null)
    .at(-1)!;
/** Open a refresh on a live fact, with its candidate classified and its review at the Gags step. */
async function openRefresh(factId: number): Promise<number> {
  const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId, adminId });
  await db.update(factEnrichmentVersionsTable).set({ enrichment: buildPlaceholderFactEnrichment() as never }).where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  await db.update(pendingReviewsTable).set({ workflowStage: "concept_review" }).where(eq(pendingReviewsTable.id, reviewId));
  return reviewId;
}

const titles = (blob: unknown) => ((blob as { candidates?: Array<{ title: string }> } | null)?.candidates ?? []).map((c) => c.title);

before(async () => {
  adminId = `t-livegags-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
});

after(async () => {
  if (factIds.length) {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.update(factEnrichmentVersionsTable).set({ sourceReviewId: null }).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("the gag writer knows every gag", () => {
  it("lists every gag in slot order, the version being worked on, leaving out one marked for removal", async () => {
    // A change and a removal mark inside a refresh's review, made through the routes.
    const { factId, gagIds } = await liveFact(scene("{NAME} gag one."), scene("{NAME} gag two."), scene("{NAME} gag three."));
    const reviewId = await openRefresh(factId);
    const changed = await request(app).put(`/api/admin/facts/${factId}/gags/${gagIds[1]}`).send({ content: scene("{NAME} gag two, changed."), reviewId });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const removed = await request(app).post(`/api/admin/facts/${factId}/gags/${gagIds[2]}/remove`).send({ reviewId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    let seen: GenerateInput | null = null;
    await runVisualConceptsJob({ reviewId, factId }, { generate: stub("A", (i) => { seen = i; }) });
    assert.deepEqual((seen as GenerateInput | null)?.existingGags.map((g) => g.scene), ["{NAME} gag one.", "{NAME} gag two, changed."]);
  });

  it("a live draft lists the live fact's gags", async () => {
    const { factId } = await liveFact(scene("{NAME} gag one."), scene("{NAME} gag two."));
    const res = await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    let seen: GenerateInput | null = null;
    await runVisualConceptsJob(await liveJob(factId), { generate: stub("A", (i) => { seen = i; }) });
    assert.deepEqual((seen as GenerateInput | null)?.existingGags.map((g) => g.scene), ["{NAME} gag one.", "{NAME} gag two."]);
  });

  it("a change to any gag stales the drafted ideas", async () => {
    const { factId, gagIds } = await liveFact(scene("{NAME} gag one."), scene("{NAME} gag two."));
    await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    await runVisualConceptsJob(await liveJob(factId), { generate: stub("A") });
    const fresh = await request(app).get(`/api/admin/facts/${factId}/gags/ideas`);
    assert.equal(fresh.body.status, "ok");
    assert.equal(fresh.body.current, true, JSON.stringify(fresh.body));
    assert.deepEqual(fresh.body.candidates.map((c: { title: string }) => c.title), ["A 1", "A 2", "A 3"]);
    // Saving a change to the second gag (through the route) changes the list the ideas were drafted against.
    await request(app).put(`/api/admin/facts/${factId}/gags/${gagIds[1]}`).send({ content: scene("{NAME} gag two, changed.") });
    const stale = await request(app).get(`/api/admin/facts/${factId}/gags/ideas`);
    assert.equal(stale.body.current, false);
    assert.equal(stale.body.staleReason, "input_hash_mismatch");
  });
});

describe("Draft more gags: when it is refused", () => {
  it("refuses while a review is open, for a fact that is not live, and while a generation is working", async () => {
    const { factId } = await liveFact();
    const first = await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "pending");
    const again = await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "IDEAS_PENDING");

    const other = await liveFact();
    await sendFactBackToReview({ factId: other.factId, adminId });
    const inReview = await request(app).post(`/api/admin/facts/${other.factId}/gags/ideas`).send({});
    assert.equal(inReview.status, 409);
    assert.equal(inReview.body.code, "REVIEW_OPEN");

    const [staging] = await db.insert(factsTable).values({ text: `{NAME} staging ${RUN}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(staging!.id);
    const notLive = await request(app).post(`/api/admin/facts/${staging!.id}/gags/ideas`).send({});
    assert.equal(notLive.status, 409);
    assert.equal(notLive.body.code, "FACT_NOT_LIVE");
  });
});

describe("one owner per generation (plan section F)", () => {
  it("a live draft finishing after a review opened, and after the review's ideas landed, writes nothing", async () => {
    const { factId } = await liveFact();
    await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    const slow = delayed("LIVE");
    const liveRun = runVisualConceptsJob(await liveJob(factId), { generate: slow.generate });
    await slow.started;

    const reviewId = await openRefresh(factId);
    const claimed = await factRow(factId);
    assert.equal(claimed.visualConceptOwner, `review:${reviewId}`, "opening the review takes ownership");
    assert.equal(claimed.visualConceptStatus, null, "the live draft's pending is cleared with it");
    const reviewed = await runVisualConceptsJob({ reviewId, factId }, { generate: stub("REVIEW") });
    assert.equal(reviewed.ok, true);

    slow.release();
    await liveRun;
    const after = await factRow(factId);
    assert.equal(after.visualConceptStatus, "ok");
    assert.deepEqual(titles(after.visualConceptCandidates), ["REVIEW 1", "REVIEW 2", "REVIEW 3"], "the review's ideas stand");
  });

  it("a live draft finishing after a review opened but before its ideas landed writes nothing either", async () => {
    const { factId } = await liveFact();
    await request(app).post(`/api/admin/facts/${factId}/gags/ideas`).send({});
    const slow = delayed("LIVE");
    const liveRun = runVisualConceptsJob(await liveJob(factId), { generate: slow.generate });
    await slow.started;
    await sendFactBackToReview({ factId, adminId });

    slow.release();
    await liveRun;
    const after = await factRow(factId);
    assert.equal(after.visualConceptStatus, null, "the review's state is untouched: nothing drafted yet");
    assert.equal(after.visualConceptCandidates, null);
  });

  it("an abandoned live draft leaves a review's state alone, and marks its own as failed", async () => {
    const mine = await liveFact();
    await request(app).post(`/api/admin/facts/${mine.factId}/gags/ideas`).send({});
    const row = { payload: await liveJob(mine.factId) } as never;
    await factVisualConceptsJobHandler.onAbandon!(row);
    assert.equal((await factRow(mine.factId)).visualConceptStatus, "failed", "still its own: marked failed");

    const taken = await liveFact();
    await request(app).post(`/api/admin/facts/${taken.factId}/gags/ideas`).send({});
    const takenRow = { payload: await liveJob(taken.factId) } as never;
    const { reviewId } = await sendFactBackToReview({ factId: taken.factId, adminId });
    await db.update(factsTable).set({ visualConceptStatus: "pending" }).where(eq(factsTable.id, taken.factId));
    await factVisualConceptsJobHandler.onAbandon!(takenRow);
    const after = await factRow(taken.factId);
    assert.equal(after.visualConceptStatus, "pending", "the review's status is not the live draft's to fail");
    assert.equal(after.visualConceptOwner, `review:${reviewId}`);
  });
});
