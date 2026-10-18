/**
 * GET /admin/facts/:id — the detail payload the admin Facts editor opens a root
 * fact from. The editor's e2e check reads a stub, so this is the test that
 * the server still sends every field and the enrichment the editor renders.
 *
 * 401/403 auth coverage lives in routes.admin.auth.test.ts; the enrichment
 * edit/PATCH routes are in routes.adminFactsEnrichment.test.ts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { buildFactEnrichmentColumns } from "../lib/factEnrichment.js";

const USER_PREFIX = "tadminfacts-";
const TEXT_PREFIX = "t_adminfacts ";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["clear_causal_relationship"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "pushups", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  visualPromptStrategyOverride: {
    version: 1,
    coreSceneOverride: "{NAME} bench-presses the Earth overhead in a stadium.",
    requiredVisualDetails: ["a glowing aura"],
    forbiddenVisualDetails: [], roleBindings: [], bubbles: [],
    compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
  },
};

let adminId: string;
let adminApp: Express;
let factId: number;
const text = `${TEXT_PREFIX}{NAME} bench-presses the Earth ${randomUUID()}`;

before(async () => {
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: adminId, email: `${adminId}@test.local`, membershipTier: "registered", isAdmin: true,
  });
  adminApp = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
  const [row] = await db
    .insert(factsTable)
    .values({
      text,
      canonicalText: "Alex bench-presses the Earth",
      splitTokenIndex: 2,
      useCase: "boast",
      isActive: true,
      upvotes: 11, downvotes: 3, score: 8, wilsonScore: 0.61,
      commentCount: 5, shareCount: 7,
      submittedById: adminId,
      ...buildFactEnrichmentColumns(ENRICHMENT),
      enrichmentStatus: "ok",
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  factId = row.id;
});

after(async () => {
  if (factId) await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});

describe("GET /admin/facts/:id — root fact detail for the Facts editor", () => {
  it("returns every field the editor shows and the stored enrichment, with a null parentId for a root", async () => {
    const res = await request(adminApp).get(`/api/admin/facts/${factId}`);
    assert.equal(res.status, 200);
    const body = res.body;

    assert.equal(body.id, factId);
    assert.equal(body.text, text);
    assert.equal(body.canonicalText, "Alex bench-presses the Earth");
    assert.equal(body.splitTokenIndex, 2);
    assert.equal(body.useCase, "boast");
    assert.equal(body.isActive, true);
    assert.equal(body.upvotes, 11);
    assert.equal(body.downvotes, 3);
    assert.equal(body.score, 8);
    assert.equal(body.wilsonScore, 0.61);
    assert.equal(body.commentCount, 5);
    assert.equal(body.shareCount, 7);
    assert.equal(body.submittedById, adminId);
    assert.equal(body.parentId, null, "a root fact has no parent");
    assert.ok(body.createdAt && body.updatedAt, "created and updated dates are sent");

    assert.equal(body.enrichmentStatus, "ok");
    const enrichment = body.enrichment as FactEnrichment;
    assert.equal(enrichment.primaryArchetype, "superhuman_physical_feat");
    assert.deepEqual(enrichment.suggestedHashtags, ["strength", "pushups", "earth"]);
    assert.equal(
      enrichment.visualPromptStrategyOverride?.coreSceneOverride,
      "{NAME} bench-presses the Earth overhead in a stadium.",
    );
    assert.deepEqual(enrichment.visualPromptStrategyOverride?.requiredVisualDetails, ["a glowing aura"]);
  });
});
