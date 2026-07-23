/**
 * Integration tests for the GENERIC (no-upload) branch of
 * POST /memes/ai/:factId/generate after its migration onto the render-time
 * image-prompt engine + Nano Banana 2 attempt pipeline.
 *
 * The async worker is NOT running in these tests, so enqueueing only inserts the
 * attempt + job rows (no OpenAI/fal calls). We assert the route's synchronous
 * behavior: enrichment gate, 202 { renderJobId, attemptId }, the attempt's
 * t2i_fallback shape, gender/aspect mapping, and that the legacy aiScenePrompts
 * cache is never written.
 *
 * Touches the real test DB under the `t_mgg_` prefix; cleanup deletes only those.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type FactEnrichment } from "@workspace/api-zod";
import { eq, inArray, like } from "drizzle-orm";

import memesRouter from "../routes/memes.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_mgg_u_";
const FACT_PREFIX = "t_mgg_fact_";

const insertedUserIds: string[] = [];
const insertedFactIds: number[] = [];
let legendaryUserId: string;
let bearer: string;

const VALID_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["single_subject_focus"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["legendary", "strength", "feat"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  // Active facts require a non-empty Visual Concept (facts_active_requires_concept CHECK).
  visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "A hero stands tall." },
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(memesRouter);
  return app;
}

async function seedFact(opts: { enrichment?: unknown } = {}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({
      text: `${FACT_PREFIX}{NAME} bench-presses the Earth.`,
      isActive: true,
      enrichment: (opts.enrichment ?? VALID_ENRICHMENT) as FactEnrichment,
    })
    .returning({ id: factsTable.id });
  insertedFactIds.push(row!.id);
  return row!.id;
}

async function cleanup(): Promise<void> {
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_PREFIX}%`));
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
    insertedUserIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  legendaryUserId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: legendaryUserId,
    email: `${legendaryUserId}@test.local`,
    membershipTier: "legendary",
    displayName: "Tess Legend",
    pronouns: "she/her",
  });
  insertedUserIds.push(legendaryUserId);
  bearer = await createSession(
    { user: { id: legendaryUserId } as unknown as SessionData["user"], access_token: "test-token" },
    legendaryUserId,
  );
});

after(cleanup);

describe("POST /memes/ai/:factId/generate — generic branch (new engine)", () => {
  it("enqueues a t2i_fallback attempt and returns 202 { renderJobId, attemptId }", async () => {
    const factId = await seedFact();
    const res = await request(makeApp())
      .post(`/memes/ai/${factId}/generate`)
      .set("Authorization", `Bearer ${bearer}`)
      .send({ scope: "gendered", aspectRatio: "square" });

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(typeof res.body.renderJobId, "string");
    assert.equal(typeof res.body.attemptId, "number");

    const [attempt] = await db
      .select()
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, res.body.attemptId));
    assert.ok(attempt, "an attempt row should be created");
    assert.equal(attempt!.subjectRenderMode, "t2i_fallback");
    assert.equal(attempt!.generationMode, "t2i");
    assert.equal(attempt!.targetEngine, "nano_banana_2");
    // she/her requester → female gender slot; aspect ratio flows through.
    const rc = attempt!.renderControls as Record<string, unknown>;
    assert.equal(rc["fallbackSubjectGender"], "female");
    assert.equal(rc["aspectRatio"], "square");
    // Rendered fact text is token-resolved (no {NAME}).
    assert.doesNotMatch(attempt!.renderedFactText ?? "", /\{NAME\}/);

    // The new engine must NOT write the legacy scene-prompt cache.
    const [factRow] = await db.select({ p: factsTable.aiScenePrompts }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(factRow?.p ?? null, null);
  });

  it("abstract scope uses the neutral fallback gender", async () => {
    const factId = await seedFact();
    const res = await request(makeApp())
      .post(`/memes/ai/${factId}/generate`)
      .set("Authorization", `Bearer ${bearer}`)
      .send({ scope: "abstract" });

    assert.equal(res.status, 202, JSON.stringify(res.body));
    const [attempt] = await db
      .select()
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, res.body.attemptId));
    const rc = attempt!.renderControls as Record<string, unknown>;
    assert.equal(rc["fallbackSubjectGender"], "neutral");
  });

  it("400 fact_enrichment_invalid for a fact with no usable enrichment", async () => {
    // Structurally-invalid enrichment (bad primaryArchetype) for the app-level
    // fact_enrichment_invalid check, but with a Visual Concept present so the
    // (orthogonal) DB CHECK — which only inspects that one nested string field —
    // is satisfied and the active-fact insert succeeds. The route requires
    // isActive=true to find the fact at all (memes.ts:1327), so this fixture
    // can't be inactive like the admin-bench fixtures.
    const factId = await seedFact({
      enrichment: { primaryArchetype: "nope", visualPromptStrategyOverride: { version: 1, coreSceneOverride: "A hero stands tall." } },
    });
    const res = await request(makeApp())
      .post(`/memes/ai/${factId}/generate`)
      .set("Authorization", `Bearer ${bearer}`)
      .send({ scope: "gendered" });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "fact_enrichment_invalid");
  });
});
