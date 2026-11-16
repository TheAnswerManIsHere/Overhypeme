/**
 * The one-off character-list fill (PLAN_BUBBLE_SPEAKERS.md, G): which rows it
 * targets, that it writes only the list and its marker, that a failure leaves
 * the row retryable, that a moderator correction saved meanwhile survives, and
 * that it never renders.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import {
  factsTable,
  usersTable,
  pendingReviewsTable,
  factEnrichmentVersionsTable,
  asyncJobsTable,
  imagePromptAttemptsTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
  hasExtractedCharacters,
  type FactEnrichment,
} from "@workspace/api-zod";

import { materializeFromBaseline } from "../lib/factEnrichment.js";
import { pickCharacterFillTargets, runFactCharacterFill } from "../lib/factCharacterFillJob.js";

const RUN = randomUUID().slice(0, 8);
const MOM = [{ label: "mom", kind: "person" as const, ofSubject: true }];
const ok = { extract: async () => MOM };
let adminId: string;
const factIds: number[] = [];

async function liveFact(baseline: FactEnrichment = buildPlaceholderFactEnrichment()): Promise<number> {
  const { columns } = materializeFromBaseline(baseline);
  const row = await insertLiveFact(
    { text: `t_fill ${RUN} When {NAME} was born, {SUBJ} drove {POSS} mom home ${randomUUID()}`, ...columns, enrichmentStatus: "ok" } as never,
    buildPlaceholderGag(),
  );
  factIds.push(row.id);
  return row.id;
}

async function stagingFact(stage: "triage_pending" | "concept_review"): Promise<number> {
  const id = await liveFact();
  await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, id));
  await db.insert(pendingReviewsTable).values({
    submittedText: "x", submittedById: adminId, status: "pending", workflowStage: stage, stagingFactId: id,
  });
  return id;
}

async function readFact(id: number) {
  const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
  return row!;
}

before(async () => {
  adminId = `t-fill-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "registered" });
});

after(async () => {
  if (factIds.length) {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.update(factEnrichmentVersionsTable).set({ sourceReviewId: null }).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("pickCharacterFillTargets", () => {
  it("targets live facts and first-time facts at the Gags step, not triage submissions or already-filled facts", async () => {
    const live = await liveFact();
    const atGags = await stagingFact("concept_review");
    const atTriage = await stagingFact("triage_pending");
    const filled = await liveFact({ ...buildPlaceholderFactEnrichment(), characters: MOM, charactersExtraction: { promptVersion: "v1", extractedAt: "x" } });
    const factTargets = new Set((await pickCharacterFillTargets()).filter((t) => t.target === "fact").map((t) => t.factId));
    assert.equal(factTargets.has(live), true);
    assert.equal(factTargets.has(atGags), true);
    assert.equal(factTargets.has(atTriage), false);
    assert.equal(factTargets.has(filled), false);
  });

  it("targets an open refresh candidate", async () => {
    const id = await liveFact();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "refresh", submittedById: adminId, status: "pending", workflowStage: "concept_review", stagingFactId: id,
    }).returning({ id: pendingReviewsTable.id });
    const { columns } = materializeFromBaseline(buildPlaceholderFactEnrichment());
    const [cand] = await db.insert(factEnrichmentVersionsTable).values({
      factId: id, versionNo: 1, status: "candidate", source: "refresh_candidate", sourceReviewId: review!.id,
      enrichment: columns.enrichment, enrichmentAiDerived: columns.enrichmentAiDerived, enrichmentOverrides: {},
    } as never).returning({ id: factEnrichmentVersionsTable.id });
    const targets = await pickCharacterFillTargets();
    assert.equal(targets.some((t) => t.target === "candidate" && t.versionId === cand!.id), true);

    const r = await runFactCharacterFill({ target: "candidate", factId: id, versionId: cand!.id }, ok);
    assert.equal(r.ok, true);
    const [v] = await db.select().from(factEnrichmentVersionsTable).where(eq(factEnrichmentVersionsTable.id, cand!.id));
    assert.deepEqual((v!.enrichmentAiDerived as FactEnrichment).characters, MOM);
    assert.equal(hasExtractedCharacters(v!.enrichmentAiDerived as FactEnrichment), true);
    // The live fact is untouched by a candidate fill.
    assert.equal(hasExtractedCharacters((await readFact(id)).enrichmentAiDerived as FactEnrichment), false);
  });
});

describe("runFactCharacterFill", () => {
  it("writes only the list and its marker; every other field, the signature, status and gags are unchanged; nothing renders", async () => {
    const id = await liveFact();
    const before = await readFact(id);
    const gagsBefore = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    const r = await runFactCharacterFill({ target: "fact", factId: id }, ok);
    assert.equal(r.ok, true);
    const after = await readFact(id);
    const { characters, charactersExtraction, ...restAfter } = after.enrichmentAiDerived as FactEnrichment;
    assert.deepEqual(characters, MOM);
    assert.ok(charactersExtraction);
    const { characters: _c, charactersExtraction: _m, ...restBefore } = before.enrichmentAiDerived as FactEnrichment;
    assert.deepEqual(restAfter, restBefore);
    assert.deepEqual((after.enrichment as FactEnrichment).characters, MOM);
    assert.deepEqual(after.lastProcessedSignature, before.lastProcessedSignature);
    assert.equal(after.enrichmentStatus, before.enrichmentStatus);
    assert.equal(after.isActive, before.isActive);
    assert.equal(after.primaryArchetype, before.primaryArchetype);
    assert.deepEqual(await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id)), gagsBefore);
    assert.equal((await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, id))).length, 0);
    assert.equal(
      (await db.select().from(asyncJobsTable).where(inArray(asyncJobsTable.queue, ["image_prompt", "render", "fact_render"]))).filter(
        (j) => JSON.stringify(j.payload ?? {}).includes(`"factId":${id}`),
      ).length,
      0,
    );
  });

  it("a second run is a no-op counted already complete", async () => {
    const id = await liveFact();
    await runFactCharacterFill({ target: "fact", factId: id }, ok);
    let called = false;
    const r = await runFactCharacterFill({ target: "fact", factId: id }, { extract: async () => { called = true; return []; } });
    assert.equal(called, false);
    assert.deepEqual((r as { result?: unknown }).result, { skipped: true, reason: "already_current" });
  });

  it("a failed call writes no marker and stays a target; the next run fills it", async () => {
    const id = await liveFact();
    const r = await runFactCharacterFill({ target: "fact", factId: id }, { extract: async () => { throw new Error("provider down"); } });
    assert.equal(r.ok, false);
    assert.equal(hasExtractedCharacters((await readFact(id)).enrichmentAiDerived as FactEnrichment), false);
    assert.equal((await pickCharacterFillTargets()).some((t) => t.target === "fact" && t.factId === id), true);
    assert.equal((await runFactCharacterFill({ target: "fact", factId: id }, ok)).ok, true);
    assert.equal(hasExtractedCharacters((await readFact(id)).enrichmentAiDerived as FactEnrichment), true);
  });

  it("a legitimate empty list is complete", async () => {
    const id = await liveFact();
    await runFactCharacterFill({ target: "fact", factId: id }, { extract: async () => [] });
    const ai = (await readFact(id)).enrichmentAiDerived as FactEnrichment;
    assert.deepEqual(ai.characters, []);
    assert.equal(hasExtractedCharacters(ai), true);
  });

  it("a moderator correction saved during the call survives", async () => {
    const id = await liveFact();
    const CORRECTED = [{ label: "mother", kind: "person" as const, ofSubject: true }];
    await runFactCharacterFill({ target: "fact", factId: id }, {
      extract: async () => {
        const row = await readFact(id);
        await db.update(factsTable).set({
          enrichmentOverrides: {
            ...(row.enrichmentOverrides as object),
            "/characters": { value: CORRECTED, overriddenFrom: [], overriddenAt: new Date().toISOString(), overriddenBy: adminId },
          },
        }).where(eq(factsTable.id, id));
        return MOM;
      },
    });
    const after = await readFact(id);
    assert.deepEqual((after.enrichmentAiDerived as FactEnrichment).characters, MOM);
    assert.deepEqual((after.enrichment as FactEnrichment).characters, CORRECTED, "the correction wins over the filled AI list");
  });
});
