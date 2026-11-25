/**
 * Issue #1304, increment B (plan docs/plans/PLAN_RENDER_HISTORY.md D1, D4, D5,
 * D6): a gag's render roles, its paged history with each render's record and
 * approval state, the billed-cost fill, and deleting an old render with its
 * refusals.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable } from "@workspace/db";
import {
  adminActionsTable, adminConfigTable, imageGenerationRequestsTable, imagePromptAttemptsTable, pendingReviewsTable, storedFileDeletionsTable,
} from "@workspace/db/schema";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE, GAG_EXAMPLE_KINDS, SCENARIO_FOR_KIND, buildPlaceholderFactEnrichment,
  type GagExampleKind, type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import gagsRouter from "../routes/gags.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { withCast } from "./helpers/gagCast.js";
import { GagError, approveGagRender, deleteGagRender } from "../lib/gags/gagStore.js";
import { buildFactGagsView } from "../lib/gags/gagView.js";
import { HISTORY_PAGE_SIZE, approvalOf, gagRenderHistory, renderCostOf, removedGagHistories } from "../lib/gags/renderHistory.js";
import { billingWindows, runRenderBillingFill } from "../lib/renderBilling.js";
import { RENDER_APPROVAL_AUDIT_KEY } from "../lib/renderApprovalAudit.js";
import { __setFileRemoverForTest } from "../lib/storedFileDeletions.js";

const RUN = randomUUID().slice(0, 8);
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon.");
const B = scene("{NAME} lifts the sun.");
let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];
const removed: string[] = [];

/** A submission at Test Renders with gag A in its draft. */
async function submission(): Promise<{ factId: number; gagId: number; reviewId: number }> {
  const [f] = await db.insert(factsTable).values({ text: `{NAME} history ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
  factIds.push(f!.id);
  const [g] = await db.insert(factGagsTable).values({ factId: f!.id, slot: 1, pendingContent: A as never }).returning({ id: factGagsTable.id });
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: "submission", submittedById: adminId, status: "pending", workflowStage: "test_renders",
    stagingFactId: f!.id, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return { factId: f!.id, gagId: g!.id, reviewId: review!.id };
}

/** A render of `gagId` that drew `content`, `minutesAgo` old; finished unless told otherwise. */
async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, opts: { kind?: GagExampleKind; minutesAgo?: number; failed?: boolean; unfinished?: boolean } = {}): Promise<number> {
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId, gagId,
    reviewRenderScenarioKey: SCENARIO_FOR_KIND[opts.kind ?? "male"],
    reviewReferenceIdentityType: opts.kind === "pet" ? "nonhuman_animal" : opts.kind ?? "male",
    reviewReferenceAssetVersion: "v3",
    renderJobId: randomUUID(),
    generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
    actualImageEngineId: "nano-banana-2-1-edit",
    sourceImageAnalysis: {} as never, identityPolicy: {} as never,
    renderControls: { reviewAudit: { reviewId: null, adminUserId: adminId } } as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    compiledPrompt: { imagePrompt: "a moon" } as never,
    generatedImageObjectPath: opts.unfinished || opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
    createdAt: new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000),
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

async function request_(attemptId: number, factId: number, over: { vendorRequestId?: string | null; billedUsd?: string | null; checked?: boolean; daysAgo?: number } = {}) {
  const [row] = await db.insert(imageGenerationRequestsTable).values({
    producer: "review_render", engineId: "nano-banana-2-1-edit", endpointId: "google/nano-banana-2.1/edit",
    request: { prompt: "a moon" }, vendorRequestId: over.vendorRequestId === undefined ? `v-${randomUUID()}` : over.vendorRequestId,
    attemptId, factId, actorKind: "admin", actorUserId: adminId,
    billedUsd: over.billedUsd ?? null, billingCheckedAt: over.checked ? new Date() : null,
    createdAt: new Date(Date.now() - (over.daysAgo ?? 0) * 86_400_000),
  }).returning();
  return row!;
}

const pick = (gagId: number, kind: GagExampleKind, stage: "approved" | "pending", attemptId: number) =>
  db.insert(factGagExamplesTable).values({ gagId, subjectKind: kind, stage, attemptId, approvedBy: adminId });

before(async () => {
  adminId = `t-hist-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, displayName: "Hist Admin", isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
});

after(async () => {
  __setFileRemoverForTest(null);
  await db.delete(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.factId, factIds.length ? factIds : [-1]));
  await db.delete(storedFileDeletionsTable).where(like(storedFileDeletionsTable.path, "/objects/ai-bg-v2/%"));
  await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, adminId));
  if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(adminActionsTable).where(eq(adminActionsTable.actorId, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("a picture's roles (D1)", () => {
  it("live is the published pick, approved-for-next the differing draft pick, working the newest render; approval never moves working back", async () => {
    const { factId, gagId, reviewId } = await submission();
    const published = await render(factId, gagId, A, { minutesAgo: 30 });
    const draft = await render(factId, gagId, A, { minutesAgo: 20 });
    const newest = await render(factId, gagId, B, { minutesAgo: 10 });
    await pick(gagId, "male", "approved", published);
    await pick(gagId, "male", "pending", draft);
    let roles = (await buildFactGagsView(factId))!.gags[0]!.roles.male;
    assert.equal(roles.live?.attemptId, published);
    assert.equal(roles.approvedNext?.attemptId, draft);
    assert.equal(roles.working?.latestAttemptId, newest);
    assert.equal(roles.working?.stale, true, "drawn from a different version than the one being worked on");

    // Approving an older render of the current content does not make it the working one.
    await db.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "pending")));
    await approveGagRender(factId, gagId, draft, { adminId, reviewId });
    roles = (await buildFactGagsView(factId))!.gags[0]!.roles.male;
    assert.equal(roles.working?.latestAttemptId, newest, "approval never resurrects an older working render");
    assert.equal(roles.approvedNext?.attemptId, draft);

    // When the draft pick is the published one, it is shown once, as live.
    await db.update(factGagExamplesTable).set({ attemptId: published }).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "pending")));
    const all = (await buildFactGagsView(factId))!.gags[0]!.roles;
    assert.equal(all.male.approvedNext, null);
    assert.equal(all.female.working, null, "no render of a picture: no working render");
  });
});

describe("a gag's history (D4)", () => {
  it("lists every render newest first, failed ones included, each with its record, roles and approval", async () => {
    const { factId, gagId } = await submission();
    const failed = await render(factId, gagId, A, { minutesAgo: 30, failed: true, kind: "pet" });
    const done = await render(factId, gagId, A, { minutesAgo: 20 });
    await request_(done, factId, { billedUsd: "0.0390" });
    await request_(done, factId);
    await pick(gagId, "male", "pending", done);

    const page = await gagRenderHistory(factId, gagId);
    assert.deepEqual(page.entries.map((e) => e.attemptId), [done, failed]);
    const [d, f] = page.entries as [typeof page.entries[0], typeof page.entries[0]];
    assert.equal(d.kind, "male");
    assert.deepEqual(d.drawnBy, { userId: adminId, name: "Hist Admin" });
    assert.equal(d.gag?.coreSceneOverride, A.coreSceneOverride, "the gag as it was drawn");
    assert.deepEqual(d.reference, { identityType: "male", assetVersion: "v3" });
    assert.equal(d.engine.engineId, "nano-banana-2-1-edit");
    assert.deepEqual(d.prompt.compiled, { imagePrompt: "a moon" });
    assert.equal(d.prompt.requests.length, 2);
    assert.deepEqual(d.prompt.requests[0]!.request, { prompt: "a moon" });
    assert.equal(d.status, "done");
    assert.ok(d.imageUrl);
    assert.deepEqual(d.roles.sort(), ["approved_next", "working"].sort(), "both working and official; its record is still here");
    assert.equal(d.approval, "approved");
    assert.deepEqual(d.cost, { state: "billed", usd: 0.039, unbilledRequests: 1 }, "the known amount and what is still outstanding");
    assert.equal(f.status, "failed");
    assert.equal(f.error, "vendor failed");
    assert.equal(f.kind, "pet");
    assert.deepEqual(f.cost, { state: "never_sent" });
  });

  it("another fact's gag id reads nothing", async () => {
    const one = await submission();
    const two = await submission();
    await render(one.factId, one.gagId, A);
    assert.equal((await gagRenderHistory(two.factId, one.gagId)).entries.length, 0);
  });

  it("pages 50 at a time, so the oldest render is reachable", async () => {
    const { factId, gagId } = await submission();
    const ids: number[] = [];
    for (let i = 0; i < HISTORY_PAGE_SIZE + 2; i++) ids.push(await render(factId, gagId, A, { minutesAgo: 1000 - i }));
    const first = await gagRenderHistory(factId, gagId);
    assert.equal(first.entries.length, HISTORY_PAGE_SIZE);
    assert.ok(first.nextBefore);
    const second = await gagRenderHistory(factId, gagId, first.nextBefore!);
    assert.deepEqual(second.entries.map((e) => e.attemptId), [ids[1], ids[0]], "the oldest two, newest first");
    assert.equal(second.nextBefore, null);
  });

  it("a removed gag's history is listed by the gag's own id", async () => {
    const { factId, gagId } = await submission();
    await render(factId, gagId, A);
    assert.deepEqual(await removedGagHistories(factId), []);
    await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, gagId));
    const removedGags = await removedGagHistories(factId);
    assert.equal(removedGags.length, 1);
    assert.equal(removedGags[0]!.gagId, gagId);
    assert.equal(removedGags[0]!.renders, 1);
    assert.equal((await gagRenderHistory(factId, gagId)).entries.length, 1);
  });

  it("approval: any evidence reads approved; none reads not recorded before the boundary and not approved after it", async () => {
    const { factId, gagId } = await submission();
    const viaRecord = await render(factId, gagId, A, { minutesAgo: 40 });
    const viaLegacy = await render(factId, gagId, A, { minutesAgo: 35 });
    const older = await render(factId, gagId, A, { minutesAgo: 30 });
    const newer = await render(factId, gagId, A, { minutesAgo: 1 });
    // A post-0152 approval whose record survived but whose pick was replaced.
    await db.insert(adminActionsTable).values({ factId, actorId: adminId, action: "gag_render_approval", detail: { gagId, attemptId: viaRecord } });
    await db.update(factGagsTable).set({ approvedExampleAttemptId: viaLegacy }).where(eq(factGagsTable.id, gagId));
    const prior = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
    try {
      let byId = new Map((await gagRenderHistory(factId, gagId)).entries.map((e) => [e.attemptId, e.approval]));
      assert.equal(byId.get(viaRecord), "approved");
      assert.equal(byId.get(viaLegacy), "approved");
      assert.equal(byId.get(newer), "not_recorded", "with no boundary set, nothing can be said to be not approved");
      // The boundary falls between them: an approval write that failed before it left no trace.
      await db.insert(adminConfigTable).values({ key: RENDER_APPROVAL_AUDIT_KEY, value: new Date(Date.now() - 10 * 60_000).toISOString(), dataType: "text", label: "x" });
      byId = new Map((await gagRenderHistory(factId, gagId)).entries.map((e) => [e.attemptId, e.approval]));
      assert.equal(byId.get(older), "not_recorded", "drawn before every approval was recorded");
      assert.equal(byId.get(newer), "not_approved");
    } finally {
      await db.delete(adminConfigTable).where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY));
      if (prior.length) await db.insert(adminConfigTable).values(prior);
    }
    assert.equal(approvalOf({ id: 1, createdAt: new Date() }, new Set(), null), "not_recorded");
  });
});

describe("billed cost (D5)", () => {
  it("reads each state from stored bills", () => {
    const r = (v: string | null, billed: string | null, checked: boolean) => ({ vendorRequestId: v, billedUsd: billed, billingCheckedAt: checked ? new Date() : null });
    assert.deepEqual(renderCostOf([r(null, null, false)], true), { state: "never_sent" });
    assert.deepEqual(renderCostOf([r("a", "0.0100", true), r("b", "0.0250", true)], true), { state: "billed", usd: 0.035, unbilledRequests: 0 }, "a render with several requests sums them");
    assert.deepEqual(renderCostOf([r("a", "0.0100", true), r("b", null, false)], false), { state: "billed", usd: 0.01, unbilledRequests: 1 });
    assert.deepEqual(renderCostOf([r("a", null, false)], true), { state: "not_checked" });
    assert.deepEqual(renderCostOf([r("a", null, true)], true), { state: "no_bill_found" });
    assert.deepEqual(renderCostOf([r("a", null, true)], false), { state: "billing_key_not_set" });
  });

  it("the fill sums a request's events, looks an old request up in its own window, and marks an unbilled one checked", async () => {
    const { factId, gagId } = await submission();
    const attempt = await render(factId, gagId, A);
    const fresh = await request_(attempt, factId, { vendorRequestId: `fresh-${RUN}` });
    const old = await request_(attempt, factId, { vendorRequestId: `old-${RUN}`, daysAgo: 120 });
    const unbilled = await request_(attempt, factId, { vendorRequestId: `none-${RUN}` });
    const windows: [string, string][] = [];
    const counts = await runRenderBillingFill({
      batch: 10_000,
      fetchEvents: async (start, end) => {
        windows.push([start, end]);
        return [
          { request_id: `fresh-${RUN}`, cost_total: 0.02 }, { request_id: `fresh-${RUN}`, cost_total: 0.015 },
          { request_id: `old-${RUN}`, cost_total: 0.04 },
        ];
      },
    });
    for (const [s, e] of windows) assert.ok(new Date(e).getTime() - new Date(s).getTime() <= 90 * 86_400_000, "no window is longer than fal's 90 days");
    assert.ok(windows.length >= 2, "a request older than 90 days is looked up in its own window");
    const row = async (id: number) => (await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, id)))[0]!;
    assert.equal(Number((await row(fresh.id)).billedUsd), 0.035, "several events for one request are summed");
    assert.equal(Number((await row(old.id)).billedUsd), 0.04);
    const none = await row(unbilled.id);
    assert.equal(none.billedUsd, null);
    assert.ok(none.billingCheckedAt, "checked, no bill found yet");
    assert.ok(counts.filled >= 2);
  });

  it("a failed lookup changes nothing and reports itself", async () => {
    const { factId, gagId } = await submission();
    const attempt = await render(factId, gagId, A);
    const req = await request_(attempt, factId, { vendorRequestId: `fail-${RUN}` });
    await assert.rejects(runRenderBillingFill({ batch: 10_000, fetchEvents: async () => { throw new Error("fal down"); } }), /billing lookups failed/);
    const [row] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, req.id));
    assert.equal(row!.billingCheckedAt, null, "not checked stays not checked");
  });

  it("windows group by creation date and never exceed 90 days", () => {
    const now = new Date("2026-11-25T00:00:00Z");
    const d = (days: number) => ({ createdAt: new Date(now.getTime() - days * 86_400_000) });
    const w = billingWindows([d(200), d(150), d(10), d(0)], now);
    assert.equal(w.length, 2);
    assert.equal(w[1]!.end.getTime(), now.getTime(), "the newest window ends now");
  });
});

describe("deleting an old render (D6)", () => {
  it("an eligible render's row goes and its file reaches the cleanup list in the same commit, recorded in History", async () => {
    __setFileRemoverForTest({ async deleteObject(p) { removed.push(p); } });
    const { factId, gagId, reviewId } = await submission();
    const old = await render(factId, gagId, A, { minutesAgo: 30 });
    await render(factId, gagId, A, { minutesAgo: 1 });
    const [{ path }] = await db.select({ path: imagePromptAttemptsTable.generatedImageObjectPath }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, old));
    const res = await request(app).post(`/api/admin/facts/${factId}/gags/${gagId}/renders/${old}/delete`).send({ reviewId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { deleted: true, fileStillBeingRemoved: false });
    assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, old))).length, 0);
    const [queued] = await db.select().from(storedFileDeletionsTable).where(eq(storedFileDeletionsTable.path, path!));
    assert.equal(queued!.reason, "render_delete");
    assert.ok(queued!.doneAt);
    assert.ok(removed.includes(path!));
    const [record] = await db.select().from(adminActionsTable).where(and(eq(adminActionsTable.factId, factId), eq(adminActionsTable.action, "render_delete")));
    assert.equal((record!.detail as { attemptId: number }).attemptId, old);
    // A stale screen's approval of the deleted render is refused as not found.
    await assert.rejects(approveGagRender(factId, gagId, old, { adminId, reviewId }), (e: unknown) => e instanceof GagError && e.status === 404);
  });

  it("says when the file is still being removed", async () => {
    __setFileRemoverForTest({ async deleteObject() { throw new Error("bucket down"); } });
    const { factId, gagId, reviewId } = await submission();
    const old = await render(factId, gagId, A);
    const res = await request(app).post(`/api/admin/facts/${factId}/gags/${gagId}/renders/${old}/delete`).send({ reviewId });
    assert.deepEqual(res.body, { deleted: true, fileStillBeingRemoved: true });
    __setFileRemoverForTest(null);
  });

  it("refuses a pick, a running render and another fact's render, each with its reason, and changes nothing", async () => {
    const { factId, gagId, reviewId } = await submission();
    const live = await render(factId, gagId, A, { minutesAgo: 5 });
    const next = await render(factId, gagId, A, { minutesAgo: 4, kind: "female" });
    const running = await render(factId, gagId, A, { unfinished: true });
    await pick(gagId, "male", "approved", live);
    await pick(gagId, "female", "pending", next);
    const other = await submission();
    const foreign = await render(other.factId, other.gagId, A);
    const del = (id: number, g = gagId) => request(app).post(`/api/admin/facts/${factId}/gags/${g}/renders/${id}/delete`).send({ reviewId });
    for (const [id, code, status] of [[live, "RENDER_IN_USE", 409], [next, "RENDER_IN_USE", 409], [running, "RENDER_RUNNING", 409], [foreign, "RENDER_NOT_FOUND", 404]] as const) {
      const res = await del(id);
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.equal(res.body.code, code);
      assert.ok(res.body.error);
      assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, id))).length, 1);
    }
  });

  it("holds against an approval at the same moment: the approval commits first, and the delete is refused", async () => {
    const { factId, gagId, reviewId } = await submission();
    const target = await render(factId, gagId, A);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const approving = db.transaction(async (tx) => {
      await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, factId)).for("no key update");
      locked();
      await held;
      await tx.insert(factGagExamplesTable).values({ gagId, subjectKind: "male", stage: "pending", attemptId: target, approvedBy: adminId });
    });
    await lockTaken;
    const deleting = deleteGagRender(factId, gagId, target, { adminId, reviewId }).then(() => "deleted", (e) => (e as GagError).code);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await approving;
    assert.equal(await deleting, "RENDER_IN_USE");
  });

  it("a failure inside the delete rolls back both the row and the cleanup list", async () => {
    const { factId, gagId } = await submission();
    const target = await render(factId, gagId, A);
    const [{ path }] = await db.select({ path: imagePromptAttemptsTable.generatedImageObjectPath }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, target));
    // An admin id that does not exist fails the History record, inside the transaction.
    await assert.rejects(deleteGagRender(factId, gagId, target, { adminId: `missing-${RUN}`, reviewId: null }));
    assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, target))).length, 1);
    assert.equal((await db.select().from(storedFileDeletionsTable).where(eq(storedFileDeletionsTable.path, path!))).length, 0);
  });

  it("is admin only", async () => {
    const { factId, gagId } = await submission();
    const target = await render(factId, gagId, A);
    const anon = buildTestApp({ kind: "unauthenticated" }, gagsRouter);
    assert.equal((await request(anon).post(`/api/admin/facts/${factId}/gags/${gagId}/renders/${target}/delete`).send({})).status, 401);
    assert.equal((await request(anon).get(`/api/admin/facts/${factId}/gags/${gagId}/render-history`)).status, 401);
  });

  it("the history route answers a page", async () => {
    const { factId, gagId } = await submission();
    await render(factId, gagId, A);
    const res = await request(app).get(`/api/admin/facts/${factId}/gags/${gagId}/render-history`);
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.nextBefore, null);
  });
});

void GAG_EXAMPLE_KINDS;
