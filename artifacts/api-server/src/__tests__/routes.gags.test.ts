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
 *   - while a review is open, gags change only inside it;
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
import { gagContentEqual } from "../lib/gags/gagStore.js";
import { loadGagRenderTarget, ensureReviewIterationRenders, reviewRenderStates } from "../lib/reviewRenderScenarios.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visualPromptStrategyOverrideSchema } from "@workspace/api-zod";
import { withCast } from "./helpers/gagCast.js";
import { __setDraftCastExtractorForTest } from "../lib/gags/castPreparation.js";
import { castSourceKey, PLACEHOLDER_CORE_SCENE_OVERRIDE } from "@workspace/api-zod";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
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

  it("the stand-in scene a migration stamped is not a gag to draw: its pending change wins, then a real approved gag (bug: the comparison judged \"stands there confidently\")", async () => {
    const [fact] = await db.insert(factsTable).values({ text: `{NAME} stand-in ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    const standIn = scene(PLACEHOLDER_CORE_SCENE_OVERRIDE);
    // Fact 41's shape: the only gag's approved version is the stand-in, the real scene is pending.
    // Approved before examples existed, as the backfilled stand-ins were (the examples trigger allows that).
    const carried = { approvedCarriedOver: true, approvedBeforeExampleSets: true } as const;
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, approvedContent: standIn as never, ...carried, pendingContent: scene("{NAME} drives mom home.") as never });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} drives mom home.", "the pending real scene, not the stand-in");
    // A real approved gag in a later slot beats both.
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 2, approvedContent: scene("{NAME} real approved.") as never, ...carried });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} real approved.");
    // With nothing else, the stand-in is still returned, as before.
    await db.delete(factGagsTable).where(eq(factGagsTable.factId, fact!.id));
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, approvedContent: standIn as never, ...carried });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, PLACEHOLDER_CORE_SCENE_OVERRIDE);
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

describe("gag routes: while a review is open, gags change only inside it", () => {
  // Refresh reviews are gone (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1H); a
  // review is opened on the fact directly, as the scope rule holds for any.
  async function openReview(factId: number): Promise<number> {
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "review", submittedById: adminId, status: "pending", workflowStage: "test_renders",
      stagingFactId: factId, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    return review!.id;
  }

  it("refuses a change from outside the review, and accepts it from the review", async () => {
    const { factId, gagId } = await liveFact();
    const reviewId = await openReview(factId);
    const change = scene("{NAME} the review's change.");

    const outside = await request(app).put(url(factId, `/${gagId}`)).send({ content: change });
    assert.equal(outside.status, 409);
    assert.equal(outside.body.code, "REVIEW_NOT_EDITABLE");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId })).status, 200);
  });

  it("advancing to Test Renders draws only changed gags' male renders, once: none for an unchanged gag (plan PLAN_GAG_EXAMPLES.md)", async () => {
    const { factId, gagId } = await liveFact();
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} a second gag.") });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    await approveSet(factId, secondId, scene("{NAME} a second gag."));
    const reviewId = await openReview(factId);
    assert.equal((await request(app).put(url(factId, `/${secondId}`)).send({ content: scene("{NAME} the second, changed."), reviewId })).status, 200);
    const count = async (gid: number) => (await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, gid))).length;
    const before = { first: await count(gagId), second: await count(secondId) };

    // No vendor call: the i2i reference upload is stubbed, as the render tests do.
    __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
    try {
      await ensureReviewIterationRenders(reviewId, { adminUserId: adminId });
      await ensureReviewIterationRenders(reviewId, { adminUserId: adminId });
    } finally {
      __setReferenceFalUploadForTest(null);
    }
    assert.equal(await count(gagId), before.first, "an unchanged gag gets no render");
    assert.equal(await count(secondId), before.second + 1, "the changed gag gets one male render, once");
  });

  it("the list's render state counts each gag that is not removed: one finishing never hides another (Codex, PR #956 round 2)", async () => {
    const { factId, gagId } = await liveFact();
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} gag two.") });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    const reviewId = await openReview(factId);
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
    // A superseded failure of a gag does not poison its later success.
    await attempt(gagId, "done", "2026-01-01T00:03:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
    // A removed gag is no longer counted.
    await attempt(secondId, "failed", "2026-01-01T00:04:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "needs_attention");
    await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, secondId));
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
  });

  it("editing after picking cancels the pick", async () => {
    const { factId, gagId } = await liveFact();
    const reviewId = await openReview(factId);
    const change = scene("{NAME} picked.");
    await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId });
    await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change), reviewId });
    assert.equal(await examplesOf(gagId, "pending"), 1);
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} edited after the pick."), reviewId });
    assert.equal(await examplesOf(gagId, "pending"), 0, "the pick was for content the gag no longer holds");
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


describe("gag routes: a save carries the cast read from its own scene (plan PLAN_GAG_DIRECT_RENDER.md, C and F)", () => {
  const bare = (text: string, bubbles: VisualPromptStrategyOverride["bubbles"] = []): VisualPromptStrategyOverride =>
    ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text, bubbles });

  it("refuses a save with no cast, and stores nothing", async () => {
    const { factId, gagId } = await liveFact();
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: bare("{NAME} juggles planets.") });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CAST_MISSING");
    assert.equal((await gagRow(gagId)).pendingContent, null);
  });

  it("refuses a cast read from a different scene", async () => {
    const { factId, gagId } = await liveFact();
    const stale = { ...withCast(bare("{NAME} juggles planets.")), coreSceneOverride: "{NAME} juggles moons." };
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: stale });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CAST_STALE");
  });

  it("refuses a bubble whose speaker the cast does not bind, naming the speaker", async () => {
    const { factId, gagId } = await liveFact();
    const content = withCast(bare("{NAME} juggles planets alone.", [{ type: "speech", entity: "mom", text: "Careful!" }]));
    const unbound = { ...content, cast: [] };
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: unbound });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SPEAKER_NOT_IN_SCENE");
    assert.deepEqual(res.body.details, { speakers: ["mom"] });
  });

  it("stores the cast with the change, an empty cast told apart from none", async () => {
    const { factId, gagId } = await liveFact();
    const withSpeaker = withCast(bare("{NAME} juggles planets; mom watches.", [{ type: "speech", entity: "mom", text: "Careful!" }]));
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: withSpeaker })).status, 200);
    const stored = normaliseGagContent((await gagRow(gagId)).pendingContent)!;
    assert.deepEqual(stored.cast, [{ label: "mom", description: "the mom in the scene" }]);
    const empty = withCast(bare("{NAME} juggles planets alone."));
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: empty })).status, 200);
    const storedEmpty = normaliseGagContent((await gagRow(gagId)).pendingContent)!;
    assert.deepEqual(storedEmpty.cast, []);
    assert.ok(storedEmpty.castExtraction, "an empty cast keeps its marker: extracted, nobody else there");
  });

  it("approves a render that drew the same scene, bubbles and cast entries, whatever extraction marker it froze; a different cast is a different picture (Codex 4600565971; PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const { factId, gagId } = await liveFact();
    const change = scene("{NAME} juggles planets (cast era).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change })).status, 200);
    const { cast: _c, castExtraction: _m, ...beforeCasts } = change;
    const old = await render(factId, gagId, beforeCasts as VisualPromptStrategyOverride, { kind: "male" });
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: old })).status, 200, "a render from before casts, of a gag whose cast is empty");
    const otherMarker = await render(factId, gagId, { ...change, castExtraction: { ...change.castExtraction!, promptVersion: "older", extractedAt: "2026-11-01T00:00:00.000Z" } }, { kind: "female" });
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherMarker })).status, 200, "the same cast read at another time");
    const otherCast = await render(factId, gagId, { ...change, cast: [{ label: "dog", description: "a dog" }] }, { kind: "female" });
    const castRefused = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherCast });
    assert.equal(castRefused.status, 409, "a render that drew a different cast is refused: the cast reaches the picture");
    assert.equal(castRefused.body.code, "CONTENT_CHANGED");
    const otherScene = await render(factId, gagId, scene("{NAME} juggles moons."), { kind: "pet" });
    const refused = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherScene });
    assert.equal(refused.status, 409, "a different picture is still refused");
    assert.equal(refused.body.code, "CONTENT_CHANGED");
  });

  it("a scene changed and changed back, its cast read again, keeps its render approvable", async () => {
    const { factId, gagId } = await liveFact();
    const a = scene("{NAME} juggles planets, round trip.");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: a })).status, 200);
    const drawn = await render(factId, gagId, a, { kind: "male" });
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} juggles moons, briefly.") })).status, 200);
    const reread = { ...a, cast: [], castExtraction: { ...a.castExtraction!, extractedAt: "2026-11-18T09:00:00.000Z" } };
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: reread })).status, 200);
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: drawn })).status, 200);
  });
});

describe("gag routes: reading a draft's cast stores nothing (plan PLAN_GAG_DIRECT_RENDER.md, F)", () => {
  it("returns the cast, its marker and any unbound speaker, passing the fact's labels, and writes no gag", async () => {
    const { factId, gagId } = await liveFact();
    const seen: unknown[] = [];
    const restore = __setDraftCastExtractorForTest(async (input) => {
      seen.push(input);
      return {
        cast: [{ label: "mom", description: "the woman in the passenger seat" }],
        unboundSpeakers: ["nurse"],
        extraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: castSourceKey(input.scene, input.bubbles) },
      };
    });
    try {
      const before = await gagRow(gagId);
      const bubbles = [{ type: "speech" as const, entity: "mom", text: "Slow!" }, { type: "speech" as const, entity: "nurse", text: "Hi" }];
      const res = await request(app).post(url(factId, "/cast")).send({ scene: "{NAME} drives; mom grips the dash.", bubbles });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.cast, [{ label: "mom", description: "the woman in the passenger seat" }]);
      assert.deepEqual(res.body.unboundSpeakers, ["nurse"]);
      assert.equal(res.body.castExtraction.sourceKey, castSourceKey("{NAME} drives; mom grips the dash.", bubbles));
      assert.equal((seen[0] as { scene: string }).scene, "{NAME} drives; mom grips the dash.");
      assert.ok(Array.isArray((seen[0] as { factCharacterLabels: unknown }).factCharacterLabels));
      assert.deepEqual(await gagRow(gagId), before, "nothing stored");
    } finally {
      restore();
    }
  });

  it("answers a failed reading as a failure, never an empty cast", async () => {
    const { factId } = await liveFact();
    const restore = __setDraftCastExtractorForTest(async () => { throw new Error("model down"); });
    try {
      const res = await request(app).post(url(factId, "/cast")).send({ scene: "{NAME} drives.", bubbles: [] });
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "CAST_FAILED");
      assert.equal(res.body.cast, undefined);
    } finally {
      restore();
    }
  });

  it("refuses an empty scene and an unknown fact", async () => {
    assert.equal((await request(app).post(url(999999999, "/cast")).send({ scene: "x", bubbles: [] })).status, 404);
    const { factId } = await liveFact();
    assert.equal((await request(app).post(url(factId, "/cast")).send({ scene: "", bubbles: [] })).status, 400);
  });
});
