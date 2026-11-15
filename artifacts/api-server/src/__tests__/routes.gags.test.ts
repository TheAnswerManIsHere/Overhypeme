/**
 * The gag lifecycle through its routes (plan docs/plans/PLAN_THREE_GAGS.md,
 * Testing Plan items 5, 6, 7, 9 and 10):
 *
 *   - a saved change is hidden: users keep the approved version until its
 *     male, female and pet renders are approved as its examples (plan
 *     PLAN_GAG_EXAMPLES.md);
 *   - approval refuses another gag's render, an unfinished or failed one, a
 *     styled one and one drawn from other content, and accepts the rest;
 *   - every slot follows the same rules;
 *   - discard and remove, and the last approved gag of a live fact kept;
 *   - during a refresh, gags change only inside its review, and its pick or
 *     removal lands at promotion or is dropped on decline;
 *   - saving, adding and discarding enqueue one iteration render job each;
 *     removing enqueues nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, factEnrichmentVersionsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
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
import { availableGags, normaliseGagContent, primaryGag } from "../lib/gags/resolver.js";
import { applyReviewGagOps, cancelReviewGagOps, gagContentEqual } from "../lib/gags/gagStore.js";
import { loadGagRenderTarget, ensureReviewIterationRenders, reviewRenderStates } from "../lib/reviewRenderScenarios.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visualPromptStrategyOverrideSchema } from "@workspace/api-zod";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (approved).");
const LISTS = ["requiredVisualDetails", "forbiddenVisualDetails", "roleBindings", "bubbles", "compositionGuidance", "styleAgnosticPromptAdditions", "negativePromptAdditions"] as const;

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function liveFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} gags test ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A test render of `gagId` that drew `content`, for a kind (male by default); finished unless told otherwise. */
async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, opts: { unfinished?: boolean; failed?: boolean; styled?: boolean; kind?: GagExampleKind | null } = {}): Promise<number> {
  const kind = opts.kind === undefined ? "male" : opts.kind;
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    reviewRenderScenarioKey: kind ? SCENARIO_FOR_KIND[kind] : "generic_t2i",
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

/** Approve a male, female and pet render of `content` as the gag's examples; returns the last response. */
async function approveSet(factId: number, gagId: number, content: VisualPromptStrategyOverride, reviewId?: number) {
  let last: request.Response | null = null;
  for (const kind of GAG_EXAMPLE_KINDS) {
    last = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, content, { kind }), ...(reviewId ? { reviewId } : {}) });
    assert.equal(last.status, 200, `${kind}: ${JSON.stringify(last.body)}`);
  }
  return last!;
}
const examplesOf = async (gagId: number, stage: "approved" | "pending") =>
  (await db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, stage)))).length;
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const offeredScenes = async (factId: number) => (await availableGags(factId)).map((g) => g.content.coreSceneOverride);
const jobsSinceStart = async () => (await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START))).length;
const jobsForGag = async (gagId: number) => (await db.select({ payload: asyncJobsTable.payload }).from(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START)))
  .filter((j) => (j.payload as { gagId?: number } | null)?.gagId === gagId).length;

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
  it("a saved change leaves users on the approved version, and enqueues its one iteration render", async () => {
    const { factId, gagId } = await liveFact();
    const jobsBefore = await jobsForGag(gagId);
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} lifts the sun (change).") });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = res.body.gags.find((g: { id: number }) => g.id === gagId);
    assert.equal(view.state, "approved_with_change");
    assert.equal(view.availableToUsers, true, "the approved version is still offered");
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "users still get the approved version");
    assert.equal((await primaryGag(factId))!.content.coreSceneOverride, A.coreSceneOverride);
    assert.equal(await jobsForGag(gagId), jobsBefore + 1, "saving enqueues one iteration render job");
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
      ["a render of a retired scenario", await render(factId, gagId, change, { kind: null }), 409, "RENDER_NOT_APPROVABLE"],
    ];
    for (const [name, attemptId, status, code] of cases) {
      const r = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId });
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, name);
    }
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "nothing refused changed what users get");

    // One and two picks change nothing users get; the third applies the change.
    for (const kind of ["male", "female"] as const) {
      const pick = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change, { kind }) });
      assert.equal(pick.status, 200, JSON.stringify(pick.body));
      assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], `after the ${kind} pick users keep the approved version`);
    }
    const ok = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change, { kind: "pet" }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const row = await gagRow(gagId);
    assert.equal(await examplesOf(gagId, "approved"), 3, "the three picks are the gag's examples");
    assert.equal(await examplesOf(gagId, "pending"), 0);
    assert.equal(row.approvedCarriedOver, false);
    assert.equal(row.approvedBeforeExampleSets, false);
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

      await request(app).post(url(factId, `/${created.id}/approve`)).send({ attemptId: await render(factId, created.id, content) });
      assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "a new gag with one example is still hidden");
      await approveSet(factId, created.id, content);
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
    await approveSet(factId, secondId, content);
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
      factId: f.id, gagId, reviewRenderScenarioKey: "i2i_male_default", renderJobId: randomUUID(), generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
      factEnrichmentSnapshot: (loaded as { target: { enrichment: unknown } }).target.enrichment as never,
      archetypeStrategyVersion: "v2", generatedImageObjectPath: `/objects/ai-bg-v2/${f.id}/${randomUUID()}.png`,
    }).returning({ id: imagePromptAttemptsTable.id });
    assert.notDeepEqual(drew, legacy, "precondition: the snapshot is the normalised form, not the stored one");

    const other = await request(app).post(url(f.id, `/${gagId}/approve`)).send({ attemptId: await render(f.id, gagId, scene("{NAME} a different scene.")) });
    assert.equal(other.body.code, "CONTENT_CHANGED", "a render of other content is still refused");
    const ok = await request(app).post(url(f.id, `/${gagId}/approve`)).send({ attemptId: real!.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [ex] = await db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "approved")));
    assert.equal(ex?.attemptId, real!.id, "the render is the gag's male example");
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true, "one example leaves the carried-over gag grandfathered");
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

  it("every gag in the legacy fixture reads as editor content, the schema-refused one included", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows = readFileSync(path.join(here, "../../fixtures/legacy/fact_gags.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    let refused = 0;
    for (const r of rows) {
      for (const c of [r["approved_content"], r["pending_content"]]) {
        if (c == null) continue;
        const read = normaliseGagContent(c)!;
        for (const key of LISTS) assert.ok(Array.isArray(read[key]), `fixture gag ${String(r["id"])}: ${key} is not a list`);
        if (!visualPromptStrategyOverrideSchema.safeParse(c).success) {
          refused++;
          assert.equal(read.coreSceneOverride, (c as { coreSceneOverride?: string }).coreSceneOverride, "refused content keeps its text");
        }
      }
    }
    assert.ok(refused >= 1, "the fixture still carries schema-refused content, so the never-refuse path is exercised");
  });

  it("the Gags view fills an older stored shape's lists and returns refused content as stored (Codex, PR #956 round 3)", async () => {
    const legacy = { version: 1, enabled: true, coreSceneOverride: "{NAME} lifts the moon (older shape)." };
    const f = await insertLiveFact({ text: `{NAME} older shape ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, legacy as never);
    factIds.push(f.id);
    const gagId = f.gags[0]!.id;
    const refusedChange = { version: 1, coreSceneOverride: "{NAME} meets {BOGUS_TOKEN}." };
    await db.update(factGagsTable).set({ pendingContent: refusedChange as never }).where(eq(factGagsTable.id, gagId));

    const res = await request(app).get(url(f.id));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = (res.body.gags as Array<{ id: number; approvedContent: Record<string, unknown>; pendingContent: Record<string, unknown> }>).find((g) => g.id === gagId)!;
    for (const key of LISTS) {
      assert.deepEqual(view.approvedContent[key], [], `approved ${key}`);
      assert.deepEqual(view.pendingContent[key], [], `pending ${key}`);
    }
    assert.equal(view.approvedContent["coreSceneOverride"], legacy.coreSceneOverride);
    assert.equal(view.pendingContent["coreSceneOverride"], refusedChange.coreSceneOverride, "refused content keeps its text for the moderator to fix");
    assert.deepEqual((await gagRow(gagId)).approvedContent, legacy, "reading changes nothing stored");
    const offered = await availableGags(f.id);
    assert.ok(Array.isArray(offered[0]!.content.roleBindings), "the available-gags list is normalised too");
  });
});

describe("gag routes: discard and remove", () => {
  it("discarding a change returns the gag to its approved version, and enqueues its iteration render", async () => {
    const { factId, gagId } = await liveFact();
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} a change.") });
    const jobsBefore = await jobsForGag(gagId);
    const res = await request(app).post(url(factId, `/${gagId}/discard`)).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await gagRow(gagId)).pendingContent, null);
    const again = await request(app).post(url(factId, `/${gagId}/discard`)).send({});
    assert.equal(again.body.code, "NOTHING_PENDING");
    assert.equal(await jobsForGag(gagId), jobsBefore + 1, "one job: the render is reused when it already exists");
  });

  it("refuses removing a live fact's last approved gag, and removes one with another left", async () => {
    const { factId, gagId } = await liveFact();
    const last = await request(app).post(url(factId, `/${gagId}/remove`)).send({});
    assert.equal(last.status, 409);
    assert.equal(last.body.code, "LAST_APPROVED_GAG");

    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await approveSet(factId, secondId, content);
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
    await approveSet(factId, gagId, change, reviewId);
    const row = await gagRow(gagId);
    assert.equal(row.pendingReviewId, reviewId, "the picks belong to the review");
    assert.equal(await examplesOf(gagId, "pending"), 3, "all three picks wait for promotion");
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "users keep the approved version until promotion");

    await db.transaction((tx) => applyReviewGagOps(tx, factId, reviewId, adminId));
    assert.deepEqual(await offeredScenes(factId), [change.coreSceneOverride], "the pick lands at promotion");
  });

  it("a removal made in a declined refresh changes nothing users get, and is not applied by a later one", async () => {
    const { factId, gagId } = await liveFact();
    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await approveSet(factId, secondId, content);

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

  it("advancing to Test Renders draws only changed gags' male renders: none for an unchanged or removed gag (plan PLAN_GAG_EXAMPLES.md)", async () => {
    const { factId, gagId } = await liveFact();
    const content = scene("{NAME} a second approved gag.");
    const added = await request(app).post(url(factId)).send({ content });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await approveSet(factId, secondId, content);
    const added3 = await request(app).post(url(factId)).send({ content: scene("{NAME} a third gag.") });
    const thirdId = added3.body.gags.find((g: { slot: number }) => g.slot === 3).id as number;

    const reviewId = await openRefresh(factId);
    // Gag 2: a change, then removed. Gag 3: a change kept. Gag 1: unchanged.
    assert.equal((await request(app).put(url(factId, `/${secondId}`)).send({ content: scene("{NAME} a change, then removed."), reviewId })).status, 200);
    assert.equal((await request(app).post(url(factId, `/${secondId}/remove`)).send({ reviewId })).status, 200);
    assert.equal((await request(app).put(url(factId, `/${thirdId}`)).send({ content: scene("{NAME} the third, changed."), reviewId })).status, 200);
    const count = async (gid: number) => (await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, gid))).length;
    const before = { first: await count(gagId), second: await count(secondId), third: await count(thirdId) };

    // No vendor call: the i2i reference upload is stubbed, as the render tests do.
    __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
    try {
      await ensureReviewIterationRenders(reviewId, { adminUserId: adminId });
      await ensureReviewIterationRenders(reviewId, { adminUserId: adminId });
    } finally {
      __setReferenceFalUploadForTest(null);
    }
    assert.equal(await count(gagId), before.first, "an unchanged gag gets no render");
    assert.equal(await count(secondId), before.second, "a gag the review removes gets no render");
    assert.equal(await count(thirdId), before.third + 1, "the changed gag gets one male render, once");
    const [drawn] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, thirdId));
    assert.equal(drawn!.reviewRenderScenarioKey, "i2i_male_default");
  });

  it("the list's render state counts each surviving gag: one finishing never hides another (Codex, PR #956 round 2)", async () => {
    const { factId, gagId } = await liveFact();
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} gag two.") });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    const reviewId = await openRefresh(factId);
    const attempt = async (gid: number, state: "running" | "failed" | "done", at: string) => {
      await db.insert(imagePromptAttemptsTable).values({
        factId, gagId: gid, reviewId, reviewRenderScenarioKey: "i2i_male_default", renderJobId: randomUUID(),
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
    assert.equal(await examplesOf(gagId, "pending"), 1);
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} edited after the pick."), reviewId });
    assert.equal(await examplesOf(gagId, "pending"), 0, "the pick was for content the gag no longer holds");
    await db.transaction((tx) => applyReviewGagOps(tx, factId, reviewId, adminId));
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "with no pick, promotion approves nothing");
  });

  describe("keeping a gag the refresh marked for removal (Codex, PR #956 round 4; increment 2)", () => {
    /** A live fact with a second approved gag, so either can be marked for removal. */
    async function twoGags() {
      const { factId, gagId } = await liveFact();
      const second = await request(app).post(url(factId)).send({ content: scene("{NAME} a second gag.") });
      const secondId = (second.body.gags as Array<{ id: number; slot: number }>).find((g) => g.slot === 2)!.id;
      const content = scene("{NAME} a second gag.");
      await approveSet(factId, secondId, content);
      return { factId, gagId, secondId };
    }
    const snapshot = async (gagId: number) => {
      const g = await gagRow(gagId);
      return { approvedContent: g.approvedContent, pendingContent: g.pendingContent, pendingExamples: await examplesOf(gagId, "pending"), pendingReviewId: g.pendingReviewId, removedAt: g.removedAt };
    };

    it("an approved gag with no change: Keep restores it exactly", async () => {
      const { factId, gagId } = await twoGags();
      const reviewId = await openRefresh(factId);
      const before = await snapshot(gagId);
      assert.equal((await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId })).status, 200);
      const kept = await request(app).post(url(factId, `/${gagId}/keep`)).send({ reviewId });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      assert.equal((await gagRow(gagId)).pendingRemove, false);
      assert.deepEqual(await snapshot(gagId), before);
      await db.transaction((tx) => applyReviewGagOps(tx, factId, reviewId, adminId));
      assert.equal((await availableGags(factId)).length, 2, "promotion removes nothing");
    });

    it("an approved gag with a change and a picked example: Keep leaves both; Discard leaves the removal mark", async () => {
      const { factId, gagId } = await twoGags();
      const reviewId = await openRefresh(factId);
      const change = scene("{NAME} the refresh's change.");
      await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId });
      await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change), reviewId });
      const before = await snapshot(gagId);
      assert.equal(before.pendingExamples, 1);
      await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId });
      await request(app).post(url(factId, `/${gagId}/keep`)).send({ reviewId });
      assert.deepEqual(await snapshot(gagId), before, "the change and its pick survive");

      await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId });
      const discarded = await request(app).post(url(factId, `/${gagId}/discard`)).send({ reviewId });
      assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
      const row = await gagRow(gagId);
      assert.equal(row.pendingContent, null, "discard drops the change");
      assert.equal(row.pendingRemove, true, "and only the change: the removal stays marked");
    });

    it("a gag never approved, added in the refresh: Keep keeps it, never deletes it", async () => {
      const { factId, secondId } = await twoGags();
      const reviewId = await openRefresh(factId);
      const added = await request(app).post(url(factId)).send({ content: scene("{NAME} added in the refresh."), reviewId });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const newId = (added.body.gags as Array<{ id: number; slot: number }>).find((g) => g.slot === 3)!.id;
      const before = await snapshot(newId);
      await request(app).post(url(factId, `/${newId}/remove`)).send({ reviewId });
      const kept = await request(app).post(url(factId, `/${newId}/keep`)).send({ reviewId });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      assert.deepEqual(await snapshot(newId), before);
      assert.equal((await gagRow(newId)).removedAt, null);
      assert.ok(secondId > 0);
    });

    it("refuses Keep on a gag not marked, and from outside the review", async () => {
      const { factId, gagId } = await twoGags();
      const reviewId = await openRefresh(factId);
      const unmarked = await request(app).post(url(factId, `/${gagId}/keep`)).send({ reviewId });
      assert.equal(unmarked.body.code, "NOT_MARKED_FOR_REMOVAL");
      await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId });
      const outside = await request(app).post(url(factId, `/${gagId}/keep`)).send({});
      assert.equal(outside.status, 409);
      assert.equal((await gagRow(gagId)).pendingRemove, true);
    });
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

