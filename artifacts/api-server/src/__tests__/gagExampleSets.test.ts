/**
 * A gag's male, female and pet examples (plan docs/plans/PLAN_GAG_EXAMPLES.md,
 * Testing Plan items 2, 3, 5, 7a and 7b; the per-kind refusals of item 1 and
 * the refresh picks of item 4 are in routes.gags.test.ts, the gate of item 6
 * in routes.reviews.test.ts, the migration of item 7 in
 * migration0142.gagExampleSets.test.ts):
 *
 *   - two concurrent completions of a set apply the change once;
 *   - a grandfathered gag stays offered while it gains examples, and stops
 *     being grandfathered when its set completes;
 *   - renders are counted per action: one male render per content, reused for
 *     the same content (A, then B, then back to A draws nothing new), one for
 *     two overlapping requests, a new one on an explicit redraw; "render female
 *     and pet" draws only what is missing; a failed render shows and redraws;
 *   - the database refuses, at commit, an approved set made incomplete or a
 *     grandfathered marker cleared early, and accepts a set replaced whole in
 *     one transaction.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  GAG_EXAMPLE_KINDS,
  SCENARIO_FOR_KIND,
  type GagExampleKind,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import gagsRouter from "../routes/gags.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { availableGags } from "../lib/gags/resolver.js";
import { buildGagKindCards, drawGagKinds, reviewRenderScenariosPrepareHandler } from "../lib/reviewRenderScenarios.js";
import { pendingReviewsTable } from "@workspace/db/schema";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (approved).");

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function liveFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} example sets ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A finished (or failed) render of `content` for one kind. */
async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, kind: GagExampleKind, opts: { failed?: boolean } = {}): Promise<number> {
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    reviewRenderScenarioKey: SCENARIO_FOR_KIND[kind],
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: {} as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    generatedImageObjectPath: opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

const url = (factId: number, rest = "") => `/api/admin/facts/${factId}/gags${rest}`;
const approve = (factId: number, gagId: number, attemptId: number) => request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId });
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const examples = async (gagId: number, stage: "approved" | "pending") =>
  db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, stage)));
const attemptsOf = async (gagId: number) =>
  db.select({ id: imagePromptAttemptsTable.id, key: imagePromptAttemptsTable.reviewRenderScenarioKey })
    .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, gagId));
const drawn = (r: Awaited<ReturnType<typeof drawGagKinds>>) => {
  assert.ok(!("error" in r), JSON.stringify(r));
  return r.enqueued;
};

// One wrapper scopes the hooks to this file: with test isolation off, root-level
// hooks run for the whole shard, so another file's cleanup could clear this
// file's fal stub before its tests ran.
describe("a gag's example sets", () => {
before(async () => {
  adminId = `t-gagex-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
  // No vendor call: the i2i reference upload is stubbed, as the render tests do.
  __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
});

after(async () => {
  __setReferenceFalUploadForTest(null);
  if (factIds.length) {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START));
});

describe("completing a set", () => {
  it("two concurrent completions apply the change once, with one approved set", async () => {
    const { factId, gagId } = await liveFact();
    const change = scene("{NAME} lifts the sun (concurrent).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change })).status, 200);
    for (const kind of ["male", "female"] as const) assert.equal((await approve(factId, gagId, await render(factId, gagId, change, kind))).status, 200);

    const [p1, p2] = await Promise.all([render(factId, gagId, change, "pet"), render(factId, gagId, change, "pet")]);
    const results = await Promise.all([approve(factId, gagId, p1), approve(factId, gagId, p2)]);
    assert.ok(results.some((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    for (const r of results) assert.ok([200, 409].includes(r.status), JSON.stringify(r.body));

    const row = await gagRow(gagId);
    assert.deepEqual(row.approvedContent, change, "the change applied");
    assert.equal(row.pendingContent, null);
    const approved = await examples(gagId, "approved");
    assert.deepEqual(approved.map((e) => e.subjectKind).sort(), ["female", "male", "pet"], "one approved example per kind");
    assert.equal((await examples(gagId, "pending")).length, 0);
    assert.deepEqual((await availableGags(factId)).map((g) => g.content.coreSceneOverride), [change.coreSceneOverride]);
  });
});

describe("grandfathering (Q11)", () => {
  it("a grandfathered gag stays offered while it gains examples, and stops being grandfathered at its first complete set", async () => {
    const { factId, gagId } = await liveFact();
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true);

    for (const kind of ["male", "female"] as const) {
      const r = await approve(factId, gagId, await render(factId, gagId, A, kind));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await gagRow(gagId);
      assert.equal(row.approvedCarriedOver || row.approvedBeforeExampleSets, true, `after the ${kind} example it is still grandfathered`);
      assert.deepEqual((await availableGags(factId)).map((g) => g.gagId), [gagId], "still offered");
    }
    const view = (await request(app).get(url(factId))).body.gags.find((g: { id: number }) => g.id === gagId);
    assert.equal(view.grandfathered, true);
    assert.notEqual(view.approvedExamples.male, null);
    assert.equal(view.approvedExamples.pet, null);

    assert.equal((await approve(factId, gagId, await render(factId, gagId, A, "pet"))).status, 200);
    const row = await gagRow(gagId);
    assert.equal(row.approvedCarriedOver, false, "the marker ends with the first complete set");
    assert.equal(row.approvedBeforeExampleSets, false);
    assert.deepEqual(row.approvedContent, A, "the content users get never changed");
    const offered = await availableGags(factId);
    assert.equal(offered.length, 1);
    assert.ok(GAG_EXAMPLE_KINDS.every((k) => offered[0]!.examples[k] != null), "offered with its three examples");
  });
});

describe("renders, counted per action", () => {
  it("one male render per content: A, then B, then back to A draws nothing new, and the tile shows A's render, approvable", async () => {
    const { factId, gagId } = await liveFact();
    const forA = drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId }));
    assert.equal(forA.length, 1);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "the same content reuses its render");

    const B = scene("{NAME} lifts the sun (B).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: B })).status, 200);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 1, "B gets its own render");

    assert.equal((await request(app).post(url(factId, `/${gagId}/discard`)).send({})).status, 200);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "back to A: A's render is reused");
    const cards = await buildGagKindCards(gagId);
    assert.equal(cards.male!.latestAttemptId, forA[0]!.attemptId, "the tile shows A's render");
    assert.equal(cards.male!.stale, false);
    assert.equal(cards.female!.status, "missing");

    // A's render, once finished, is approvable as the male example.
    await db.update(imagePromptAttemptsTable).set({ generatedImageObjectPath: `/objects/ai-bg-v2/${factId}/a.png` })
      .where(eq(imagePromptAttemptsTable.id, forA[0]!.attemptId));
    const ok = await approve(factId, gagId, forA[0]!.attemptId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true })).length, 1, "an explicit redraw draws a new one");
  });

  it("overlapping requests for the same content draw one render", async () => {
    const { gagId } = await liveFact();
    const [a, b] = await Promise.all([
      drawGagKinds(gagId, ["male"], { adminUserId: adminId }),
      drawGagKinds(gagId, ["male"], { adminUserId: adminId }),
    ]);
    assert.equal(drawn(a).length + drawn(b).length, 1);
    assert.equal((await attemptsOf(gagId)).length, 1);
  });

  it("\"render female and pet\" draws only what is missing, and never a retired scenario", async () => {
    const { gagId } = await liveFact();
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 1);
    const rest = drawn(await drawGagKinds(gagId, ["male", "female", "pet"], { adminUserId: adminId }));
    assert.deepEqual(rest.map((e) => e.scenarioKey).sort(), ["i2i_female_default", "i2i_nonhuman_animal"]);
    assert.equal(drawn(await drawGagKinds(gagId, ["female", "pet"], { adminUserId: adminId })).length, 0, "a second click draws nothing");
    const keys = new Set((await attemptsOf(gagId)).map((a) => a.key));
    assert.deepEqual([...keys].sort(), ["i2i_female_default", "i2i_male_default", "i2i_nonhuman_animal"]);
  });

  it("a failed render shows on its tile with its error, and an explicit redraw retries it", async () => {
    const { factId, gagId } = await liveFact();
    await render(factId, gagId, A, "male", { failed: true });
    const card = (await buildGagKindCards(gagId)).male!;
    assert.equal(card.status, "failed");
    assert.equal(card.message, "vendor failed");
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true })).length, 1);
  });

  it("a queued iteration render is skipped once the review its save came from has closed, and drawn while the scope holds (Codex, PR #972 round 1)", async () => {
    // A first-time submission in moderation: an inactive fact, its gag pending, its review open.
    const [f] = await db.insert(factsTable).values({ text: `{NAME} withdrawn ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(f!.id);
    const [g] = await db.insert(factGagsTable).values({ factId: f!.id, slot: 1, pendingContent: scene("{NAME} a gag saved, then withdrawn.") }).returning({ id: factGagsTable.id });
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "withdrawn", submittedById: adminId, status: "pending", workflowStage: "production_review",
      stagingFactId: f!.id, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const job = { factId: f!.id, gagId: g!.id, scopeReviewId: review!.id, adminUserId: adminId };

    // Withdrawn before the job runs: the review is no longer open.
    await db.update(pendingReviewsTable).set({ status: "rejected" }).where(eq(pendingReviewsTable.id, review!.id));
    const skipped = await reviewRenderScenariosPrepareHandler.run(job, {} as never);
    assert.equal(skipped.ok, true);
    assert.equal((skipped as { result?: { skipped?: string } }).result?.skipped, "REVIEW_NOT_EDITABLE");
    assert.equal((await attemptsOf(g!.id)).length, 0, "no render was bought");

    // While the review is open the same job draws its one male render.
    await db.update(pendingReviewsTable).set({ status: "pending" }).where(eq(pendingReviewsTable.id, review!.id));
    const drawnJob = await reviewRenderScenariosPrepareHandler.run(job, {} as never);
    assert.equal(drawnJob.ok, true);
    assert.deepEqual((await attemptsOf(g!.id)).map((a) => a.key), ["i2i_male_default"]);
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.id, review!.id)).catch(() => undefined);
  });

  it("a live fact's queued iteration render is skipped once a refresh opens on it", async () => {
    const { factId, gagId } = await liveFact();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "refresh", submittedById: adminId, status: "pending", workflowStage: "concept_review",
      stagingFactId: factId, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const result = await reviewRenderScenariosPrepareHandler.run({ factId, gagId, scopeReviewId: null, adminUserId: adminId }, {} as never);
    assert.equal(result.ok, true);
    assert.ok((result as { result?: { skipped?: string } }).result?.skipped, JSON.stringify(result));
    assert.equal((await attemptsOf(gagId)).length, 0);
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.id, review!.id));
  });

  it("the renders route draws the kinds asked for, and refuses an unknown kind", async () => {
    const { factId, gagId } = await liveFact();
    const ok = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["female", "pet"] });
    assert.ok([200, 202].includes(ok.status), JSON.stringify(ok.body));
    assert.deepEqual((await attemptsOf(gagId)).map((a) => a.key).sort(), ["i2i_female_default", "i2i_nonhuman_animal"]);
    const bad = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["vehicle"] });
    assert.equal(bad.status, 400);
    const generic = await request(app).post(url(factId, `/${gagId}/renders`)).send({ scenarios: ["generic_t2i"] });
    assert.equal(generic.status, 400, "the retired scenario list is not accepted");
  });
});

describe("the rules the database enforces at commit (7a)", () => {
  /** A live, no-longer-grandfathered gag with a complete approved set. */
  async function completeGag() {
    const { factId, gagId } = await liveFact();
    for (const kind of GAG_EXAMPLE_KINDS) assert.equal((await approve(factId, gagId, await render(factId, gagId, A, kind))).status, 200);
    assert.equal((await gagRow(gagId)).approvedCarriedOver, false);
    return { factId, gagId };
  }
  // Drizzle wraps a commit-time refusal ("Failed query: commit"); the reason is its cause.
  const refusedBy = (re: RegExp) => (err: unknown) => {
    const e = err as { message?: string; cause?: { message?: string } };
    return re.test(`${e.message ?? ""} ${e.cause?.message ?? ""}`);
  };
  const refused = refusedBy(/without its male, female and pet examples/);

  it("refuses deleting an approved example", async () => {
    const { gagId } = await completeGag();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.subjectKind, "pet")));
    }), refused);
    assert.equal((await examples(gagId, "approved")).length, 3);
  });

  it("refuses moving an approved example out of the approved set", async () => {
    const { gagId } = await completeGag();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.update(factGagExamplesTable).set({ stage: "pending" })
        .where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.subjectKind, "male")));
    }), refusedBy(/without its male, female and pet examples|pending examples without pending content/));
  });

  it("refuses clearing the grandfathered marker before the set is complete", async () => {
    const { gagId } = await liveFact();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.update(factGagsTable).set({ approvedCarriedOver: false, approvedBeforeExampleSets: false }).where(eq(factGagsTable.id, gagId));
    }), refused);
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true);
  });

  it("accepts a set replaced whole in one transaction", async () => {
    const { factId, gagId } = await completeGag();
    const fresh = await Promise.all(GAG_EXAMPLE_KINDS.map((k) => render(factId, gagId, A, k)));
    await db.transaction(async (tx) => {
      await tx.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "approved")));
      await tx.insert(factGagExamplesTable).values(GAG_EXAMPLE_KINDS.map((k, i) => ({ gagId, subjectKind: k, stage: "approved" as const, attemptId: fresh[i]!, approvedBy: adminId })));
    });
    assert.deepEqual((await examples(gagId, "approved")).map((e) => e.attemptId).sort(), [...fresh].sort());
  });

  it("refuses a pending example with no pending content", async () => {
    const { factId, gagId } = await liveFact();
    const attemptId = await render(factId, gagId, A, "male");
    await assert.rejects(db.transaction(async (tx) => {
      await tx.insert(factGagExamplesTable).values({ gagId, subjectKind: "male", stage: "pending", attemptId, approvedBy: adminId });
    }), refusedBy(/pending examples without pending content/));
  });
});
});
