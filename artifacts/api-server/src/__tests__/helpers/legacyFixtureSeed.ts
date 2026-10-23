/**
 * Seed a scratch SOURCE database for the legacy-fixture sentinel test (plan
 * D9). Run as a child process with DATABASE_URL naming that database, so the
 * real hash functions can make some rows "current" against it:
 *
 *   tsx src/__tests__/helpers/legacyFixtureSeed.ts            # the scrub case
 *   tsx src/__tests__/helpers/legacyFixtureSeed.ts --refusal  # the refusal case
 *
 * The scrub case plants a SENTINELS value in every excluded class and every
 * transformed location — on ACTIVE-fact records, where a "the fact is live"
 * shortcut would leak them (Astra round 1, C1) — plus the partial states the
 * emptiness rule must keep (a blank core scene, a half-filled bubble, a deleted
 * gallery slot; Astra round 2, C2), both image pipelines' shared references
 * (Astra rounds 2–3, C3), and test-mode, live-mode and unsynced Stripe
 * references (C5). Prints the ids it created as JSON.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { testDatabaseRefusal } from "@workspace/db/test-database";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, buildPlaceholderFactEnrichment, type FactEnrichment } from "@workspace/api-zod";

import { KEPT_FACT_TEXT, SENTINELS as S } from "./legacyFixtureSentinels";

const refusal = await testDatabaseRefusal(process.env);
if (refusal) {
  console.error(`[legacy-fixture seed] refusing: ${refusal}`);
  process.exit(1);
}

const { db } = await import("@workspace/db");
const t = await import("@workspace/db/schema");
const { aiBackgroundKey, uploadKey } = await import("../../lib/storageKeys");
const { hashFactText } = await import("../../lib/enrichmentVersioning");
const { computeScenarioInputHash, loadReviewRenderContext } = await import("../../lib/reviewRenderScenarios");
const { computeCurrentInputHash, resolveVisualConceptCycle } = await import("../../lib/visualConceptJobs");

const at = new Date("2026-01-02T03:04:05Z");

// ── People ──
const userId = randomUUID();
const adminId = randomUUID();
const otherId = randomUUID();
await db.insert(t.usersTable).values([
  {
    id: adminId, email: S.adminEmail, displayName: S.adminDisplayName, firstName: "Zqxadmin", lastName: "Realperson",
    isAdmin: true, passwordHash: S.passwordHash, createdAt: new Date("2025-01-01T00:00:00Z"),
  },
  {
    id: userId, email: S.userEmail, pendingEmail: S.userPendingEmail, displayName: S.userDisplayName,
    firstName: S.userFirstName, lastName: S.userLastName, passwordHash: S.passwordHash, pronouns: "she/her",
    stripeCustomerId: S.testCustomer, createdAt: new Date("2025-02-01T00:00:00Z"),
  },
  {
    id: otherId, email: "zqx.other.person@gmail.com", displayName: "Zqxother Person", stripeCustomerId: S.liveCustomer,
    googleLinked: true, profileImageUrl: S.googlePhoto, createdAt: new Date("2025-03-01T00:00:00Z"),
  },
]);

// ── Excluded classes: each holds a sentinel the export must never read ──
await db.insert(t.sessionsTable).values({ sid: S.sessionSid, sess: { note: S.sessionPayload, user: { id: userId } }, expire: new Date("2030-01-01"), userId });
await db.insert(t.passwordResetTokensTable).values({ userId, tokenHash: S.resetTokenHash, expiresAt: new Date("2030-01-01") });
await db.insert(t.asyncJobsTable).values({ queue: "email", payload: { to: S.jobPayload }, status: "pending" });
await db.insert(t.rateLimitCountersTable).values({ keyHash: "zqx".padEnd(64, "0"), keyRaw: S.rateLimitKey, expiresAt: new Date("2030-01-01") });
await db.insert(t.activityFeedTable).values({ userId, actionType: "comment_approved", message: S.activityMessage });
await db.insert(t.searchHistoryTable).values({ userId, query: S.searchQuery });

// ── The catalogue ──
const placeholderEnrichment = buildPlaceholderFactEnrichment(S.coreScene);
const enrichment: FactEnrichment = {
  ...placeholderEnrichment,
  adminReviewNotes: S.adminReviewNotes,
  semanticEntities: [{
    surfaceText: S.entitySurface, normalizedText: S.entitySurface.toLowerCase(), entityKind: "proper_noun",
    visualReferent: S.entityReferent, capitalizationSignal: "not_relevant", materiallyAffectsVisualPrompt: true,
    requiresAdminReview: false, confidence: 0.9, notes: "",
  }],
  visualPromptStrategyOverride: {
    ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
    coreSceneOverride: S.coreScene,
    roleBindings: [{ entity: "subject", visualRole: S.roleVisual }],
    bubbles: [{ type: "speech", entity: "subject", text: S.bubbleText }],
    updatedBy: S.adminEmail,
    updatedAt: "2026-01-01T00:00:00Z",
    // The retired enable toggle older blobs still carry (seen on dev, 2026-10-13).
    ...({ enabled: true } as object),
  },
};
// A partial state the emptiness rule must keep: a blank core scene and a half-filled bubble (Astra round 2).
const partialEnrichment: FactEnrichment = {
  ...placeholderEnrichment,
  visualPromptStrategyOverride: {
    ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
    coreSceneOverride: "",
    bubbles: [{ type: "speech", entity: "subject", text: "" }],
  },
};
const overrides = {
  "/overhypeFit": { value: "strong", overriddenFrom: "questionable", createdAt: "2026-01-01T00:00:00Z", createdBy: adminId, reason: S.overrideReason },
  "/adminReviewNotes": { value: S.overrideNote, overriddenFrom: S.adminReviewNotes, createdAt: "2026-01-01T00:00:00Z", createdBy: adminId },
};

const [activeFact] = await db.insert(t.factsTable).values({
  text: KEPT_FACT_TEXT, submittedById: userId, isActive: true, canonicalText: "Alex counted to infinity, twice, and the second time it was backwards.",
  hasPronouns: false, enrichment, enrichmentAiDerived: { ...placeholderEnrichment, adminReviewNotes: S.adminReviewNotes, visualPromptStrategyOverride: undefined },
  enrichmentOverrides: overrides,
  aiScenePrompts: { fact_type: "action", male: S.scenePrompt, female: S.scenePrompt, neutral: "" },
  embedding: Array.from({ length: 384 }, (_, i) => (i % 7) / 10),
  createdAt: at,
}).returning({ id: t.factsTable.id });
const [pendingFact] = await db.insert(t.factsTable).values({
  text: S.pendingFactText, submittedById: userId, isActive: false, canonicalText: S.pendingFactText.replace("{NAME}", "Alex"),
  hasPronouns: false, enrichment: partialEnrichment, enrichmentAiDerived: partialEnrichment, createdAt: at,
}).returning({ id: t.factsTable.id });

// The live text on rows that do not own it (Codex round 1): an inactive duplicate fact, and a rejected
// duplicate submission linked to no fact. Plan D4: neither keeps the text.
const [duplicateFact] = await db.insert(t.factsTable).values({
  text: KEPT_FACT_TEXT, submittedById: otherId, isActive: false, hasPronouns: false, createdAt: at,
}).returning({ id: t.factsTable.id });
const [duplicateReview] = await db.insert(t.pendingReviewsTable).values({
  submittedText: KEPT_FACT_TEXT, submittedById: otherId, status: "rejected", workflowStage: "triage_rejected",
  hashtags: ["zqxduplicatetag"], createdAt: at,
}).returning({ id: t.pendingReviewsTable.id });

// Both image pipelines' shared references (Astra rounds 2–3).
const legacyBackground = `/objects/${aiBackgroundKey(activeFact!.id, "male", "zqxkey1", "png")}`;
await db.update(t.factsTable).set({ aiMemeImages: { male: [legacyBackground, ""], female: [], neutral: [] } }).where(sql`id = ${activeFact!.id}`);

const [hashtag] = await db.insert(t.hashtagsTable).values({ name: "zqxprivatetag", factCount: 1 }).returning({ id: t.hashtagsTable.id });
const [keptTag] = await db.insert(t.hashtagsTable).values({ name: "infinity", factCount: 1 }).returning({ id: t.hashtagsTable.id });
await db.insert(t.factHashtagsTable).values([{ factId: pendingFact!.id, hashtagId: hashtag!.id }, { factId: activeFact!.id, hashtagId: keptTag!.id }]);

// Reviews: an older approved review whose wording differs from today's live text; a refresh of the live fact; a pending submission.
const [approved] = await db.insert(t.pendingReviewsTable).values({
  submittedText: S.oldApprovedText, submittedById: userId, status: "approved", workflowStage: "production_approved",
  approvedFactId: activeFact!.id, reviewedById: adminId, adminNote: S.adminNote, createdAt: at,
}).returning({ id: t.pendingReviewsTable.id });
const [refresh] = await db.insert(t.pendingReviewsTable).values({
  submittedText: KEPT_FACT_TEXT, submittedById: userId, status: "pending", workflowStage: "production_review",
  stagingFactId: activeFact!.id, enrichment, productionRejectionNote: S.rejectionNote,
  visualRenderApprovalWaiver: {
    waivedAt: "2026-01-01T00:00:00Z", waivedByAdminUserId: adminId,
    waivedScenarios: [{ scenarioKey: "generic_t2i", statusAtWaiver: "missing", reason: S.waiverReason }],
    requiredScenarioPolicyVersion: "1",
  },
  createdAt: at,
}).returning({ id: t.pendingReviewsTable.id });
const [submission] = await db.insert(t.pendingReviewsTable).values({
  submittedText: S.pendingFactText, submittedById: userId, status: "pending", workflowStage: "concept_review",
  stagingFactId: pendingFact!.id, hashtags: ["zqxprivatetag"], createdAt: at,
}).returning({ id: t.pendingReviewsTable.id });

const [version] = await db.insert(t.factEnrichmentVersionsTable).values({
  factId: activeFact!.id, versionNo: 1, status: "candidate", enrichment, enrichmentAiDerived: placeholderEnrichment,
  enrichmentOverrides: overrides, factTextHash: hashFactText(KEPT_FACT_TEXT), source: "refresh_candidate",
  sourceReviewId: refresh!.id, note: S.versionNote, createdBy: adminId,
}).returning({ id: t.factEnrichmentVersionsTable.id });
await db.update(t.pendingReviewsTable).set({ candidateVersionId: version!.id }).where(sql`id = ${refresh!.id}`);

await db.insert(t.enrichmentOverrideHistoryTable).values({
  factId: activeFact!.id, path: "/adminReviewNotes", action: "set", oldValue: S.historyOld, newValue: S.historyNew,
  reason: S.overrideReason, performedBy: adminId,
});

// Concept blobs: the pending submission's (stale on purpose), and the refresh's (made current below).
const blob = (reviewId: number, candidateVersionId: number | null, source: "staging_fact" | "candidate_version") => ({
  candidates: [{
    title: S.conceptTitle, whyItWorks: S.conceptTitle, sceneDescription: S.conceptScene, tokenValid: true,
    bubbles: [{ type: "speech", entity: "subject", text: S.bubbleText, tokenValid: true }],
  }],
  generatedAt: "2026-01-01T00:00:00Z",
  provenance: { engineId: "openai-general", model: null, reasoningEffort: null, timeoutMs: 1000, promptVersion: 1 },
  reviewId, candidateVersionId, source, inputHash: "zqx-stale-input-hash",
});
await db.update(t.factsTable).set({ visualConceptCandidates: blob(submission!.id, null, "staging_fact"), visualConceptStatus: "ok" }).where(sql`id = ${pendingFact!.id}`);
await db.update(t.factsTable).set({ visualConceptCandidates: blob(refresh!.id, version!.id, "candidate_version"), visualConceptStatus: "ok" }).where(sql`id = ${activeFact!.id}`);
const cycle = await resolveVisualConceptCycle(refresh!.id);
if (cycle.ok) {
  const current = await computeCurrentInputHash(cycle.cycle);
  await db.update(t.factsTable).set({ visualConceptCandidates: { ...blob(refresh!.id, version!.id, "candidate_version"), inputHash: current } }).where(sql`id = ${activeFact!.id}`);
}

// Render attempts: a user generation on the newer pipeline (three references to one object), and two review renders — one current, one stale.
const sourceImageAnalysis = {
  subjectKind: "human", confidence: "high", hasUsableHumanFace: true, hasUsableSubject: true, subjectCount: 1,
  subjectDescription: S.sourceDescription, suggestedRenderMode: "human_identity_i2i", warnings: [S.sourceWarning],
  classificationMethod: "manual_user_choice", analyzerVersion: "1",
};
const identityPolicy = {
  subjectRenderMode: "t2i_fallback", preserveHumanFace: false, preserveNonhumanSubjectIdentity: false, preservePhysique: false,
  allowBodyExaggeration: true, allowCostumeTransformation: true, allowAnthropomorphicTransformation: false, ageAndLifeStagePolicy: "follow_fact",
};
const attemptBase = {
  factId: activeFact!.id, generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano-banana-2",
  sourceImageAnalysis, identityPolicy, factEnrichmentSnapshot: enrichment, archetypeStrategyVersion: "1",
};
const [userAttempt] = await db.insert(t.imagePromptAttemptsTable).values({
  ...attemptBase, userId, requestId: randomUUID(), renderJobId: randomUUID(),
  renderControls: { aspectRatio: "landscape", contentMode: "sfw", promptIdentity: { version: 1, name: S.frozenName, pronouns: "she/her", source: "user" } },
  renderedFactText: `${S.frozenName} counted to infinity, twice, and the second time it was backwards.`,
  compiledPrompt: {
    prompt: S.compiledText, imagePrompt: S.compiledText,
    promptBreakdown: [{ id: "core_scene", label: "Core scene", priority: "required", status: "included", text: S.breakdownText, rawText: S.breakdownText }],
  },
  error: S.vendorError,
  // A plan carrying a key newer than the wire schema (seen on dev, 2026-10-13).
  visualPlan: { sceneConcept: S.compiledText, styleIntegration: { note: S.compiledText, weight: 2 } },
}).returning({ id: t.imagePromptAttemptsTable.id });
const newerPath = `/objects/ai-bg-v2/${activeFact!.id}/${userAttempt!.id}-1767000000000.png`;
await db.update(t.imagePromptAttemptsTable).set({ generatedImageObjectPath: newerPath }).where(sql`id = ${userAttempt!.id}`);
await db.update(t.factsTable).set({ aiMemeImages: { male: [legacyBackground, "", newerPath], female: [], neutral: [] } }).where(sql`id = ${activeFact!.id}`);
await db.insert(t.userAiImagesTable).values([
  { userId, factId: activeFact!.id, gender: "male", storagePath: legacyBackground, imageType: "generic" },
  { userId, factId: activeFact!.id, gender: "male", storagePath: newerPath, imageType: "reference" },
]);

const reviewRender = (hash: string) => ({
  ...attemptBase, reviewId: refresh!.id, reviewRenderScenarioKey: "generic_t2i", reviewRenderInputHash: hash,
  renderJobId: randomUUID(), renderControls: {
    aspectRatio: "landscape", contentMode: "sfw", fallbackSubjectGender: "male", mirrorToLegacyStorage: false,
    reviewAudit: { reviewId: refresh!.id, adminUserId: adminId }, reviewRenderSubject: { name: S.reviewSubjectName, pronouns: "he/him" },
  },
  renderedFactText: `${S.reviewSubjectName} counted to infinity, twice, and the second time it was backwards.`,
});
const ctx = await loadReviewRenderContext(refresh!.id);
const currentHash = ctx.ok ? computeScenarioInputHash("generic_t2i", ctx.ctx.stagingFactId, ctx.ctx.factText, ctx.ctx.enrichment) : "unavailable";
const [currentRender] = await db.insert(t.imagePromptAttemptsTable).values(reviewRender(currentHash)).returning({ id: t.imagePromptAttemptsTable.id });
const [staleRender] = await db.insert(t.imagePromptAttemptsTable).values(reviewRender("zqx".padEnd(64, "0"))).returning({ id: t.imagePromptAttemptsTable.id });
const reviewRenderPath = `/objects/ai-bg-v2/${activeFact!.id}/${currentRender!.id}-1767000000001.png`;
await db.update(t.imagePromptAttemptsTable).set({ generatedImageObjectPath: reviewRenderPath }).where(sql`id = ${currentRender!.id}`);

// Uploads: a meme upload, a profile photo, an Arachnid match (excluded), and the newer pipeline's lineage row.
const uploadPath = `/objects/${uploadKey(randomUUID(), "jpg")}`;
const profilePath = `/objects/${uploadKey(randomUUID(), "jpg")}`;
const matchedPath = `/objects/${uploadKey(randomUUID(), "jpg")}`;
await db.insert(t.uploadImageMetadataTable).values([
  { objectPath: uploadPath, width: 640, height: 480, fileSizeBytes: 1000, userId, arachnidClassification: "no-known-match", arachnidSha256Hex: S.arachnidHash, sourceImageAnalysis },
  { objectPath: profilePath, width: 256, height: 256, fileSizeBytes: 500, userId, isProfile: true },
  { objectPath: matchedPath, width: 64, height: 64, fileSizeBytes: 100, userId, arachnidMatchType: "exact", arachnidClassification: "csam" },
  // The newer pipeline's lineage row (transform "phase2_v2", imagePromptJobs.ts:697-705) cannot exist: uim_transform_chk
  // (0048_meme_builder_lineage.sql:49-50) allows only the PuLID values, so that best-effort insert is always refused.
]);
// The form the product stores (routes/users.ts:326 strips it back off).
await db.update(t.usersTable).set({ profileImageUrl: `/api/storage${profilePath}`, avatarSource: "photo" }).where(sql`id = ${userId}`);

// Memes: a legacy composite, an upload recipe, a stock recipe, a quarantined one (excluded).
const meme = (slug: string, extra: Record<string, unknown>) => ({
  factId: activeFact!.id, templateId: "classic", imageUrl: `/api/memes/${slug}/image`, permalinkSlug: slug, createdById: userId,
  textOptions: { topText: S.caption, bottomText: "", fontSize: 40, color: "#ffffff" },
  renderedFactText: `${S.userFirstName} counted to infinity, twice, and the second time it was backwards.`,
  ...extra,
});
const [legacyMeme] = await db.insert(t.memesTable).values(meme("LegacySlug01", {})).returning({ id: t.memesTable.id });
await db.insert(t.memesTable).values(meme("UploadSlug01", { imageSource: { type: "upload", uploadKey: uploadPath }, isPublic: false }));
await db.insert(t.memesTable).values(meme("StockSlug001", { imageSource: { type: "stock", pexelsPhotoId: 777, photoUrl: S.photoUrl, photographerName: S.stockPhotographer } }));
const [quarantined] = await db.insert(t.memesTable).values(meme("QuarantSlug1", { status: "quarantined", quarantineReason: S.quarantineReason })).returning({ id: t.memesTable.id });
await db.insert(t.quarantinedMemesTable).values({ memeId: quarantined!.id, userId, evidenceObjectPath: S.quarantineEvidence, source: "arachnid" });
await db.insert(t.ncmecReportsTable).values({ matchSource: "arachnid", evidenceUri: S.ncmecEvidence, userId });
await db.insert(t.reactionsTable).values([
  { userId, targetType: "meme", targetId: legacyMeme!.id, reactionType: "heart" },
  { userId, targetType: "meme", targetId: quarantined!.id, reactionType: "heart" },
]);

await db.insert(t.commentsTable).values({ factId: activeFact!.id, authorId: userId, text: S.comment, flagged: true, flagReason: S.flagReason });
await db.insert(t.externalLinksTable).values({ factId: activeFact!.id, url: S.linkUrl, title: S.linkUrl, addedById: userId });

// Money: test-mode, live-mode and unsynced provider references; an admin grant (C5).
await db.execute(sql.raw(`
  CREATE SCHEMA IF NOT EXISTS stripe;
  CREATE TABLE stripe.subscriptions (id text PRIMARY KEY, livemode boolean, customer text, status text);
  CREATE TABLE stripe.customers (id text PRIMARY KEY, livemode boolean, email text);
  CREATE TABLE stripe.invoices (id text PRIMARY KEY, livemode boolean);
  CREATE TABLE stripe.payment_intents (id text PRIMARY KEY, livemode boolean);
  CREATE TABLE stripe.disputes (id text PRIMARY KEY, livemode boolean);
  INSERT INTO stripe.subscriptions VALUES ('${S.testSubscription}', false, '${S.testCustomer}', 'active'), ('${S.liveSubscription}', true, '${S.liveCustomer}', 'active');
  INSERT INTO stripe.customers VALUES ('${S.testCustomer}', false, '${S.userEmail}'), ('${S.liveCustomer}', true, 'zqx.live@gmail.com');
  INSERT INTO stripe.invoices VALUES ('${S.testInvoice}', false), ('${S.liveInvoice}', true);
`));
const ent = (providerRef: string, user: string, stateAsOf: number) => ({
  userId: user, sourceType: "stripe_subscription" as const, providerRef, lifecycleStatus: "active", isMembershipProduct: true,
  plan: "price_zqxmonthly", sourceStateAsOf: stateAsOf,
});
await db.insert(t.membershipEntitlementsTable).values([
  ent(S.testSubscription, userId, 41),
  ent(S.liveSubscription, otherId, 42),
  ent(S.unsyncedSubscription, adminId, 43),
  { userId: otherId, sourceType: "admin_grant" as const, lifecycleStatus: "active", grantedByAdminId: adminId, grantedByAdminLabel: S.adminDisplayName, grantReason: S.grantReason, sourceStateAsOf: 44 },
]);
await db.insert(t.membershipHistoryTable).values([
  { userId, event: "invoice_paid", stripeSubscriptionId: S.testSubscription, stripeInvoiceId: S.testInvoice, amount: 500 },
  { userId: otherId, event: "invoice_paid", stripeSubscriptionId: S.liveSubscription, stripeInvoiceId: S.liveInvoice, amount: 500 },
]);
await db.insert(t.userGenerationCostsTable).values({ userId, jobType: "ai_image", endpointId: "fal-ai/nano-banana-2", unitPriceAtCreation: "0.04", billingUnits: "1", computedCostUsd: "0.04", pricingFetchedAt: at, jobReferenceId: randomUUID() });

console.log(JSON.stringify({
  ok: true, userId, adminId, otherId,
  activeFactId: activeFact!.id, pendingFactId: pendingFact!.id, duplicateFactId: duplicateFact!.id, duplicateReviewId: duplicateReview!.id,
  approvedReviewId: approved!.id, refreshReviewId: refresh!.id, submissionReviewId: submission!.id, versionId: version!.id,
  userAttemptId: userAttempt!.id, currentRenderId: currentRender!.id, staleRenderId: staleRender!.id,
  legacyBackground, newerPath, uploadPath, profilePath, matchedPath,
  renderContextOk: ctx.ok, conceptCycleOk: cycle.ok,
}));
process.exit(0);
