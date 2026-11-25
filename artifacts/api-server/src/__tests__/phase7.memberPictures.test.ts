/**
 * Launch Phase 7, increment 2 — a member's AI picture (plan
 * docs/plans/PLAN_PHASE7_IMAGE_OFFERING.md §2, Testing Plan item 2), against
 * the render worker with the engine, the photo check and the output check
 * stood in:
 *
 *   - one command, one picture: the same command twice spends once; two
 *     commands at once with one credit make one picture;
 *   - each refusal reason, before anything is spent;
 *   - the settle invariant: delivered keeps the spend, and every way a
 *     picture fails returns it (the prompt stage, drawing, the engine refusing
 *     after its fallback, the output check, the queue giving up, stranded, past
 *     its deadline); the recovery pass run twice returns once; a late
 *     completion after a return is never delivered;
 *   - delivery is the member's own (user_ai_images with its gag and look),
 *     never the fact's shared gallery; requested at about one megapixel;
 *   - every new paid submission passes the gate; cost is recorded once per
 *     engine request however often it is collected;
 *   - only the owner can make a meme from it.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ValidationError } from "@fal-ai/client";
import { and, eq, inArray, like } from "drizzle-orm";

import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable, creditLedgerTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import {
  imagePromptAttemptsTable, asyncJobsTable, userAiImagesTable, imageProvenanceTable,
  imageGenerationRequestsTable, userGenerationCostsTable, adminConfigTable, quarantinedMemesTable, memesTable,
} from "@workspace/db/schema";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { requestMemberPicture, MemberPictureError, type MemberPictureCommand } from "../lib/memberPictures/command.js";
import { runMemberPictureSettlementPass, PICTURE_DEADLINE_MS, returnUndeliveredPicture } from "../lib/memberPictures/settlement.js";
import { __setOutputClassifierForTest } from "../lib/memberPictures/outputCheck.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { imagePromptGenerationHandler, imageGenerationHandler } from "../lib/imagePromptJobs.js";
import { __setRenderFalForTest } from "../lib/renderFalTransport.js";
import { __setTier3ForTest } from "../lib/sourceImageAnalysis/index.js";
import { creditBalance } from "../lib/credits/ledger.js";
import { createMemeRecord, CreateMemeError } from "../lib/createMemeRecord.js";
import { deleteFact, attachedContent } from "../lib/factLifecycle.js";
import { runContentPurger } from "../jobs/contentPurger.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";
import { withCast } from "./helpers/gagCast.js";
import { giveExampleSet } from "./helpers/gagExampleSets.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import memberPicturesRouter from "../routes/memberPictures.js";
import request from "supertest";

const RUN = randomUUID().slice(0, 8);
const GPT = "openai/gpt-image-2.6/sunburst/edit";
const NB = "google/nano-banana-2.1/edit";
const REFUSAL = "The content could not be processed because it contained material flagged by a content checker.";

const userIds: string[] = [];
const factIds: number[] = [];
let png: Buffer;
const photos = photoBackgrounds();

const decisions = { meme_private_visibility: false, meme_rate_limit_high: false };

async function newMember(credits = 1, opts: { verified?: boolean } = {}): Promise<string> {
  const id = `t-mp-${RUN}-${userIds.length}`;
  userIds.push(id);
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, isAdmin: false, membershipTier: "registered",
    displayName: "Jordan Tester", pronouns: "she/her",
    emailVerifiedAt: opts.verified === false ? null : new Date(), onboardingCompletedAt: new Date(),
  });
  // The trigger granted the free credit; top up with admin grants for more.
  for (let i = 1; i < credits; i++) {
    await db.insert(creditLedgerTable).values({ userId: id, kind: "admin_grant", credits: 1, ref: `t-${id}-${i}`, note: "test", actorLabel: "test" });
  }
  return id;
}

async function liveFact(scenes = ["{NAME} stares down a hurricane, which turns back."]): Promise<{ factId: number; gagIds: number[] }> {
  const f = await insertLiveFact(
    { text: `{NAME} out-stares a hurricane ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() },
    withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: scenes[0]! }),
  );
  factIds.push(f.id);
  const gagIds = [f.gags[0]!.id];
  for (const [i, text] of scenes.slice(1).entries()) {
    const [row] = await db.insert(factGagsTable).values({
      factId: f.id, slot: i + 2,
      approvedContent: withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text }) as never, approvedCarriedOver: true,
    }).returning({ id: factGagsTable.id });
    gagIds.push(row!.id);
  }
  return { factId: f.id, gagIds };
}

async function command(userId: string, factId: number, extra: Partial<MemberPictureCommand> = {}): Promise<MemberPictureCommand> {
  return {
    userId, requestId: `req-${randomUUID()}`, factId, gagId: null,
    uploadKey: extra.uploadKey ?? (await photos.seed(userId)), lookStyleId: null,
    subject: { kind: "me" }, aspectRatio: "portrait", ...extra,
  };
}

type Answer = "picture" | "refuse" | Error;
/** Run the image job with the engine answering per endpoint. */
async function draw(attemptId: number, answer: (endpoint: string) => Answer = () => "picture") {
  const calls: string[] = [];
  const answers = new Map<string, Answer>();
  __setRenderFalForTest({
    async submit(endpoint) {
      calls.push(endpoint);
      const a = answer(endpoint);
      if (a instanceof Error) throw a;
      const id = `req-${randomUUID()}`;
      answers.set(id, a);
      return id;
    },
    async status() { return "COMPLETED"; },
    async result(_endpoint, id) {
      if (answers.get(id) === "refuse") {
        throw new ValidationError({ message: "Unprocessable Entity", status: 422, body: { detail: [{ loc: ["body", "prompt"], msg: REFUSAL, type: "content_policy_violation" }] } });
      }
      return { images: [{ url: `data:image/png;base64,${png.toString("base64")}` }] };
    },
    async history() { throw new Error("no history in this test"); },
  });
  try {
    const out = await imageGenerationHandler.run({ attemptId }, {} as never);
    return { out, calls };
  } finally {
    __setRenderFalForTest(null);
  }
}

async function prompt(attemptId: number) {
  return imagePromptGenerationHandler.run({ attemptId }, {} as never);
}

async function attempt(id: number) {
  const [row] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, id));
  return row!;
}

async function ledgerFor(attemptId: number) {
  return db.select({ kind: creditLedgerTable.kind, credits: creditLedgerTable.credits })
    .from(creditLedgerTable).where(eq(creditLedgerTable.ref, `picture:${attemptId}`));
}

async function delivered(attemptId: number) {
  return db.select().from(userAiImagesTable).where(eq(userAiImagesTable.attemptId, attemptId));
}

/** The invariant: a delivered picture keeps its spend and has no return; any other ended picture has both. */
async function assertSettled(attemptId: number, expect: "delivered" | "returned") {
  const rows = await ledgerFor(attemptId);
  const spends = rows.filter((r) => r.kind === "picture_spend").length;
  const returns = rows.filter((r) => r.kind === "picture_return").length;
  const d = await delivered(attemptId);
  assert.equal(spends, 1, "one spend");
  if (expect === "delivered") {
    assert.equal(returns, 0, "a delivered picture is never returned");
    assert.equal(d.length, 1, "delivered once");
  } else {
    assert.equal(returns, 1, "returned once");
    assert.equal(d.length, 0, "a returned picture is never delivered");
  }
}

async function deleteJobs(attemptId: number) {
  await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, [`image_prompt:attempt:${attemptId}`, `image_generation:attempt:${attemptId}`]));
}

const PERSON = {
  subjectKind: "human_face", confidence: "high", hasUsableHumanFace: true, hasUsableSubject: true,
  subjectCount: 1, warnings: [], suggestedRenderMode: "human_identity_i2i",
} as const;

before(async () => {
  photos.setUp();
  png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#456" } }).png().toBuffer();
  process.env["FAL_AI_API_KEY"] ??= "test-fal-key";
  await db.insert(adminConfigTable).values({ key: "budget_per_credit_ceiling_usd", value: "0.30", dataType: "float", label: "t", description: "t" })
    .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "0.30" } });
});

beforeEach(() => {
  __setTier3ForTest(async () => ({ ...PERSON }) as never);
  __setReferenceFalUploadForTest(async () => "https://example.test/member-reference.jpg");
  __setOutputClassifierForTest(async () => ({ outcome: "accept", score: 0.01, model: "t", raw: {}, isNsfwTag: false }));
});
afterEach(() => {
  __setTier3ForTest(null);
  __setReferenceFalUploadForTest(null);
  __setOutputClassifierForTest(null);
});

after(async () => {
  if (factIds.length) {
    const attempts = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    for (const a of attempts) await deleteJobs(a.id);
    await db.delete(imageProvenanceTable).where(inArray(imageProvenanceTable.factId, factIds));
    await db.delete(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.factId, factIds));
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
  }
  if (userIds.length) {
    await db.delete(userGenerationCostsTable).where(inArray(userGenerationCostsTable.userId, userIds));
    await db.delete(quarantinedMemesTable).where(inArray(quarantinedMemesTable.userId, userIds));
    await db.delete(memesTable).where(inArray(memesTable.createdById, userIds));
    // The ledger and the pictures go with their accounts (cascade).
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (factIds.length) {
    const gags = await db.select({ id: factGagsTable.id }).from(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    if (gags.length) await db.delete(factGagExamplesTable).where(inArray(factGagExamplesTable.gagId, gags.map((g) => g.id)));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await photos.tearDown();
});

describe("Phase 7 inc 2: one command, one picture", () => {
  it("the same command twice spends once and returns the same picture", async () => {
    const userId = await newMember(2);
    const { factId } = await liveFact();
    const cmd = await command(userId, factId);
    const first = await requestMemberPicture(cmd);
    const again = await requestMemberPicture(cmd);
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.attemptId, first.attemptId);
    assert.equal(await creditBalance(userId), 1, "one credit spent, not two");
  });

  it("the same request id with a different gag, look, photo or subject is refused, not answered with the first picture", async () => {
    const userId = await newMember(2);
    const { factId, gagIds } = await liveFact(["{NAME} one.", "{NAME} two."]);
    const cmd = await command(userId, factId);
    await requestMemberPicture(cmd);
    await assert.rejects(requestMemberPicture({ ...cmd, gagId: gagIds[1]! }), (e: unknown) => e instanceof MemberPictureError && e.code === "request_reused");
    await assert.rejects(requestMemberPicture({ ...cmd, subject: { kind: "pet", name: "Mango", pronouns: null } }), (e: unknown) => e instanceof MemberPictureError && e.code === "request_reused");
    assert.equal(await creditBalance(userId), 1);
  });

  it("two commands at once with one credit make one picture", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const key = await photos.seed(userId);
    const results = await Promise.allSettled([
      requestMemberPicture(await command(userId, factId, { uploadKey: key })),
      requestMemberPicture(await command(userId, factId, { uploadKey: key })),
    ]);
    const made = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(made.length, 1, JSON.stringify(results.map((r) => r.status === "rejected" ? String(r.reason) : "ok")));
    assert.equal(refused.length, 1);
    assert.equal((refused[0] as PromiseRejectedResult).reason.code, "no_credit");
    assert.equal(await creditBalance(userId), 0);
  });

  it("the same command sent twice at once with one credit: both answers name one picture, one spend (Codex review, PR #1300)", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const cmd = await command(userId, factId);
    const [a, b] = await Promise.all([requestMemberPicture(cmd), requestMemberPicture(cmd)]);
    assert.equal(a.attemptId, b.attemptId);
    assert.equal([a, b].filter((h) => h.created).length, 1);
    assert.equal(await creditBalance(userId), 0);
    assert.equal((await ledgerFor(a.attemptId)).filter((r) => r.kind === "picture_spend").length, 1);
  });

  it("the same command sent twice at once with one place left under the in-progress cap: both answers name one picture", async () => {
    const userId = await newMember(4);
    const { factId } = await liveFact();
    await requestMemberPicture(await command(userId, factId));
    await requestMemberPicture(await command(userId, factId));
    const cmd = await command(userId, factId);
    const [a, b] = await Promise.all([requestMemberPicture(cmd), requestMemberPicture(cmd)]);
    assert.equal(a.attemptId, b.attemptId);
    assert.equal([a, b].filter((h) => h.created).length, 1);
    assert.equal(await creditBalance(userId), 1);
    // A different command is still refused at the cap.
    await assert.rejects(requestMemberPicture(await command(userId, factId)), (e: unknown) => e instanceof MemberPictureError && e.code === "too_many_in_progress");
  });

  it("photo checks made at once on an unchecked photo each record their cost; a later cached one records none (Codex review, PR #1300)", async () => {
    const userId = await newMember(4);
    const { factId } = await liveFact();
    const key = await photos.seed(userId);
    let checks = 0;
    __setTier3ForTest(async () => { checks++; await new Promise((r) => setTimeout(r, 50)); return { ...PERSON } as never; });
    const costRows = async () => (await db.select().from(userGenerationCostsTable)
      .where(and(eq(userGenerationCostsTable.userId, userId), like(userGenerationCostsTable.jobReferenceId, "check:photo:%")))).length;
    await Promise.all([1, 2].map(async () => requestMemberPicture(await command(userId, factId, { uploadKey: key }))));
    assert.ok(checks >= 1);
    assert.equal(await costRows(), checks, "one cost row per vision check actually made");
    const before = checks;
    await requestMemberPicture(await command(userId, factId, { uploadKey: key }));
    assert.equal(checks, before, "a cached photo is not checked again");
    assert.equal(await costRows(), before, "and records no cost");
  });

  it("once recorded spend reaches the allowance, the next command is refused before the vision check runs", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    await db.insert(userGenerationCostsTable).values({
      userId, jobType: "image", endpointId: "t", unitPriceAtCreation: "0.30", billingUnits: 1, computedCostUsd: "0.30",
      pricingFetchedAt: new Date(), jobReferenceId: `t-spent-${userId}`, isEstimated: true,
    } as never);
    let checks = 0;
    __setTier3ForTest(async () => { checks++; return { ...PERSON } as never; });
    await assert.rejects(requestMemberPicture(await command(userId, factId)), (e: unknown) => e instanceof MemberPictureError && e.code === "temporarily_unavailable");
    assert.equal(checks, 0);
    assert.equal(await creditBalance(userId), 1, "nothing spent");
  });

  it("the photo check passes the gate and its cost is recorded once per photo", async () => {
    const userId = await newMember(3);
    const { factId } = await liveFact();
    const key = await photos.seed(userId);
    await requestMemberPicture(await command(userId, factId, { uploadKey: key }));
    await requestMemberPicture(await command(userId, factId, { uploadKey: key }));
    const checks = await db.select().from(userGenerationCostsTable).where(and(eq(userGenerationCostsTable.userId, userId), like(userGenerationCostsTable.jobReferenceId, "check:photo:%")));
    assert.equal(checks.length, 1);
  });

  it("freezes who the picture is of at request time", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await db.update(usersTable).set({ displayName: "Someone Else" }).where(eq(usersTable.id, userId));
    assert.equal((await prompt(attemptId)).ok, true);
    const row = await attempt(attemptId);
    assert.match((row.compiledPrompt as { imagePrompt: string }).imagePrompt, /Jordan/);
    assert.doesNotMatch((row.compiledPrompt as { imagePrompt: string }).imagePrompt, /Someone/);
  });
});

describe("Phase 7 inc 2: refusals, before anything is spent", () => {
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await assert.rejects(p, (err: unknown) => err instanceof MemberPictureError && err.code === code);
  };

  it("another member's photo", async () => {
    const userId = await newMember(1);
    const other = await newMember(1);
    const { factId } = await liveFact();
    await refusedWith(requestMemberPicture(await command(userId, factId, { uploadKey: await photos.seed(other) })), "upload_not_owned");
    assert.equal(await creditBalance(userId), 1);
  });

  it("no credit", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    await requestMemberPicture(await command(userId, factId));
    await refusedWith(requestMemberPicture(await command(userId, factId)), "no_credit");
  });

  it("a gag that is not offered, and a fact that is not live", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const other = await liveFact();
    await refusedWith(requestMemberPicture(await command(userId, factId, { gagId: other.gagIds[0]! })), "gag_unavailable");
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    await refusedWith(requestMemberPicture(await command(userId, factId)), "fact_unavailable");
    assert.equal(await creditBalance(userId), 1);
  });

  it("a photo with no usable face, and a person's photo sent as a pet", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    __setTier3ForTest(async () => ({ ...PERSON, hasUsableHumanFace: false, hasUsableSubject: false, subjectCount: 0, suggestedRenderMode: "t2i_fallback", warnings: ["no face"] }) as never);
    await refusedWith(requestMemberPicture(await command(userId, factId)), "photo_unusable");
    __setTier3ForTest(async () => ({ ...PERSON }) as never);
    await refusedWith(requestMemberPicture(await command(userId, factId, { subject: { kind: "pet", name: "Mango", pronouns: "he/him" } })), "photo_subject_mismatch");
    assert.equal(await creditBalance(userId), 1);
  });

  it("the spend backstop", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    await db.update(usersTable).set({ monthlyGenerationLimitOverrideUsd: "0" }).where(eq(usersTable.id, userId));
    await refusedWith(requestMemberPicture(await command(userId, factId)), "temporarily_unavailable");
    assert.equal(await creditBalance(userId), 1);
  });

  it("too many pictures drawing at once", async () => {
    const userId = await newMember(5);
    const { factId } = await liveFact();
    for (let i = 0; i < 3; i++) await requestMemberPicture(await command(userId, factId));
    await refusedWith(requestMemberPicture(await command(userId, factId)), "too_many_in_progress");
    assert.equal(await creditBalance(userId), 2);
  });
});

describe("Phase 7 inc 2: delivered as the member's own", () => {
  it("a finished picture lands in user_ai_images with its gag and look, never the fact's gallery; about one megapixel; cost recorded once", async () => {
    const userId = await newMember(1);
    const { factId, gagIds } = await liveFact(["{NAME} one.", "{NAME} two."]);
    const { attemptId } = await requestMemberPicture(await command(userId, factId, { gagId: gagIds[1]! }));
    assert.equal((await prompt(attemptId)).ok, true);
    const { out, calls } = await draw(attemptId);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(calls, [GPT]);
    await assertSettled(attemptId, "delivered");
    const [pic] = await delivered(attemptId);
    assert.equal(pic!.userId, userId);
    assert.equal(pic!.gagId, gagIds[1]);
    assert.equal(pic!.imageType, "member_picture");
    const [fact] = await db.select({ ai: factsTable.aiMemeImages }).from(factsTable).where(eq(factsTable.id, factId));
    assert.ok(!JSON.stringify(fact!.ai ?? {}).includes(pic!.storagePath), "never in the shared gallery");
    const settings = (await attempt(attemptId)).requestSettings as { purpose: string; megapixels: number };
    assert.equal(settings.purpose, "final");
    assert.ok(settings.megapixels > 0.5 && settings.megapixels < 2, JSON.stringify(settings));
    // Collected again (a resumed run): no second submit, no second cost.
    await draw(attemptId);
    const costs = await db.select().from(userGenerationCostsTable).where(and(eq(userGenerationCostsTable.userId, userId), like(userGenerationCostsTable.jobReferenceId, "genreq:%")));
    assert.equal(costs.length, 1, "one cost per engine request");
    assert.equal(await creditBalance(userId), 0);
  });

  it("the photoreal fallback is one picture and one credit; each submission is gated and costed", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    const { out, calls } = await draw(attemptId, (e) => (e === GPT ? "refuse" : "picture"));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(calls, [GPT, NB]);
    await assertSettled(attemptId, "delivered");
    assert.equal(await creditBalance(userId), 0);
  });
});

describe("Phase 7 inc 2: every failure returns the credit", () => {
  it("refused by the engine after its fallback", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    const { out } = await draw(attemptId, () => "refuse");
    assert.equal(out.ok, false);
    await assertSettled(attemptId, "returned");
    assert.equal(await creditBalance(userId), 1);
  });

  it("failed at the prompt stage", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await db.update(imagePromptAttemptsTable).set({ factEnrichmentSnapshot: { broken: true } as never }).where(eq(imagePromptAttemptsTable.id, attemptId));
    assert.equal((await prompt(attemptId)).ok, false);
    await assertSettled(attemptId, "returned");
  });

  it("refused by the output check: quarantined, not delivered, returned", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    __setOutputClassifierForTest(async () => ({ outcome: "reject", score: 0.99, model: "t", raw: {} }));
    const { out } = await draw(attemptId);
    assert.equal(out.ok, false);
    assert.equal((await attempt(attemptId)).errorCode, "output_refused");
    assert.equal((await attempt(attemptId)).generatedImageObjectPath, null);
    await assertSettled(attemptId, "returned");
    const q = await db.select().from(quarantinedMemesTable).where(eq(quarantinedMemesTable.userId, userId));
    assert.equal(q.length, 1);
  });

  it("the spend backstop at the engine submission ends it 'temporarily unavailable' and returns the credit", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await db.update(usersTable).set({ monthlyGenerationLimitOverrideUsd: "0" }).where(eq(usersTable.id, userId));
    const { out, calls } = await draw(attemptId);
    assert.equal(out.ok, false);
    assert.deepEqual(calls, [], "no engine call");
    assert.equal((await attempt(attemptId)).errorCode, "spend_backstop");
    await assertSettled(attemptId, "returned");
  });

  it("the queue gave up (its hook ran): returned", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await imageGenerationHandler.onAbandon!({ payload: { attemptId }, lastError: "gave up" } as never);
    await assertSettled(attemptId, "returned");
  });

  it("interrupted after the job failed and before settlement: the recovery pass returns it, once, however often it runs", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    // The failure committed; the hook never ran (no return written).
    await db.update(imagePromptAttemptsTable).set({ error: "boom", errorCode: "x" }).where(eq(imagePromptAttemptsTable.id, attemptId));
    await runMemberPictureSettlementPass();
    await runMemberPictureSettlementPass();
    await assertSettled(attemptId, "returned");
  });

  it("stranded (no live job, no error): the recovery pass ends it and returns it", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await deleteJobs(attemptId);
    await runMemberPictureSettlementPass(Date.now());
    assert.equal((await ledgerFor(attemptId)).length, 1, "too young to call stranded");
    await runMemberPictureSettlementPass(Date.now() + 10 * 60_000);
    await assertSettled(attemptId, "returned");
    assert.ok((await attempt(attemptId)).error);
  });

  it("a late completion after the deadline's return is never delivered", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    let outputChecks = 0;
    __setOutputClassifierForTest(async () => { outputChecks++; return { outcome: "accept", score: 0.01, model: "t", raw: {}, isNsfwTag: false }; });
    const { out, calls } = await draw(attemptId);
    assert.equal(out.ok, false);
    assert.deepEqual(calls, [], "no engine submission after the return (Codex review, PR #1300)");
    assert.equal(outputChecks, 0, "and no output check");
    await assertSettled(attemptId, "returned");
  });

  it("a picture returned before its prompt job runs stays failed, queues no image job, and frees its in-progress place", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    // Returned with no failure of its own written (the worst case for "reads failed").
    await db.transaction((tx) => returnUndeliveredPicture(attemptId, tx));
    await deleteJobs(attemptId);
    await prompt(attemptId);
    const row = await attempt(attemptId);
    assert.ok(row.error, "reads failed");
    const jobs = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
    assert.equal(jobs.length, 0, "no image job");
    await assertSettled(attemptId, "returned");
  });

  it("the prompt stage never clears a returned picture's failure", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    const failedWith = (await attempt(attemptId)).error;
    assert.ok(failedWith);
    await prompt(attemptId);
    assert.equal((await attempt(attemptId)).error, failedWith);
  });

  it("a failed picture older than seven days is still returned, once", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await db.update(imagePromptAttemptsTable)
      .set({ error: "boom", errorCode: "x", updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
    await runMemberPictureSettlementPass();
    await runMemberPictureSettlementPass();
    await assertSettled(attemptId, "returned");
  });

  it("a fact is not permanently deleted while a member's picture on it is owed its outcome (Codex review, PR #1300)", async () => {
    const userId = await newMember(1);
    const adminId = await newMember(0);
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, adminId));
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    const refused = await deleteFact(factId, adminId);
    assert.equal(refused.kind, "attached");
    assert.equal((refused as { attached: { aiPictures: number } }).attached.aiPictures, 1, "names an AI picture");
    assert.deepEqual(await attachedContent(factId), (refused as { attached: unknown }).attached, "the fact sheet reads the same count");
    assert.ok(await attempt(attemptId), "the attempt is untouched");
    assert.equal((await ledgerFor(attemptId)).length, 1, "the spend is untouched");
    // Once it has failed and its credit is back, the delete goes through.
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    assert.equal(await creditBalance(userId), 1, "the balance is what it was before the picture");
    assert.equal((await deleteFact(factId, adminId)).kind, "done");
  });

  it("a delivered picture stays finished after the member deletes it and it is purged (Codex review, PR #1300)", async () => {
    const userId = await newMember(1);
    const adminId = await newMember(0);
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, adminId));
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await draw(attemptId);
    const [row] = await delivered(attemptId);
    assert.ok(row, "delivered");
    // "Delete now": the restore window is over, and the purger removes the member's copy.
    await db.update(userAiImagesTable).set({ deletedAt: new Date(Date.now() - 60_000), purgeAfter: new Date(Date.now() - 1_000) }).where(eq(userAiImagesTable.id, row!.id));
    await runContentPurger({ generatedIds: [row!.id] });
    assert.equal((await delivered(attemptId)).length, 0, "the member's copy is gone");

    // Both picture routes read finished, with nothing to show.
    const appFor = buildTestApp({ kind: "authenticated", userId }, memberPicturesRouter);
    const one = await request(appFor).get(`/api/member-pictures/${attemptId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.picture.status, "done");
    assert.equal(one.body.picture.imageUrl, null);
    const list = await request(appFor).get(`/api/member-pictures`);
    const listed = (list.body.pictures as Array<{ attemptId: number; status: string }>).find((p) => p.attemptId === attemptId);
    assert.ok(!listed || listed.status === "done", "never queued or drawing");

    // No credit moves, and the fact can be permanently deleted.
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    assert.equal(await db.transaction((tx) => returnUndeliveredPicture(attemptId, tx)), false);
    assert.equal(await creditBalance(userId), 0, "the spend stands");
    assert.equal((await ledgerFor(attemptId)).filter((r) => r.kind === "picture_return").length, 0);
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    assert.equal((await attachedContent(factId)).aiPictures, 0);
    assert.equal((await deleteFact(factId, adminId)).kind, "done");
  });

  it("the member's list keeps an unfinished picture behind 20 newer ones, then shows its late failure (Issue #1299)", async () => {
    const userId = await newMember(1);
    const other = await newMember(0);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    // 21 newer pictures of the same member, all finished.
    const { id: _id, createdAt: _c, updatedAt: _u, renderJobId: _r, memberRequestId: _m, memberRequestFingerprint: _f, ...base } = await attempt(attemptId);
    for (let i = 0; i < 21; i++) {
      await db.insert(imagePromptAttemptsTable).values({
        ...base, renderJobId: randomUUID(), memberRequestId: `newer-${randomUUID()}`, memberRequestFingerprint: "x",
        generatedImageObjectPath: `/objects/ai-bg-v2/${factId}/newer-${i}.png`,
      } as never);
    }
    const listFor = async (who: string) => (await request(buildTestApp({ kind: "authenticated", userId: who }, memberPicturesRouter)).get("/api/member-pictures"))
      .body.pictures as Array<{ attemptId: number; status: string; creditReturned: boolean }>;
    const before = (await listFor(userId)).find((p) => p.attemptId === attemptId);
    assert.ok(before, "still listed behind 21 newer pictures");
    assert.ok(["queued", "drawing"].includes(before!.status));
    // Stopped at its deadline: the list shows how it ended.
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    const after = (await listFor(userId)).find((p) => p.attemptId === attemptId);
    assert.equal(after?.status, "failed");
    assert.equal(after?.creditReturned, true);
    assert.equal((await listFor(other)).some((p) => p.attemptId === attemptId), false, "never another member's");
  });

  it("a delivered picture is never returned by the recovery pass", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await draw(attemptId);
    await deleteJobs(attemptId);
    await runMemberPictureSettlementPass(Date.now() + PICTURE_DEADLINE_MS + 60_000);
    await assertSettled(attemptId, "delivered");
  });

  it("the database refuses a return for a delivered picture and a delivery for a returned one", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await draw(attemptId);
    const [spend] = await db.select().from(creditLedgerTable).where(and(eq(creditLedgerTable.kind, "picture_spend"), eq(creditLedgerTable.ref, `picture:${attemptId}`)));
    const refused = (re: RegExp) => (e: unknown) => re.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message));
    await assert.rejects(db.insert(creditLedgerTable).values({ userId, kind: "picture_return", credits: 1, ref: `picture:${attemptId}`, lotId: spend!.lotId }), refused(/never returned/));
    // And the other order: a returned picture is never delivered.
    const second = await newMember(1);
    const { attemptId: a2 } = await requestMemberPicture(await command(second, factId));
    await imageGenerationHandler.onAbandon!({ payload: { attemptId: a2 }, lastError: "gave up" } as never);
    await assert.rejects(
      db.insert(userAiImagesTable).values({ userId: second, factId, gender: "neutral", storagePath: "/objects/x", imageType: "member_picture", attemptId: a2 }),
      refused(/never delivered/),
    );
  });
});

describe("Phase 7 inc 2: only the owner makes a meme from it", () => {
  it("the owner can; another member, an example and another fact cannot", async () => {
    const userId = await newMember(1);
    const other = await newMember(1);
    const { factId, gagIds } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await draw(attemptId);
    const [pic] = await delivered(attemptId);
    const made = await createMemeRecord({ userId, factId, imageSource: { type: "ai_picture", aiImageId: pic!.id }, decisions });
    assert.ok(made.memeId);
    await assert.rejects(
      createMemeRecord({ userId: other, factId, imageSource: { type: "ai_picture", aiImageId: pic!.id }, decisions }),
      (e: unknown) => e instanceof CreateMemeError && e.status === 403,
    );
    const other2 = await liveFact();
    await assert.rejects(
      createMemeRecord({ userId, factId: other2.factId, imageSource: { type: "ai_picture", aiImageId: pic!.id }, decisions }),
      (e: unknown) => e instanceof CreateMemeError && e.status === 403,
    );
    // An approved example is a moderation render with no user_ai_images row of the member's.
    const examples = await giveExampleSet(factId, gagIds[0]!, {}, "approved");
    const [legacy] = await db.insert(userAiImagesTable).values({ userId, factId, gender: "neutral", storagePath: `/objects/ex-${examples.male}`, imageType: "reference" }).returning();
    await assert.rejects(
      createMemeRecord({ userId, factId, imageSource: { type: "ai_picture", aiImageId: legacy!.id }, decisions }),
      (e: unknown) => e instanceof CreateMemeError && e.status === 403,
      "a row no member's picture delivered never satisfies the check",
    );
  });
});

describe("Phase 7 inc 2: the member's routes", () => {
  const app = (userId: string | null) => buildTestApp(userId ? { kind: "authenticated", userId } : { kind: "unauthenticated" }, memberPicturesRouter);

  it("picture options list exactly the offered gags, a choice only with more than one, the balance, and whether the next is free", async () => {
    const userId = await newMember(1);
    const one = await liveFact();
    const two = await liveFact(["{NAME} one.", "{NAME} two."]);
    const a = await request(app(userId)).get(`/api/facts/${one.factId}/picture-options`);
    assert.equal(a.status, 200);
    assert.equal(a.body.gags.length, 1);
    assert.equal(a.body.choice, false);
    assert.equal(a.body.credits, 1);
    assert.equal(a.body.nextIsFree, true);
    const b = await request(app(userId)).get(`/api/facts/${two.factId}/picture-options`);
    assert.deepEqual(b.body.gags.map((g: { gagId: number }) => g.gagId), two.gagIds);
    assert.equal(b.body.choice, true);
    assert.equal((await request(app(null)).get(`/api/facts/${one.factId}/picture-options`)).status, 401);
  });

  it("an offered gag's approved example is served; one no longer offered is not", async () => {
    const userId = await newMember(1);
    const { factId, gagIds } = await liveFact();
    const examples = await giveExampleSet(factId, gagIds[0]!, {}, "approved");
    await db.update(imagePromptAttemptsTable).set({ generatedImageObjectPath: await photos.seed(null) }).where(eq(imagePromptAttemptsTable.id, examples.male));
    assert.equal((await request(app(userId)).get(`/api/member-pictures/examples/${examples.male}/image`)).status, 200);
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    assert.equal((await request(app(userId)).get(`/api/member-pictures/examples/${examples.male}/image`)).status, 404);
  });

  it("the command answers 202 then 200 for the same id, refuses in words, and a failed picture says its credit was returned", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const uploadKey = await photos.seed(userId);
    const body = { requestId: `req-${randomUUID()}`, uploadKey, subject: { kind: "me" } };
    const first = await request(app(userId)).post(`/api/facts/${factId}/member-pictures`).send(body);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.picture.status, "queued");
    assert.equal(first.body.credits, 0);
    const again = await request(app(userId)).post(`/api/facts/${factId}/member-pictures`).send(body);
    assert.equal(again.status, 200);
    assert.equal(again.body.picture.attemptId, first.body.picture.attemptId);
    const broke = await request(app(userId)).post(`/api/facts/${factId}/member-pictures`).send({ ...body, requestId: `req-${randomUUID()}` });
    assert.equal(broke.status, 402);
    assert.equal(broke.body.error, "no_credit");
    assert.match(broke.body.message, /no credits/);

    const attemptId = first.body.picture.attemptId as number;
    await prompt(attemptId);
    await draw(attemptId, () => "refuse");
    const state = await request(app(userId)).get(`/api/member-pictures/${attemptId}`);
    assert.equal(state.body.picture.status, "failed");
    assert.equal(state.body.picture.creditReturned, true);
    assert.match(state.body.picture.reason, /would not draw/);
    assert.equal(state.body.credits, 1);
    // Another member sees nothing of it.
    const other = await newMember(1);
    assert.equal((await request(app(other)).get(`/api/member-pictures/${attemptId}`)).status, 404);
  });

  it("a finished picture reads done, with its image", async () => {
    const userId = await newMember(1);
    const { factId } = await liveFact();
    const { attemptId } = await requestMemberPicture(await command(userId, factId));
    await prompt(attemptId);
    await draw(attemptId);
    const list = await request(app(userId)).get("/api/member-pictures");
    const mine = list.body.pictures.find((p: { attemptId: number }) => p.attemptId === attemptId);
    assert.equal(mine.status, "done");
    assert.ok(mine.aiImageId);
    assert.match(mine.imageUrl, /^\/api\/memes\/ai-user\/image\?storagePath=/);
  });
});
