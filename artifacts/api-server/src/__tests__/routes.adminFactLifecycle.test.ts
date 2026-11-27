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
import { giveReviewedDescription } from "./helpers/gagExampleSets.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable, adminActionsTable, commentsTable, hashtagsTable } from "@workspace/db";
import { deleteFact } from "../lib/factLifecycle.js";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  // The go-live rule also asks a new or changed gag for a reviewed description (Issue #1331).
  await giveReviewedDescription(gagId, content);
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
    await db.delete(hashtagsTable).where(sql`${hashtagsTable.name} LIKE ${`lc${RUN.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()}%`}`);
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

    // Issue #1284: each line names its gag (by slot) and, for a render, its picture,
    // read from what the record already stores, so records written before the
    // change are named too. A record whose gag or picture can't be found names neither.
    it("names each record's gag by its slot and a render's picture, from the ids the record stores", async () => {
      const { factId, gagId } = await completeFact();
      const slot = (await gagRow(gagId)).slot;
      const petAttempt = await render(factId, gagId, A, "pet");
      await db.update(imagePromptAttemptsTable).set({ reviewReferenceIdentityType: "nonhuman_animal" }).where(eq(imagePromptAttemptsTable.id, petAttempt));
      const femaleAttempt = await render(factId, gagId, A, "female");
      await db.update(imagePromptAttemptsTable).set({ reviewReferenceIdentityType: "female" }).where(eq(imagePromptAttemptsTable.id, femaleAttempt));
      assert.equal((await post(factId, "deactivate")).status, 200);
      const t = Date.now() + 60_000;
      await db.insert(adminActionsTable).values([
        { factId, actorId: adminId, action: "gag_render_approval", detail: { gagId, attemptId: petAttempt }, createdAt: new Date(t + 4) },
        { factId, actorId: adminId, action: "test_renders_requested", detail: { attemptId: femaleAttempt }, createdAt: new Date(t + 3) },
        { factId, actorId: adminId, action: "gag_save", detail: { gagId, content: A }, createdAt: new Date(t + 2) },
        { factId, actorId: adminId, action: "gag_renders_requested", detail: { gagId, kinds: ["female", "pet"] }, createdAt: new Date(t + 1) },
        { factId, actorId: adminId, action: "gag_remove", detail: { gagId: 2_000_000_000 }, createdAt: new Date(t) },
      ]);
      const res = await request(app).get(`/api/admin/facts/${factId}/history`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const top = (res.body.history as { action: string; gagSlot: number | null; picture: string | null }[]).slice(0, 5)
        .map((h) => [h.action, h.gagSlot, h.picture]);
      assert.deepEqual(top, [
        ["gag_render_approval", slot, "pet"],
        ["test_renders_requested", slot, "female"],
        ["gag_save", slot, null],
        ["gag_renders_requested", slot, null],
        ["gag_remove", null, null],
      ]);
      const plain = (res.body.history as { action: string; gagSlot: number | null; picture: string | null }[]).find((h) => h.action === "deactivate");
      assert.deepEqual([plain?.gagSlot, plain?.picture], [null, null], "a record about no gag names none");
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

  describe("Permanent delete", () => {
    const factRow = async (id: number) => (await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)))[0];
    const del = (id: number) => request(app).delete(`/api/admin/facts/${id}`);

    it("deletes a deactivated fact with nothing attached, and the record keeps its id and wording", async () => {
      const { factId } = await completeFact();
      assert.equal((await post(factId, "deactivate")).status, 200);
      const res = await del(factId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await factRow(factId), undefined, "the fact row is gone");
      const [record] = await db.select().from(adminActionsTable)
        .where(and(eq(adminActionsTable.action, "delete"), eq(adminActionsTable.actorId, adminId), sql`${adminActionsTable.detail} ->> 'factId' = ${String(factId)}`));
      assert.ok(record, "the delete is recorded");
      assert.equal(record.factId, null, "the record's fact reference is nulled by the delete");
      assert.match(String((record.detail as { text?: string }).text), /lifecycle/);
    });

    it("refuses a live fact: deactivate first", async () => {
      const { factId } = await completeFact();
      const res = await del(factId);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "STILL_LIVE");
      assert.ok(await factRow(factId));
    });

    it("refuses while a member's comment is attached, naming the count", async () => {
      const { factId } = await completeFact();
      assert.equal((await post(factId, "deactivate")).status, 200);
      await db.insert(commentsTable).values({ factId, text: "a member's comment" });
      const res = await del(factId);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "MEMBER_CONTENT_ATTACHED");
      assert.deepEqual(res.body.attached, { memes: 0, aiPictures: 0, comments: 1 });
      assert.equal(res.body.error, "Members have 1 comment on this fact, so it can't be deleted. Deactivating keeps it off the site.");
      assert.ok(await factRow(factId));
      // The sheet counts it the same way, though the public counter (approved only) reads 0.
      const sheet = await request(app).get(`/api/admin/facts/${factId}/sheet`);
      assert.deepEqual(sheet.body.usage, res.body.attached, "the sheet's count is the count the delete refuses with");
      assert.equal(sheet.body.commentCount, 0);
    });

    it("a rejected comment holds the delete too, and the sheet says so", async () => {
      const { factId } = await completeFact();
      assert.equal((await post(factId, "deactivate")).status, 200);
      await db.insert(commentsTable).values({ factId, text: "a rejected comment", status: "rejected" });
      const res = await del(factId);
      assert.equal(res.body.code, "MEMBER_CONTENT_ATTACHED");
      const sheet = await request(app).get(`/api/admin/facts/${factId}/sheet`);
      assert.deepEqual(sheet.body.usage, { memes: 0, aiPictures: 0, comments: 1 });
    });

    it("lowers each of the fact's hashtags by one, keeping another fact's share; a refused delete changes none", async () => {
      const tag = (s: string) => `lc${RUN.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()}${s}`;
      const shared = tag("shared");
      const solo = tag("solo");
      const counts = async () => Object.fromEntries((await db.select({ name: hashtagsTable.name, n: hashtagsTable.factCount }).from(hashtagsTable)
        .where(inArray(hashtagsTable.name, [shared, solo]))).map((r) => [r.name, r.n]));
      const { factId } = await completeFact();
      const { factId: other } = await completeFact();
      assert.equal((await request(app).put(`/api/admin/facts/${factId}/hashtags`).send({ hashtags: [shared, solo] })).status, 200);
      assert.equal((await request(app).put(`/api/admin/facts/${other}/hashtags`).send({ hashtags: [shared] })).status, 200);
      assert.deepEqual(await counts(), { [shared]: 2, [solo]: 1 });
      assert.equal((await post(factId, "deactivate")).status, 200);

      await db.insert(commentsTable).values({ factId, text: "holds it" });
      assert.equal((await del(factId)).body.code, "MEMBER_CONTENT_ATTACHED");
      assert.deepEqual(await counts(), { [shared]: 2, [solo]: 1 }, "a refused delete changes no count");

      await db.delete(commentsTable).where(eq(commentsTable.factId, factId));
      assert.equal((await del(factId)).status, 200);
      assert.deepEqual(await counts(), { [shared]: 1, [solo]: 0 });
    });

    it("holds against a comment being attached at the same moment: the check and the delete are one operation", async () => {
      const { factId } = await completeFact();
      assert.equal((await post(factId, "deactivate")).status, 200);
      // A member's comment insert is in flight, uncommitted, when the delete starts.
      let commit!: () => void;
      const held = new Promise<void>((r) => { commit = r; });
      let inserted!: () => void;
      const insertStarted = new Promise<void>((r) => { inserted = r; });
      const member = db.transaction(async (tx) => {
        await tx.insert(commentsTable).values({ factId, text: "posted at the same moment" });
        inserted();
        await held;
      });
      await insertStarted;
      let settled = false;
      const deleting = deleteFact(factId, adminId).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, "the delete waits for the member's insert");
      commit();
      await member;
      const result = await deleting;
      assert.equal(result.kind, "attached", JSON.stringify(result));
      assert.ok(await factRow(factId), "the fact and the comment survive");
    });

    it("is a 404 for a fact never approved", async () => {
      const [f] = await db.insert(factsTable).values({ text: `{NAME} staged ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false }).returning({ id: factsTable.id });
      factIds.push(f!.id);
      assert.equal((await del(f!.id)).status, 404);
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
