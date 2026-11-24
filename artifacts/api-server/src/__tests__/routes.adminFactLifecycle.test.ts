/**
 * An approved fact's lifecycle actions on the fact sheet (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, design 3B; oracle items 12, 14
 * and 21; Issue #1018, the increment 3.2 outline):
 *
 *   - Publish changes swaps the draft in only when the draft meets the go-live
 *     rule, and refuses (changing nothing) when it does not or when there is
 *     nothing to publish;
 *   - Discard changes returns every gag to its published version with its
 *     published examples and removes a gag that was never published;
 *   - Deactivate keeps unpublished changes; Reactivate is refused unless the
 *     published set meets the go-live rule;
 *   - each action is recorded, a staging fact is a 404, and the sheet and the
 *     list say whether a fact has unpublished changes.
 *
 * 401/403 coverage is in routes.admin.auth.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable, adminActionsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  GAG_EXAMPLE_KINDS,
  SCENARIO_FOR_KIND,
  type GagExampleKind,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { withCast } from "./helpers/gagCast.js";
import { approveGagRender, createGag, saveGagContent } from "../lib/gags/gagStore.js";
import { publishDraft } from "../lib/gags/publish.js";

const RUN = randomUUID().slice(0, 8);
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (published).");
const B = scene("{NAME} lifts two moons (draft).");
const C = scene("{NAME} juggles the planets (new gag).");

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, kind: GagExampleKind): Promise<number> {
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
    generatedImageObjectPath: `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

const live = () => ({ adminId, reviewId: null });
const approveAll = async (factId: number, gagId: number, content: VisualPromptStrategyOverride) => {
  for (const kind of GAG_EXAMPLE_KINDS) await approveGagRender(factId, gagId, await render(factId, gagId, content, kind), live());
};
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const examples = async (gagId: number, stage: "approved" | "pending") =>
  db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, stage)));
const actions = async (factId: number, action: string) =>
  db.select().from(adminActionsTable).where(and(eq(adminActionsTable.factId, factId), eq(adminActionsTable.action, action)));
const isActive = async (factId: number) => (await db.select({ a: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, factId)))[0]!.a;
const post = (factId: number, action: string) => request(app).post(`/api/admin/facts/${factId}/${action}`);

/** A live fact (approved, recorded) with one carried-over gag showing A and no examples. */
async function grandfatheredFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} lifecycle ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A live fact whose published set meets the go-live rule. */
async function completeFact(): Promise<{ factId: number; gagId: number }> {
  const f = await grandfatheredFact();
  await approveAll(f.factId, f.gagId, A);
  await db.transaction((tx) => publishDraft(tx, f.factId, adminId));
  return f;
}

describe("an approved fact's lifecycle actions", () => {
  before(async () => {
    adminId = `t-lifecycle-${RUN}`;
    await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
    app = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
  });

  after(async () => {
    if (factIds.length) {
      await db.delete(adminActionsTable).where(inArray(adminActionsTable.factId, factIds));
      await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    }
    await db.delete(adminActionsTable).where(eq(adminActionsTable.actorId, adminId));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  describe("Publish changes", () => {
    it("publishes a draft that meets the go-live rule, and records it", async () => {
      const { factId, gagId } = await completeFact();
      await saveGagContent(factId, gagId, B, live());
      await approveAll(factId, gagId, B);

      const sheet = await request(app).get(`/api/admin/facts/${factId}/sheet`);
      assert.equal(sheet.body.hasUnpublishedChanges, true, `sheet: ${JSON.stringify(sheet.body).slice(0, 300)}`);
      const list = await request(app).get(`/api/admin/facts?search=${factId}&visibility=both`);
      assert.equal(list.body.facts.find((f: { id: number }) => f.id === factId)?.hasUnpublishedChanges, true, `list: ${JSON.stringify(list.body).slice(0, 400)}`);

      const res = await post(factId, "publish");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { published: 1, removed: 0, unchanged: 0 });
      const row = await gagRow(gagId);
      assert.equal(row.pendingContent, null);
      assert.equal((row.approvedContent as VisualPromptStrategyOverride).coreSceneOverride, B.coreSceneOverride);
      assert.equal((await examples(gagId, "approved")).length, 3);
      assert.equal((await actions(factId, "publish")).length, 1);
      assert.equal((await request(app).get(`/api/admin/facts/${factId}/sheet`)).body.hasUnpublishedChanges, false);
    });

    it("refuses a draft missing renders, naming the gap and changing nothing", async () => {
      const { factId, gagId } = await completeFact();
      await saveGagContent(factId, gagId, B, live());

      const res = await post(factId, "publish");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "GO_LIVE");
      assert.match(res.body.error, /Visual gag 1 needs male, female and pet renders approved/);
      const row = await gagRow(gagId);
      assert.equal((row.approvedContent as VisualPromptStrategyOverride).coreSceneOverride, A.coreSceneOverride);
      assert.equal((row.pendingContent as VisualPromptStrategyOverride).coreSceneOverride, B.coreSceneOverride);
      assert.equal((await actions(factId, "publish")).length, 0);
    });

    it("refuses when there is nothing to publish", async () => {
      const { factId } = await completeFact();
      const res = await post(factId, "publish");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "NO_CHANGES");
    });
  });

  describe("Discard changes", () => {
    it("returns changed gags to their published version and removes a never-published gag", async () => {
      const { factId, gagId } = await completeFact();
      const publishedExamples = (await examples(gagId, "approved")).map((e) => e.attemptId).sort();
      await saveGagContent(factId, gagId, B, live());
      await approveGagRender(factId, gagId, await render(factId, gagId, B, "male"), live());
      const added = await createGag(factId, C, live());

      const res = await post(factId, "discard");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { reverted: 1, removed: 1 });

      const row = await gagRow(gagId);
      assert.equal(row.pendingContent, null);
      assert.equal((row.approvedContent as VisualPromptStrategyOverride).coreSceneOverride, A.coreSceneOverride);
      assert.deepEqual((await examples(gagId, "approved")).map((e) => e.attemptId).sort(), publishedExamples);
      assert.equal((await examples(gagId, "pending")).length, 0);
      assert.notEqual((await gagRow(added.id)).removedAt, null, "the never-published gag is removed");
      assert.equal((await actions(factId, "discard")).length, 1);
      assert.equal((await request(app).get(`/api/admin/facts/${factId}/sheet`)).body.hasUnpublishedChanges, false);
    });

    it("puts back a published gag the draft removed", async () => {
      const { factId, gagId } = await completeFact();
      await db.update(factGagsTable).set({ draftRemoved: true }).where(eq(factGagsTable.id, gagId));
      assert.equal((await post(factId, "discard")).status, 200);
      assert.equal((await gagRow(gagId)).draftRemoved, false);
    });

    it("refuses when there is nothing to discard", async () => {
      const { factId } = await completeFact();
      const res = await post(factId, "discard");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "NO_CHANGES");
    });
  });

  describe("Deactivate and Reactivate", () => {
    it("deactivates keeping unpublished changes, then reactivates, recording both", async () => {
      const { factId, gagId } = await completeFact();
      await saveGagContent(factId, gagId, B, live());

      assert.equal((await post(factId, "deactivate")).status, 200);
      assert.equal(await isActive(factId), false);
      assert.notEqual((await gagRow(gagId)).pendingContent, null, "the draft survives deactivation");
      const again = await post(factId, "deactivate");
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "ALREADY");

      const res = await post(factId, "reactivate");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await isActive(factId), true);
      assert.notEqual((await gagRow(gagId)).pendingContent, null, "reactivating publishes nothing");
      assert.equal((await actions(factId, "deactivate")).length, 1);
      assert.equal((await actions(factId, "reactivate")).length, 1);
    });

    it("refuses to reactivate a fact whose published set fails the go-live rule", async () => {
      const { factId } = await grandfatheredFact();
      assert.equal((await post(factId, "deactivate")).status, 200);
      const res = await post(factId, "reactivate");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "GO_LIVE");
      assert.equal(await isActive(factId), false);
      assert.equal((await actions(factId, "reactivate")).length, 0);
    });
  });

  describe("History", () => {
    it("lists the fact's actions newest first, with who did them, including a Triage action keyed only to its review", async () => {
      const { factId, gagId } = await completeFact();
      const [review] = await db.insert(pendingReviewsTable).values({ submittedText: `{NAME} history ${RUN}`, stagingFactId: factId, approvedFactId: factId, status: "approved" }).returning({ id: pendingReviewsTable.id });
      await db.insert(adminActionsTable).values({ reviewId: review!.id, actorId: adminId, action: "duplicate_check", detail: { outcome: "distinct" }, createdAt: new Date(Date.now() - 60_000) });
      await saveGagContent(factId, gagId, B, live());
      assert.equal((await post(factId, "discard")).status, 200);
      assert.equal((await post(factId, "deactivate")).status, 200);

      const res = await request(app).get(`/api/admin/facts/${factId}/history`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const actionsSeen = (res.body.history as { action: string }[]).map((h) => h.action);
      assert.deepEqual(actionsSeen.slice(0, 2), ["deactivate", "discard"], "newest first");
      assert.equal(actionsSeen.at(-1), "duplicate_check", "the review-only Triage record is included, oldest");
      const entry = res.body.history[0];
      assert.equal(entry.actorId, adminId);
      assert.equal(entry.actorName, `${adminId}@test.local`);
      assert.ok(Date.parse(entry.createdAt));
      await db.delete(adminActionsTable).where(eq(adminActionsTable.reviewId, review!.id));
      await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.id, review!.id));
    });

    it("leaves out another fact's records", async () => {
      const a = await completeFact();
      const b = await completeFact();
      assert.equal((await post(b.factId, "deactivate")).status, 200);
      const res = await request(app).get(`/api/admin/facts/${a.factId}/history`);
      assert.equal(res.status, 200);
      assert.equal((res.body.history as { action: string }[]).some((h) => h.action === "deactivate"), false);
    });
  });

  it("is a 404 for a staging fact, for every action", async () => {
    const [f] = await db.insert(factsTable).values({ text: `{NAME} staged ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false }).returning({ id: factsTable.id });
    factIds.push(f!.id);
    for (const action of ["publish", "discard", "deactivate", "reactivate"]) {
      assert.equal((await post(f!.id, action)).status, 404, action);
    }
    assert.equal((await request(app).get(`/api/admin/facts/${f!.id}/history`)).status, 404, "history");
  });
});
