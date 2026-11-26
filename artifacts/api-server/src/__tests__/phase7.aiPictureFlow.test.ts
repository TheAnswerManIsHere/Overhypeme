/**
 * The Phase 7 amendment — making an AI picture becomes its own flow (plan
 * docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md, approved by David 2026-11-26,
 * Issue #1331), the server half's invariants (Testing Plan):
 *
 *   - photo preparation spends no credit and queues nothing, refuses an
 *     unowned upload, reads a failed check as "try again", never as a verdict;
 *   - a picture records the caption it was made for and the shape it was drawn
 *     in, and its state reads both back; the draw uses the subject, never the
 *     caption;
 *   - descriptions: a member sees only a reviewed description of the exact
 *     published content; a draft's description waits for the publish; a review
 *     publishes nothing else and keeps example picks; a stale version is
 *     refused; the drafting sweep fills both versions, never replaces a
 *     moderator's text, records failures, and re-runs as a no-op;
 *   - coverage at publication: new or changed content needs its reviewed
 *     description; an unchanged published gag without one blocks nothing.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";

import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable, factGagDescriptionsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { imagePromptAttemptsTable, asyncJobsTable, userGenerationCostsTable, adminConfigTable } from "@workspace/db/schema";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, buildPlaceholderFactEnrichment, type VisualPromptStrategyOverride } from "@workspace/api-zod";

import { requestMemberPicture } from "../lib/memberPictures/command.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { __setTier3ForTest } from "../lib/sourceImageAnalysis/index.js";
import { creditBalance } from "../lib/credits/ledger.js";
import { availableGags } from "../lib/gags/resolver.js";
import { publishDraft } from "../lib/gags/publish.js";
import { GoLiveError } from "../lib/gags/goLive.js";
import {
  DescriptionError,
  descriptionsToReview,
  gagContentFingerprint,
  runDescriptionSweep,
  saveReviewedDescription,
} from "../lib/gags/descriptions.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";
import { withCast } from "./helpers/gagCast.js";
import { giveExampleSet } from "./helpers/gagExampleSets.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import memberPicturesRouter from "../routes/memberPictures.js";

const RUN = randomUUID().slice(0, 8);
const userIds: string[] = [];
const factIds: number[] = [];
const photos = photoBackgrounds();
let adminId: string;

const PERSON = {
  subjectKind: "human_face", confidence: "high", hasUsableHumanFace: true, hasUsableSubject: true,
  subjectCount: 1, warnings: [], suggestedRenderMode: "human_identity_i2i",
} as const;
const PET = { ...PERSON, subjectKind: "animal", hasUsableHumanFace: false, suggestedRenderMode: "nonhuman_subject_i2i" } as const;

const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });

async function newMember(): Promise<string> {
  const id = `t-apf-${RUN}-${userIds.length}`;
  userIds.push(id);
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, isAdmin: false, membershipTier: "registered",
    displayName: "Jordan Tester", pronouns: "she/her", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
  });
  return id;
}

async function liveFact(text = "{NAME} throws the grenade."): Promise<{ factId: number; gagId: number; content: VisualPromptStrategyOverride }> {
  const content = scene(text);
  const f = await insertLiveFact(
    { text: `{NAME} out-throws everyone ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() },
    content,
  );
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id, content };
}

/** Put a changed version in the gag's draft, with its three draft picks. */
async function draftChange(factId: number, gagId: number, content: VisualPromptStrategyOverride): Promise<void> {
  await db.update(factGagsTable).set({ pendingContent: content as never, pendingBy: adminId, pendingAt: new Date() }).where(eq(factGagsTable.id, gagId));
  await giveExampleSet(factId, gagId, content, "pending");
  // giveExampleSet records a reviewed description too; the tests below decide that themselves.
  await db.delete(factGagDescriptionsTable).where(eq(factGagDescriptionsTable.contentFingerprint, gagContentFingerprint(content)!));
}

const descriptionOf = async (factId: number) => (await availableGags(factId)).map((g) => g.description);

before(async () => {
  photos.setUp();
  process.env["FAL_AI_API_KEY"] ??= "test-fal-key";
  await db.insert(adminConfigTable).values({ key: "budget_per_credit_ceiling_usd", value: "0.30", dataType: "float", label: "t", description: "t" })
    .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "0.30" } });
  adminId = `t-apf-admin-${RUN}`;
  userIds.push(adminId);
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
});

beforeEach(() => {
  __setTier3ForTest(async () => ({ ...PERSON }) as never);
  __setReferenceFalUploadForTest(async () => "https://example.test/member-reference.jpg");
});
afterEach(() => {
  __setTier3ForTest(null);
  __setReferenceFalUploadForTest(null);
});

after(async () => {
  if (factIds.length) {
    const attempts = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    if (attempts.length) {
      await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, attempts.flatMap((a) => [`image_prompt:attempt:${a.id}`, `image_generation:attempt:${a.id}`])));
    }
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    // The gags go first, taking their examples and descriptions with them.
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
  }
  if (userIds.length) {
    await db.delete(userGenerationCostsTable).where(inArray(userGenerationCostsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (factIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await photos.tearDown();
});

describe("the flow's photo preparation", () => {
  const check = (userId: string, uploadKey: string) =>
    request(buildTestApp({ kind: "authenticated", userId }, memberPicturesRouter)).post("/api/member-pictures/photo-check").send({ uploadKey });

  it("answers person or pet, spends no credit and queues no picture", async () => {
    const userId = await newMember();
    const before = await creditBalance(userId);
    const person = await check(userId, await photos.seed(userId));
    assert.equal(person.status, 200, JSON.stringify(person.body));
    assert.equal(person.body.subject, "person");
    __setTier3ForTest(async () => ({ ...PET }) as never);
    const pet = await check(userId, await photos.seed(userId));
    assert.equal(pet.body.subject, "pet");
    assert.equal(await creditBalance(userId), before, "no credit spent");
    const attempts = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.userId, userId));
    assert.equal(attempts.length, 0, "no picture queued");
    const costs = await db.select().from(userGenerationCostsTable).where(eq(userGenerationCostsTable.userId, userId));
    assert.equal(costs.length, 2, "each paid check recorded once");
  });

  it("refuses an upload the member does not own", async () => {
    const owner = await newMember();
    const other = await newMember();
    const res = await check(other, await photos.seed(owner));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "upload_not_owned");
  });

  it("reads a check that could not run as 'try again', never as an unusable photo", async () => {
    const userId = await newMember();
    __setTier3ForTest(async () => { throw new Error("vision down"); });
    const res = await check(userId, await photos.seed(userId));
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "photo_check_failed");
    __setTier3ForTest(async () => ({ ...PERSON, hasUsableHumanFace: false, hasUsableSubject: false, subjectCount: 0, suggestedRenderMode: "t2i_fallback", warnings: ["no face"] }) as never);
    const unusable = await check(userId, await photos.seed(userId));
    assert.equal(unusable.status, 422);
    assert.equal(unusable.body.error, "photo_unusable");
  });
});

describe("a picture remembers its caption and shape", () => {
  it("records the caption and the shape, reads them back, and draws the subject, never the caption", async () => {
    const userId = await newMember();
    const { factId } = await liveFact();
    __setTier3ForTest(async () => ({ ...PET }) as never);
    const handle = await requestMemberPicture({
      userId, requestId: `req-${randomUUID()}`, factId, gagId: null, uploadKey: await photos.seed(userId), lookStyleId: null,
      subject: { kind: "pet", name: "Mango", pronouns: "he/him" }, aspectRatio: "landscape",
      caption: { name: "Riley", pronouns: "they/them" },
    });
    const [row] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, handle.attemptId));
    assert.deepEqual(row!.memberCaption, { name: "Riley", pronouns: "they/them" });
    assert.equal((row!.renderControls as { aspectRatio?: string }).aspectRatio, "landscape");
    assert.equal((row!.renderControls as { promptIdentity?: { name: string } }).promptIdentity?.name, "Mango", "the picture draws the pet");

    const state = await request(buildTestApp({ kind: "authenticated", userId }, memberPicturesRouter)).get(`/api/member-pictures/${handle.attemptId}`);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.picture.caption, { name: "Riley", pronouns: "they/them" });
    assert.equal(state.body.picture.aspectRatio, "landscape");
  });

  it("a picture made without a caption reads none", async () => {
    const userId = await newMember();
    const { factId } = await liveFact();
    const handle = await requestMemberPicture({
      userId, requestId: `req-${randomUUID()}`, factId, gagId: null, uploadKey: await photos.seed(userId), lookStyleId: null,
      subject: { kind: "me" }, aspectRatio: "square",
    });
    const state = await request(buildTestApp({ kind: "authenticated", userId }, memberPicturesRouter)).get(`/api/member-pictures/${handle.attemptId}`);
    assert.equal(state.body.picture.caption, null);
    assert.equal(state.body.picture.aspectRatio, "square");
  });
});

describe("a gag's description", () => {
  it("fingerprints a version as it draws: the scene and the bubbles change it", () => {
    const a = scene("{NAME} throws the grenade.");
    assert.equal(gagContentFingerprint(a), gagContentFingerprint(scene("{NAME} throws the grenade.")));
    assert.notEqual(gagContentFingerprint(a), gagContentFingerprint(scene("{NAME} throws the grenade twice.")));
    assert.notEqual(gagContentFingerprint(a), gagContentFingerprint({ ...a, bubbles: [{ type: "speech", entity: "subject", text: "Fore!" }] }));
  });

  it("members see only a reviewed description of the exact published content; a draft's waits for the publish", async () => {
    const { factId, gagId, content: A } = await liveFact();
    const B = scene("{NAME} throws the grenade and it bounces.");
    assert.deepEqual(await descriptionOf(factId), [null], "none until one is reviewed");

    await draftChange(factId, gagId, B);
    await saveReviewedDescription(gagId, gagContentFingerprint(B)!, "{NAME} bounces it off three groups.", adminId);
    assert.deepEqual(await descriptionOf(factId), [null], "the draft's description is not shown on the published version");

    await saveReviewedDescription(gagId, gagContentFingerprint(A)!, "{NAME} throws it in a straight line.", adminId);
    assert.deepEqual(await descriptionOf(factId), ["{NAME} throws it in a straight line."], "reviewing the published content's description shows it at once (Q15: 1)");
    const gag = (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
    assert.equal((gag.pendingContent as VisualPromptStrategyOverride).coreSceneOverride, B.coreSceneOverride, "the review published nothing else");
    assert.equal((await availableGags(factId))[0]!.content.coreSceneOverride, A.coreSceneOverride);

    await db.transaction((tx) => publishDraft(tx, factId, adminId));
    assert.deepEqual(await descriptionOf(factId), ["{NAME} bounces it off three groups."], "after the publish, the new content's description");
  });

  it("an edit keeps the draft's example picks, a description never reaches the drawing content, and a stale version is refused", async () => {
    const { factId, gagId } = await liveFact();
    const B = scene("{NAME} juggles the grenades.");
    await draftChange(factId, gagId, B);
    const picks = async () => (await db.select().from(factGagExamplesTable).where(eq(factGagExamplesTable.gagId, gagId))).length;
    const before = await picks();
    await saveReviewedDescription(gagId, gagContentFingerprint(B)!, "{NAME} juggles three of them.", adminId);
    await saveReviewedDescription(gagId, gagContentFingerprint(B)!, "{NAME} juggles four of them.", adminId);
    assert.equal(await picks(), before, "example picks untouched");
    const gag = (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
    assert.ok(!JSON.stringify(gag.pendingContent).includes("juggles four"), "the description is not in the drawing content");

    await assert.rejects(
      saveReviewedDescription(gagId, gagContentFingerprint(scene("{NAME} something older."))!, "{NAME} x.", adminId),
      (err: unknown) => err instanceof DescriptionError && err.code === "CONTENT_CHANGED",
    );
    await assert.rejects(
      saveReviewedDescription(gagId, gagContentFingerprint(B)!, "{NAME} meets {FRIEND}.", adminId),
      (err: unknown) => err instanceof DescriptionError && err.code === "DESCRIPTION_INVALID",
    );
  });

  it("the sweep drafts both versions, never replaces a moderator's text, records a failure, and re-runs as a no-op", async () => {
    const { factId, gagId, content: A } = await liveFact(`{NAME} throws the grenade ${randomUUID()}.`);
    const B = scene(`{NAME} throws it over a wall ${randomUUID()}.`);
    await draftChange(factId, gagId, B);
    await saveReviewedDescription(gagId, gagContentFingerprint(A)!, "{NAME} by hand.", adminId);

    const seen: string[] = [];
    const first = await runDescriptionSweep({
      batch: 1000, gagIds: [gagId],
      drafter: async (content) => {
        seen.push(content.coreSceneOverride ?? "");
        if (content.coreSceneOverride === B.coreSceneOverride) return "{NAME} lobs it over the wall.";
        return "{NAME} other.";
      },
    });
    assert.ok(first.drafted >= 1);
    assert.ok(!seen.includes(A.coreSceneOverride!), "the moderator's version is not drafted again");
    const rows = await db.select().from(factGagDescriptionsTable).where(eq(factGagDescriptionsTable.gagId, gagId));
    assert.equal(rows.find((r) => r.contentFingerprint === gagContentFingerprint(A))!.text, "{NAME} by hand.");
    const drafted = rows.find((r) => r.contentFingerprint === gagContentFingerprint(B))!;
    assert.equal(drafted.text, "{NAME} lobs it over the wall.");
    assert.equal(drafted.reviewedAt, null, "a drafted description is unreviewed: nothing reaches members");

    const again = await runDescriptionSweep({ batch: 1000, gagIds: [gagId], drafter: async () => { throw new Error("must not be called for this gag"); } });
    const mine = await db.select().from(factGagDescriptionsTable).where(eq(factGagDescriptionsTable.gagId, gagId));
    assert.deepEqual(mine.map((r) => r.text).sort(), ["{NAME} by hand.", "{NAME} lobs it over the wall."], "re-run changes nothing here");
    assert.deepEqual(again, { queued: 0, drafted: 0, failed: 0, skipped: 2, noop: 0 }, "nothing left to draft");

    // A failed draft is recorded and left for a later run.
    const { gagId: g2 } = await liveFact("{NAME} catches the grenade.");
    await runDescriptionSweep({ batch: 1000, gagIds: [g2], drafter: async () => { throw new Error("model down"); } });
    const [failed] = await db.select().from(factGagDescriptionsTable).where(eq(factGagDescriptionsTable.gagId, g2));
    assert.equal(failed!.text, null);
    assert.equal(failed!.lastError, "model down");
    assert.equal(failed!.attempts, 1);
    assert.ok((await descriptionsToReview()).some((d) => d.gagId === g2 && d.description.drafting === "failed"), "the review list shows the failure");
  });
});

describe("coverage at publication", () => {
  it("a changed gag cannot publish without a reviewed description of its new content, and can once it has one", async () => {
    const { factId, gagId } = await liveFact();
    const B = scene("{NAME} throws it at the moon.");
    await draftChange(factId, gagId, B);
    await assert.rejects(db.transaction((tx) => publishDraft(tx, factId, adminId)), (err: unknown) =>
      err instanceof GoLiveError && err.check.gaps.some((g) => g.needsDescription === true));
    assert.equal((await availableGags(factId))[0]!.content.coreSceneOverride, "{NAME} throws the grenade.", "the member-visible set is unchanged");

    await saveReviewedDescription(gagId, gagContentFingerprint(B)!, "{NAME} hits the moon.", adminId);
    await db.transaction((tx) => publishDraft(tx, factId, adminId));
    assert.equal((await availableGags(factId))[0]!.content.coreSceneOverride, B.coreSceneOverride);
  });

  it("an unchanged published gag without a description blocks nothing", async () => {
    const { factId, gagId } = await liveFact();
    // A second gag, added in the draft with its picks and its description.
    const C = scene("{NAME} sits on the grenade.");
    const [row] = await db.insert(factGagsTable).values({ factId, slot: 2, pendingContent: C as never, pendingBy: adminId, pendingAt: new Date() }).returning({ id: factGagsTable.id });
    await giveExampleSet(factId, row!.id, C, "pending");
    // Gag 1 is published and unchanged; it needs its examples to go live, but no description.
    const A = (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!.approvedContent;
    await giveExampleSet(factId, gagId, A, "approved");
    await db.delete(factGagDescriptionsTable).where(eq(factGagDescriptionsTable.gagId, gagId));
    const result = await db.transaction((tx) => publishDraft(tx, factId, adminId));
    assert.equal(result.published, 1);
  });
});

