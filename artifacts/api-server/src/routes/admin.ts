import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHash } from "crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { factsTable, commentsTable, adminConfigTable, motionPresetsTable, featureFlagsTable, tierFeaturePermissionsTable, userGenerationCostsTable, membershipEntitlementsTable, entitlementSourceDisputesTable, membershipHistoryTable, activityFeedTable, memesTable, userAiImagesTable, routeStatsTable, routeStatEventsTable, asyncJobsTable, stripeWebhookAuditTable, stripeCheckoutRequestLedgerTable, enrichmentOverrideHistoryTable, factTextEditHistoryTable, factEnrichmentVersionsTable, pendingReviewsTable, type InsertEnrichmentOverrideHistory } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and, or, inArray, isNull, asc, gt, gte, sum, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireRole } from "../middlewares/tierMiddleware";
import { backfillEmbeddings, embedFactAsync } from "../lib/embeddings";
import { enrichFact, materializeEnrichment } from "../lib/factEnrichment";
import { recordOverrideHistory } from "../lib/enrichmentOverrideHistory";
import { findInFlightRefreshCandidate, refreshInReviewErrorBody } from "../lib/enrichmentVersioning";
import { sendFactBackToReview, SendBackToReviewError } from "../lib/sendBackToReview";
import { resubmitInactiveFactForModeration, ResubmitForModerationError } from "../lib/resubmitForModeration";
import {
  applyOverrideReset,
  applyOverrideUpsert,
  loadFactOverrideState,
  serializeResolved,
  stampOverrideProvenance,
  stripVisualOverride,
  type OverrideLayers,
  type VisualOverride,
} from "../lib/enrichmentOverrideLayers";
import { enqueueJob } from "../lib/asyncJobs";
import {
  validateEnrichment,
  computeBaselineChangedPaths,
  overrideValuesEqual,
  isOverridablePath,
  OVERRIDABLE_PATHS,
  OVERRIDABLE_PATH_KEYS,
  pathToField,
  FACT_TEXT_EDIT_CODES,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  type FactEnrichment,
  type ManualOverride,
  type OverridablePath,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { runFactImagePipeline, type FactPexelsImages, type PexelsPhotoEntry } from "../lib/factImagePipeline";
import { enqueueFactPexels } from "../lib/factPexelsJobs";
import { enqueueFactAiMemeBackfill } from "../lib/aiMemeBackfillJobs";
import { normalizeFactTemplateForPendingReview } from "../lib/normalizeFactTemplateForStorage";
import { createTriageReview } from "../lib/moderationStaging";
import { cascadeDeactivateActiveChildren, assertReparentAllowed } from "../lib/factActivation";
import { confirmedFactTextEdit } from "../lib/confirmedFactTextEdit";
import { logActivity } from "../lib/activity";
import { getAllConfig, bustConfigCache, getPublicConfig } from "../lib/adminConfig";
import {
  isMembershipConfigKey,
  loadMembershipConfig,
  validateMembershipConfigWrite,
} from "../lib/membershipTiming";
import { effectiveTierExpr } from "../lib/membershipState";
import { refreshAllSourcesForUser, refreshSubscriptionSource } from "../lib/membershipRefresh";
import {
  hasQualifyingLifetimeSource,
  recomputeMembership,
  writeAdminGrant,
  writeAdminRevocation,
} from "../lib/membershipSources";
import { authorizeAdminGrant, authorizeAdminRevocation } from "../lib/entitlementVerification";
import {
  FACT_ENRICHMENT_CONFIG_KEYS,
  FACT_ENRICHMENT_SYSTEM_DEFAULT,
  resolveFactEnrichmentSystemPrompt,
  hashPromptText,
} from "../lib/factEnrichmentConfig";
import { getAllTierFeatureMatrix, setTierFeature, bustTierFeaturesCache } from "../lib/tierFeatures";
import { ObjectStorageService } from "../lib/objectStorage";
import { memeKey } from "../lib/storageKeys";
import { getSiteBaseUrl } from "../lib/siteUrl";
import bcrypt from "bcryptjs";
import { softDeleteUserLifecycle, hardDeleteUserLifecycle, exportUserData, anonymizePaymentHistoryForUser, runRetentionWindowJobs } from "../lib/dataLifecycle";
import { getGovernanceAdminView } from "../lib/resourceGovernance";
import { validateVisualStrategyOverridePersistence } from "../lib/imagePrompt/promptBudget";
import { logger } from "../lib/logger";

const _styleStorage = new ObjectStorageService();

/**
 * Reinstatement recomputes from AUTHORITATIVE state, not from local rows.
 *
 * The old version asked "does a lifetime row exist" and "is there a subscription
 * whose period has not ended" — two bare-existence reads that both say yes for a
 * user whose purchase was refunded, or whose subscription Stripe has already
 * cancelled while the webhook was dropped. And reinstatement is a manual action
 * that can easily precede a reconciliation pass.
 *
 * So it refreshes every Stripe-backed source first. This is a rare,
 * high-consequence operation, so the extra retrieval is free.
 */
async function resolveUserTierOnReinstatement(userId: string): Promise<"registered" | "legendary"> {
  try {
    const { getUncachableStripeClient } = await import("../lib/stripeClient");
    const stripe = await getUncachableStripeClient();
    await refreshAllSourcesForUser(stripe, userId);
  } catch (err) {
    // Stripe unreachable. Recompute from what we have rather than block the
    // reinstatement — the result fails CLOSED, since a source we could not
    // refresh keeps whatever status it last had.
    logger.warn({ err, userId }, "reinstatement could not refresh Stripe sources — recomputing from local state");
  }

  const result = await db.transaction((tx) => recomputeMembership(tx, userId));
  return result?.tier === "legendary" ? "legendary" : "registered";
}

const router: IRouter = Router();

/**
 * Shim for backwards-compatibility.
 * Delegates to requireRole("admin") — the single source of admin gating.
 */
export const requireAdmin = requireRole("admin");

function toPexelsThumb(entry: PexelsPhotoEntry): {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
} {
  return {
    id: entry.id,
    url: entry.src?.large2x ?? entry.src?.large ?? entry.url,
    ...(entry.photographer !== undefined ? { photographer: entry.photographer } : {}),
    ...(entry.photographer_url !== undefined ? { photographer_url: entry.photographer_url } : {}),
  };
}

router.get("/admin/stats", requireAdmin, async (_req: Request, res: Response) => {
  const [[{ totalFacts }], [{ totalUsers }]] = await Promise.all([
    db.select({ totalFacts: count() }).from(factsTable).where(eq(factsTable.isActive, true)),
    db.select({ totalUsers: count() }).from(usersTable).where(eq(usersTable.isActive, true)),
  ]);
  res.json({ totalFacts, totalUsers });
});

router.get("/admin/resource-governance", requireAdmin, async (_req: Request, res: Response) => {
  res.json(getGovernanceAdminView());
});

router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const showInactive = req.query["inactive"] === "true";

  const activeFilter = showInactive ? undefined : eq(usersTable.isActive, true);
  const searchFilter = search
    ? sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.displayName} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`
    : undefined;
  const where = activeFilter && searchFilter ? and(activeFilter, searchFilter) : (activeFilter ?? searchFilter);

  // The admin list renders `membershipTier`, so it reports the EFFECTIVE tier
  // rather than the raw column: with the convergence sweep failing and a grace
  // horizon passed, authorization has already demoted the user and this screen
  // would otherwise still show Legendary. Both surfaces evaluate at one bound
  // instant so the list cannot disagree with itself mid-page.
  const asOf = new Date();
  const [users, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(usersTable), membershipTier: effectiveTierExpr(asOf) })
      .from(usersTable)
      .where(where)
      .orderBy(desc(usersTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(usersTable).where(where),
  ]);

  res.json({ users, total, page, limit });
});

router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const body = req.body as Record<string, unknown>;

  const updates: Record<string, unknown> = {};
  if (typeof body["isActive"] === "boolean") updates.isActive = body["isActive"];
  if (typeof body["isAdmin"] === "boolean") updates.isAdmin = body["isAdmin"];
  if (typeof body["adminNotifications"] === "boolean") updates.adminNotifications = body["adminNotifications"];
  if (typeof body["disputeNotifications"] === "boolean") updates.disputeNotifications = body["disputeNotifications"];
  if (typeof body["captchaVerified"] === "boolean") updates.captchaVerified = body["captchaVerified"];
  if (typeof body["nsfwModeEnabled"] === "boolean") updates.nsfwModeEnabled = body["nsfwModeEnabled"];
  if (body["displayName"] !== undefined) updates.displayName = body["displayName"] ? String(body["displayName"]) : null;
  if (body["email"] !== undefined) updates.email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  // `membershipTier` is deliberately NOT accepted here. It is derived from
  // entitlement sources, and accepting it would let an admin write a value the
  // next recompute silently reverts — the failure mode being that the change
  // appears to work and then does not. Comping a membership is
  // POST /admin/users/:id/grant-lifetime, which writes an entitlement.
  if (body["pronouns"] !== undefined) {
    const p = String(body["pronouns"]).trim();
    if (p.length > 0 && p.length <= 80) updates.pronouns = p;
  }
  if ("monthlyGenerationLimitOverrideUsd" in body) {
    if (body["monthlyGenerationLimitOverrideUsd"] === null || body["monthlyGenerationLimitOverrideUsd"] === "") {
      updates.monthlyGenerationLimitOverrideUsd = null;
    } else {
      const parsed = parseFloat(String(body["monthlyGenerationLimitOverrideUsd"]));
      if (!isNaN(parsed) && parsed >= 0) {
        updates.monthlyGenerationLimitOverrideUsd = String(parsed);
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  if (updates.isActive === true && body["membershipTier"] === undefined) {
    const [currentUser] = await db
      .select({ isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (currentUser && currentUser.isActive === false) {
      updates.membershipTier = await resolveUserTierOnReinstatement(id);
    }
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ success: true, user: updated });
});

router.get("/admin/administrators", requireAdmin, async (_req: Request, res: Response) => {
  const admins = await db
    .select({
      id: usersTable.id,
      displayName: usersTable.displayName,
      email: usersTable.email,
      adminNotifications: usersTable.adminNotifications,
      disputeNotifications: usersTable.disputeNotifications,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(eq(usersTable.isAdmin, true))
    .orderBy(usersTable.displayName);
  res.json({ administrators: admins });
});

router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const hard = req.query["hard"] === "true";

  if (hard) {
    // Verify the user exists before doing any cleanup work
    const [userToDelete] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!userToDelete) { res.status(404).json({ error: "User not found" }); return; }

    // stage tracks which logical phase is running so the UI can show accurate progress on error
    type HardDeleteStage = "collect" | "membership" | "nullify" | "delete";
    let currentStage: HardDeleteStage = "collect";

    try {
      const storage = new ObjectStorageService();

      // Step 1: Collect storage paths before DB cleanup (must happen before we nullify createdById)
      const [aiImages, userMemes] = await Promise.all([
        db.select({ storagePath: userAiImagesTable.storagePath })
          .from(userAiImagesTable)
          .where(eq(userAiImagesTable.userId, id)),
        db.select({ permalinkSlug: memesTable.permalinkSlug, imageSource: memesTable.imageSource })
          .from(memesTable)
          .where(eq(memesTable.createdById, id)),
      ]);

      // Step 2: Delete object storage files (non-fatal — log errors but continue)
      // Storage errors never abort the deletion; they are counted and surfaced in the summary.
      let aiImagesDeleted = 0;
      let memeImagesDeleted = 0;
      let storageErrors = 0;

      for (const img of aiImages) {
        try { await storage.deleteObject(img.storagePath); aiImagesDeleted++; }
        catch (e) { logger.error({ err: e, storagePath: img.storagePath }, "[hard-delete] AI image cleanup failed"); storageErrors++; }
      }
      for (const meme of userMemes) {
        const src = meme.imageSource as { type?: string; uploadKey?: string } | null;
        if (src === null) {
          // Pre-rendered meme image stored in object storage
          try { await storage.deleteObject(`/objects/${memeKey(meme.permalinkSlug, "jpg")}`); memeImagesDeleted++; }
          catch (e) { logger.error({ err: e, slug: meme.permalinkSlug }, "[hard-delete] Meme image cleanup failed"); storageErrors++; }
        } else if (src?.type === "upload" && src.uploadKey) {
          // User-uploaded background photo
          try { await storage.deleteObject(src.uploadKey); memeImagesDeleted++; }
          catch (e) { logger.error({ err: e }, "[hard-delete] Upload image cleanup failed"); storageErrors++; }
        }
      }

      // Step 2.5: Cancel active Stripe subscription (non-fatal — user is being permanently deleted)
      let subscriptionCanceled = false;
      const activeSubs = await db
        .select({ stripeSubscriptionId: membershipEntitlementsTable.providerRef })
        .from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
          or(
            eq(membershipEntitlementsTable.lifecycleStatus, "active"),
            eq(membershipEntitlementsTable.lifecycleStatus, "trialing"),
          ),
        ));
      if (activeSubs.length > 0) {
        try {
          const { getUncachableStripeClient } = await import("../lib/stripeClient");
          const stripe = await getUncachableStripeClient();
          let canceledCount = 0;
          for (const sub of activeSubs) {
            const subscriptionId = sub.stripeSubscriptionId;
            if (!subscriptionId) continue;
            try {
              // Update cancel_at_period_end to false first to ensure cancel() is immediate
              await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
              await stripe.subscriptions.cancel(subscriptionId);
              canceledCount++;
            } catch (e) {
              logger.error({ err: e, subscriptionId }, "[hard-delete] Failed to cancel subscription");
            }
          }
          subscriptionCanceled = canceledCount > 0;
        } catch (e) {
          logger.error({ err: e }, "[hard-delete] Stripe client initialization failed");
        }
      }

      // Step 3: Delete records with NOT NULL user_id FKs and no cascade
      currentStage = "membership";
      await db.delete(stripeCheckoutRequestLedgerTable).where(eq(stripeCheckoutRequestLedgerTable.userId, id));
      // membership_entitlements is NOT deleted here: its user_id FK is
      // ON DELETE CASCADE, so the rows go with the user in step 5. Deleting
      // them explicitly would also destroy the disputes that cascade off them
      // before the user row is gone, for no benefit.

      await db.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, id));
      await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, id));
      await db.execute(sql`DELETE FROM affiliate_clicks WHERE user_id = ${id}`);

      // Step 4: Nullify nullable user FKs on shared content (content outlives the user)
      currentStage = "nullify";
      await db.update(memesTable).set({ createdById: null }).where(eq(memesTable.createdById, id));
      await db.update(factsTable).set({ submittedById: null }).where(eq(factsTable.submittedById, id));
      await db.update(commentsTable).set({ authorId: null }).where(eq(commentsTable.authorId, id));
      await db.execute(sql`UPDATE external_links SET added_by_id = NULL WHERE added_by_id = ${id}`);
      await db.execute(sql`UPDATE pending_reviews SET submitted_by_id = NULL WHERE submitted_by_id = ${id}`);
      await db.execute(sql`UPDATE pending_reviews SET reviewed_by_id = NULL WHERE reviewed_by_id = ${id}`);
      await db.execute(sql`UPDATE video_jobs SET user_id = NULL WHERE user_id = ${id}`);

      // Step 5: Delete the user row — DB cascades handle sessions (via sessions.user_id FK),
      //         user_ai_images, user_fact_preferences, ratings, search_history, email/password tokens
      currentStage = "delete";
      const [deleted] = await db.delete(usersTable).where(eq(usersTable.id, id)).returning({ id: usersTable.id });
      if (!deleted) { res.status(404).json({ error: "User not found", stage: currentStage }); return; }

      res.json({ success: true, deleted: true, summary: { aiImagesDeleted, memeImagesDeleted, storageErrors, subscriptionCanceled } });
    } catch (e) {
      logger.error({ err: e, stage: currentStage }, "[hard-delete] Failed");
      res.status(500).json({ error: e instanceof Error ? e.message : "Deletion failed", stage: currentStage });
    }
  } else {
    // Soft delete: cancel subscription (non-fatal), revoke sessions, mark inactive
    type SoftDeleteStage = "stripe" | "sessions" | "deactivate";
    let currentStage: SoftDeleteStage = "stripe";

    try {
      // Step 1: Cancel active Stripe subscription (non-fatal)
      let subscriptionCanceled = false;
      const activeSubs = await db
        .select({ stripeSubscriptionId: membershipEntitlementsTable.providerRef })
        .from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
          or(
            eq(membershipEntitlementsTable.lifecycleStatus, "active"),
            eq(membershipEntitlementsTable.lifecycleStatus, "trialing"),
          ),
        ));
      if (activeSubs.length > 0) {
        try {
          const { getUncachableStripeClient } = await import("../lib/stripeClient");
          const stripe = await getUncachableStripeClient();
          let canceledCount = 0;
          for (const sub of activeSubs) {
            const subscriptionId = sub.stripeSubscriptionId;
            if (!subscriptionId) continue;
            try {
              // Update cancel_at_period_end to false first to ensure cancel() is immediate
              await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
              await stripe.subscriptions.cancel(subscriptionId);
              // Apply the cancellation LOCALLY rather than waiting for the
              // webhook. Under a derived model, leaving the row `active` means a
              // later reinstatement recomputes Legendary for a user whose
              // subscription Stripe has already cancelled — and "the webhook
              // usually closes the gap" is exactly what this model refuses.
              await refreshSubscriptionSource(stripe, subscriptionId, {
                transitionEvent: "subscription_cancelled",
              });
              canceledCount++;
            } catch (e) {
              logger.error({ err: e, subscriptionId }, "[soft-delete] Failed to cancel subscription");
            }
          }
          subscriptionCanceled = canceledCount > 0;
        } catch (e) {
          logger.error({ err: e }, "[soft-delete] Stripe client initialization failed");
        }
      }

      // Step 2: Invalidate all active sessions immediately
      currentStage = "sessions";
      const deletedSessions = await db.delete(sessionsTable).where(eq(sessionsTable.userId, id)).returning({ sid: sessionsTable.sid });
      const sessionsRevoked = deletedSessions.length;

      // Step 3: Mark user inactive
      currentStage = "deactivate";
      const [updated] = await db.update(usersTable)
        .set({ isActive: false })
        .where(and(eq(usersTable.id, id), eq(usersTable.isActive, true)))
        .returning();
      if (!updated) { res.status(404).json({ error: "User not found or already inactive", stage: currentStage }); return; }

      res.json({ success: true, deleted: false, user: updated, summary: { subscriptionCanceled, sessionsRevoked } });
    } catch (e) {
      logger.error({ err: e, stage: currentStage }, "[soft-delete] Failed");
      res.status(500).json({ error: e instanceof Error ? e.message : "Soft delete failed", stage: currentStage });
    }
  }
});

// GET /admin/users/:id/membership — full membership status for a user
router.get("/admin/users/:id/membership", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [lifetimeRows, subRows, historyRows] = await Promise.all([
      // A lifetime PURCHASE and an admin GRANT are now different source types,
      // where the old schema conflated them: a comp was a lifetime row with a
      // synthesized payment-intent id and amount 0. This screen shows both, and
      // says which is which.
      db.select({
        id: membershipEntitlementsTable.id,
        userId: membershipEntitlementsTable.userId,
        sourceType: membershipEntitlementsTable.sourceType,
        stripePaymentIntentId: membershipEntitlementsTable.providerRef,
        amount: membershipEntitlementsTable.amount,
        currency: membershipEntitlementsTable.currency,
        status: membershipEntitlementsTable.lifecycleStatus,
        isMembershipProduct: membershipEntitlementsTable.isMembershipProduct,
        disputeLossRevokedAt: membershipEntitlementsTable.disputeLossRevokedAt,
        grantedByAdminId: membershipEntitlementsTable.grantedByAdminId,
        grantedByAdminLabel: membershipEntitlementsTable.grantedByAdminLabel,
        grantReason: membershipEntitlementsTable.grantReason,
        createdAt: membershipEntitlementsTable.createdAt,
      })
        .from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          or(
            eq(membershipEntitlementsTable.sourceType, "stripe_lifetime_payment"),
            eq(membershipEntitlementsTable.sourceType, "admin_grant"),
          ),
        ))
        .orderBy(desc(membershipEntitlementsTable.createdAt))
        .limit(5),
      db.select().from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
        ))
        .orderBy(desc(membershipEntitlementsTable.createdAt))
        .limit(1),
      (() => {
        const adminUsers = alias(usersTable, "admin_users");
        return db.select({
          id: membershipHistoryTable.id,
          event: membershipHistoryTable.event,
          plan: membershipHistoryTable.plan,
          amount: membershipHistoryTable.amount,
          currency: membershipHistoryTable.currency,
          createdAt: membershipHistoryTable.createdAt,
          stripePaymentIntentId: membershipHistoryTable.stripePaymentIntentId,
          stripeInvoiceId: membershipHistoryTable.stripeInvoiceId,
          stripeDisputeId: membershipHistoryTable.stripeDisputeId,
          performedByAdminId: membershipHistoryTable.performedByAdminId,
          performedByAdminDisplayName: adminUsers.displayName,
          performedByAdminEmail: adminUsers.email,
        }).from(membershipHistoryTable)
          .leftJoin(adminUsers, eq(membershipHistoryTable.performedByAdminId, adminUsers.id))
          .where(eq(membershipHistoryTable.userId, id))
          .orderBy(desc(membershipHistoryTable.createdAt))
          .limit(30);
      })(),
    ]);

    // The shape this endpoint has always returned, rebuilt from the entitlement
    // source so the admin client contract is unchanged — same pattern as
    // GET /stripe/subscription.
    const subSource = subRows[0] ?? null;
    const appSub = subSource
      ? {
          id: subSource.id,
          userId: subSource.userId,
          stripeSubscriptionId: subSource.providerRef,
          plan: subSource.plan,
          status: subSource.lifecycleStatus,
          currentPeriodEnd: subSource.currentPeriodEnd,
          cancelAtPeriodEnd: subSource.cancelAtPeriodEnd ?? false,
          createdAt: subSource.createdAt,
          updatedAt: subSource.updatedAt,
        }
      : null;

    let stripeSub: Record<string, unknown> | null = null;
    if (appSub?.stripeSubscriptionId) {
      const result = await db.execute(
        sql`SELECT s.id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.canceled_at, s.created
            FROM stripe.subscriptions s WHERE s.id = ${appSub.stripeSubscriptionId} LIMIT 1`,
      );
      stripeSub = (result.rows[0] as Record<string, unknown>) ?? null;
    }

    const { getConfigStringRaw } = await import("../lib/adminConfig");
    const liveMode = (await getConfigStringRaw("stripe_live_mode", "false")) === "true";

    res.json({
      // Qualification, not existence: a refunded purchase keeps its row.
      isLifetime: await hasQualifyingLifetimeSource(id),
      lifetimeEntitlement: lifetimeRows[0] ?? null,
      appSubscription: appSub,
      stripeSub,
      history: historyRows,
      liveMode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch membership data";
    res.status(500).json({ error: msg });
  }
});

// GET /admin/refunds-disputes — paginated list of refund/dispute events from membership_history
// Returns rows for events: refund, dispute_opened, dispute_won, dispute_lost, dispute_closed.
// Joined with the users table so the UI can display who was affected without a second round-trip.
router.get("/admin/refunds-disputes", requireAdmin, async (req: Request, res: Response) => {
  const REFUND_DISPUTE_EVENTS = [
    "refund",
    "dispute_opened",
    "dispute_won",
    "dispute_lost",
    "dispute_closed",
  ] as const;

  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();

  // Event filter: comma-separated list, falling back to all refund/dispute events.
  const rawEvent = String(req.query["event"] ?? "").trim();
  const requestedEvents = rawEvent
    ? rawEvent.split(",").map((e) => e.trim()).filter((e): e is typeof REFUND_DISPUTE_EVENTS[number] =>
        (REFUND_DISPUTE_EVENTS as readonly string[]).includes(e),
      )
    : [...REFUND_DISPUTE_EVENTS];
  const eventList = requestedEvents.length > 0 ? requestedEvents : [...REFUND_DISPUTE_EVENTS];

  const eventFilter = inArray(membershipHistoryTable.event, eventList);
  const searchFilter = search
    ? sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.displayName} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`
    : undefined;
  const where = searchFilter ? and(eventFilter, searchFilter) : eventFilter;

  try {
    const { getConfigStringRaw } = await import("../lib/adminConfig");
    const liveMode = (await getConfigStringRaw("stripe_live_mode", "false")) === "true";

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: membershipHistoryTable.id,
          createdAt: membershipHistoryTable.createdAt,
          event: membershipHistoryTable.event,
          plan: membershipHistoryTable.plan,
          amount: membershipHistoryTable.amount,
          currency: membershipHistoryTable.currency,
          stripePaymentIntentId: membershipHistoryTable.stripePaymentIntentId,
          stripeSubscriptionId: membershipHistoryTable.stripeSubscriptionId,
          stripeInvoiceId: membershipHistoryTable.stripeInvoiceId,
          stripeDisputeId: membershipHistoryTable.stripeDisputeId,
          userId: membershipHistoryTable.userId,
          userEmail: usersTable.email,
          userDisplayName: usersTable.displayName,
        })
        .from(membershipHistoryTable)
        .leftJoin(usersTable, eq(membershipHistoryTable.userId, usersTable.id))
        .where(where)
        .orderBy(desc(membershipHistoryTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(membershipHistoryTable)
        .leftJoin(usersTable, eq(membershipHistoryTable.userId, usersTable.id))
        .where(where),
    ]);

    res.json({ rows, total, page, limit, liveMode, eventTypes: REFUND_DISPUTE_EVENTS });
  } catch (err) {
    logger.error({ err }, "[admin] refunds-disputes error");
    const msg = err instanceof Error ? err.message : "Failed to load refunds and disputes";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/grant-lifetime — comp a membership
//
// W1b: an admin comp is an ENTITLEMENT with an actor, a label and a reason —
// never a payment. What this replaces inserted a `lifetime_entitlements` row
// with a synthesized payment-intent id (`admin_grant_<timestamp>_<random>`),
// `stripeCustomerId: "admin_grant"` and `amount: 0`, which is indistinguishable
// from a real purchase in any payment audit, and then set the tier by hand.
router.post("/admin/users/:id/grant-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [userRows] = await Promise.all([
      db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1),
    ]);
    if (!userRows[0]) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const actor = req.user!;
    // The only constructor for a grant. It throws rather than returning a
    // partial record, so a blank actor or reason cannot reach the database and
    // be discovered at a constraint — or not at all, if a future writer bypasses
    // the constraint's shape.
    const grant = authorizeAdminGrant({
      userId: id,
      grantedByAdminId: actor.id,
      grantedByAdminLabel: actor.email ?? actor.displayName ?? actor.id,
      grantReason: String((req.body as Record<string, unknown>)?.["reason"] ?? "").trim() ||
        "Comped by an administrator",
    });

    const outcome = await db.transaction(async (tx) => {
      const { created } = await writeAdminGrant(tx, grant);
      if (!created) return { created: false as const };

      await tx.insert(membershipHistoryTable).values({
        userId: id,
        event: "admin_grant",
        performedByAdminId: actor.id,
      });
      // The tier is DERIVED, not assigned. This is the same recompute every
      // other writer calls.
      await recomputeMembership(tx, id);
      return { created: true as const };
    });

    if (!outcome.created) {
      // The partial unique index on active admin grants makes a duplicate
      // submission — or a retry after an uncertain response — a no-op rather
      // than a second qualifying row that would survive a later revoke.
      res.status(400).json({ error: "User already has an active admin grant" });
      return;
    }

    const [updated] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    res.json({ success: true, user: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Grant failed";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/revoke-lifetime — revoke an admin grant
//
// W1b's revocation clause: the grant is marked revoked WITH provenance, never
// deleted. Deleting it — which is what this replaces — destroys the record that
// a human granted and a human took it away, and history is append-only.
router.post("/admin/users/:id/revoke-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const actor = req.user!;
    const revocation = authorizeAdminRevocation({
      revokedByAdminId: actor.id,
      revokedByAdminLabel: actor.email ?? actor.displayName ?? actor.id,
      revokedReason: String((req.body as Record<string, unknown>)?.["reason"] ?? "").trim() ||
        "Revoked by an administrator",
    });

    const outcome = await db.transaction(async (tx) => {
      const { revoked } = await writeAdminRevocation(tx, id, revocation);
      if (!revoked) return { revoked: false as const };

      await tx.insert(membershipHistoryTable).values({
        userId: id,
        event: "admin_revoke",
        performedByAdminId: actor.id,
      });
      await recomputeMembership(tx, id);
      return { revoked: true as const };
    });

    if (!outcome.revoked) {
      res.status(400).json({ error: "User does not have an active admin grant" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Revoke failed";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  const password = body["password"] ? String(body["password"]) : null;
  const displayName = body["displayName"] ? String(body["displayName"]).trim() : null;
  const membershipTier = ["unregistered", "registered", "legendary"].includes(String(body["membershipTier"] ?? "unregistered"))
    ? (String(body["membershipTier"] ?? "unregistered") as "unregistered" | "registered" | "legendary")
    : "unregistered";
  const isAdmin = body["isAdmin"] === true;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }
  if (!password) {
    res.status(400).json({ error: "Password is required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (password.length > 128) {
    res.status(400).json({ error: "Password must be at most 128 characters" });
    return;
  }
  if (!displayName) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    // Settled decision 8: admin user-creation writes an ENTITLEMENT, never a
    // tier. Creating a user at `legendary` directly would put the one field this
    // whole model derives back under manual control, and the first recompute
    // would silently undo it — the user would appear Legendary until any event
    // touched them, then drop.
    const actor = req.user!;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(usersTable)
        .values({
          email,
          passwordHash,
          displayName,
          // Never `legendary`: that tier is granted below, through the model.
          membershipTier: membershipTier === "legendary" ? "registered" : membershipTier,
          isAdmin,
          isActive: true,
        })
        .returning();

      if (membershipTier === "legendary") {
        await writeAdminGrant(
          tx,
          authorizeAdminGrant({
            userId: row.id,
            grantedByAdminId: actor.id,
            grantedByAdminLabel: actor.email ?? actor.displayName ?? actor.id,
            grantReason: "Created as a Legendary member by an administrator",
          }),
        );
        await tx.insert(membershipHistoryTable).values({
          userId: row.id,
          event: "admin_grant",
          performedByAdminId: actor.id,
        });
        await recomputeMembership(tx, row.id);
        const [refreshed] = await tx.select().from(usersTable).where(eq(usersTable.id, row.id)).limit(1);
        return refreshed ?? row;
      }

      return row;
    });

    const { passwordHash: _omit, ...safeUser } = created;
    res.status(201).json({ success: true, user: safeUser });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      if (msg.includes("email")) {
        res.status(409).json({ error: "A user with that email already exists" });
      } else {
        res.status(409).json({ error: "A user with those details already exists" });
      }
      return;
    }
    logger.error({ err }, "[admin] Create user error");
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Column projection shared by the root + variant selects in the facts list.
const FACT_LIST_COLUMNS = {
  id: factsTable.id,
  text: factsTable.text,
  canonicalText: factsTable.canonicalText,
  parentId: factsTable.parentId,
  useCase: factsTable.useCase,
  isActive: factsTable.isActive,
  upvotes: factsTable.upvotes,
  downvotes: factsTable.downvotes,
  score: factsTable.score,
  wilsonScore: factsTable.wilsonScore,
  commentCount: factsTable.commentCount,
  shareCount: factsTable.shareCount,
  submittedById: factsTable.submittedById,
  splitTokenIndex: factsTable.splitTokenIndex,
  createdAt: factsTable.createdAt,
  updatedAt: factsTable.updatedAt,
  primaryArchetype: factsTable.primaryArchetype,
  enrichmentStatus: factsTable.enrichmentStatus,
  hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
  hasPexelsImages: sql<boolean>`(${factsTable.pexelsImages} IS NOT NULL)`,
  hasEnrichment: sql<boolean>`(${factsTable.enrichment} IS NOT NULL)`,
  hasEnrichmentOverrides: sql<boolean>`(${factsTable.enrichmentOverrides} <> '{}'::jsonb)`,
  enrichmentBaselineChanged: factsTable.enrichmentBaselineChanged,
  // Eval harness (Slice 2B): golden-set membership, so the Facts editor can show
  // + toggle it and reflect the saved state.
  evalGolden: factsTable.evalGolden,
  evalGoldenReason: factsTable.evalGoldenReason,
} as const;

// The Facts list is paginated by ROOT fact (parentId IS NULL); each root carries
// its variants nested so the admin UI can show the hierarchy (variants indented +
// collapsible under their parent). A root is included when it (or one of its
// variants) matches the search. Variants attached to a page's roots are filtered
// to the search too, so a search shows matches grouped under their parent.
router.get("/admin/facts", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const visibility = String(req.query["visibility"] ?? (req.query["inactive"] === "true" ? "both" : "active"));
  const onlyOverridden = req.query["hasOverrides"] === "true";
  const onlyBaselineChanged = req.query["baselineChanged"] === "true";
  const like = `%${search}%`;

  const activeFilter = visibility === "both" ? undefined : eq(factsTable.isActive, visibility !== "inactive");
  const visibleVariantSql =
    visibility === "both"
      ? sql``
      : visibility === "inactive"
        ? sql` AND v.is_active = false`
        : sql` AND v.is_active = true`;
  const rootVisibilityFilter =
    visibility === "both"
      ? undefined
      : sql`(${factsTable.isActive} = ${visibility !== "inactive"} OR EXISTS (SELECT 1 FROM facts v WHERE v.parent_id = ${factsTable.id}${visibleVariantSql}))`;
  const overridesFilter = onlyOverridden ? sql`${factsTable.enrichmentOverrides} <> '{}'::jsonb` : undefined;
  const baselineChangedFilter = onlyBaselineChanged ? eq(factsTable.enrichmentBaselineChanged, true) : undefined;
  // A root matches when its own text matches OR it has a (visible) variant whose
  // text matches — so searching by a variant's text still surfaces its parent.
  const searchFilter = search
    ? sql`(${factsTable.text} ILIKE ${like} OR EXISTS (SELECT 1 FROM facts v WHERE v.parent_id = ${factsTable.id} AND v.text ILIKE ${like}${visibleVariantSql}))`
    : undefined;
  const rootWhere = and(...[isNull(factsTable.parentId), rootVisibilityFilter, searchFilter, overridesFilter, baselineChangedFilter].filter(Boolean));

  const [roots, [{ total }]] = await Promise.all([
    db.select(FACT_LIST_COLUMNS)
      .from(factsTable)
      .where(rootWhere)
      .orderBy(desc(factsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factsTable).where(rootWhere),
  ]);

  // Attach each page-root's variants (search-filtered when searching) so the UI
  // can render them indented + collapsible under the parent.
  const rootIds = roots.map((r) => r.id);
  let variantsByParent = new Map<number, (typeof roots)>();
  if (rootIds.length) {
    const variantWhere = and(
      ...[
        inArray(factsTable.parentId, rootIds),
        activeFilter,
        search ? ilike(factsTable.text, like) : undefined,
      ].filter(Boolean),
    );
    const variantRows = await db.select(FACT_LIST_COLUMNS)
      .from(factsTable)
      .where(variantWhere)
      .orderBy(asc(factsTable.createdAt));
    variantsByParent = variantRows.reduce((m, v) => {
      const key = v.parentId as number;
      (m.get(key) ?? m.set(key, []).get(key)!).push(v);
      return m;
    }, new Map<number, typeof variantRows>());
  }

  const facts = roots.map((r) => ({ ...r, variants: variantsByParent.get(r.id) ?? [] }));

  res.json({ facts, total, page, limit });
});

router.delete("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const hard = req.query["hard"] === "true";

  try {
    // Removing a root (soft or hard) that still has active variants would leave
    // them active under an inactive/missing parent — the same orphan state
    // cascadeDeactivateActiveChildren exists to prevent elsewhere. facts.parent_id
    // has no FK/ON DELETE behavior, so a hard delete in particular would strand
    // them indefinitely (nothing else ever revisits them). Cascade in the same
    // transaction as the removal for both paths.
    if (hard) {
      const deleted = await db.transaction(async (tx) => {
        // Delete THIS row first (locks it for the delete), then cascade — not
        // the reverse. The cascade's own children-check must run only after
        // we've serialized against a concurrent activateFact validating this
        // exact row as a parent (its parent-revalidation locks this same row
        // via FOR UPDATE): deleting first means either we win the lock and
        // delete before it locks (so its own re-check then sees no parent row
        // and fails), or it wins first (activates a child, commits, releases
        // the lock) and OUR delete then proceeds, with the cascade below
        // running after — catching that newly-active child. Cascading before
        // ever touching this row (the old order) never contended for the lock
        // at all, so a variant could activate under this root moments after
        // the cascade found nothing and moments before the delete removed it.
        const [row] = await tx.delete(factsTable).where(eq(factsTable.id, id)).returning({ id: factsTable.id });
        if (row) await cascadeDeactivateActiveChildren(tx, id);
        return row;
      });
      if (!deleted) { res.status(404).json({ error: "Fact not found" }); return; }
      res.json({ success: true, deleted: true });
    } else {
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(factsTable).set({ isActive: false }).where(and(eq(factsTable.id, id), eq(factsTable.isActive, true))).returning({ id: factsTable.id });
        if (row) await cascadeDeactivateActiveChildren(tx, id);
        return row;
      });
      if (!updated) { res.status(404).json({ error: "Fact not found or already inactive" }); return; }
      res.json({ success: true, deleted: false });
    }
  } catch (e) {
    logger.error({ err: e, factId: id, hard }, "[DELETE /admin/facts/:id] failed");
    res.status(500).json({ error: "Failed to delete fact" });
  }
});

/** Shared success response — strips the raw embedding, adds the has* flags, and
 *  merges any extra fields (audit id, variant count, prep dispatch). */
function respondFactUpdate(
  res: Response,
  updated: typeof factsTable.$inferSelect,
  extra: Record<string, unknown> = {},
): void {
  const { embedding: _emb, ...factRow } = updated;
  res.json({
    success: true,
    ...extra,
    fact: {
      ...factRow,
      hasEmbedding: updated.embedding !== null,
      hasPexelsImages: updated.pexelsImages !== null,
    },
  });
}

router.patch("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const body = req.body as Record<string, unknown>;
  const { text, upvotes, downvotes, score, wilsonScore, commentCount, shareCount, submittedById, parentId, useCase, isActive, confirmTextEdit } = body;

  // Coerce the non-text column updates (shared by both paths). Text/canonical/
  // split are NEVER set here — they flow only through the locked service below.
  const nonTextUpdates: Record<string, unknown> = {};
  if (upvotes !== undefined) nonTextUpdates.upvotes = Number(upvotes);
  if (downvotes !== undefined) nonTextUpdates.downvotes = Number(downvotes);
  if (score !== undefined) nonTextUpdates.score = Number(score);
  if (wilsonScore !== undefined) nonTextUpdates.wilsonScore = Number(wilsonScore);
  if (commentCount !== undefined) nonTextUpdates.commentCount = Number(commentCount);
  if (shareCount !== undefined) nonTextUpdates.shareCount = Number(shareCount);
  if (submittedById !== undefined) nonTextUpdates.submittedById = submittedById ? String(submittedById) : null;
  if (parentId !== undefined) nonTextUpdates.parentId = parentId !== null && parentId !== "" ? Number(parentId) : null;
  if (useCase !== undefined) nonTextUpdates.useCase = useCase ? String(useCase) : null;
  if (isActive !== undefined) nonTextUpdates.isActive = Boolean(isActive);

  // Fetch current state once if either guard below needs it.
  let current: { isActive: boolean } | undefined;
  if (nonTextUpdates.isActive === true || (nonTextUpdates.parentId !== undefined && nonTextUpdates.parentId !== null)) {
    [current] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
    if (!current) { res.status(404).json({ error: "Fact not found" }); return; }
  }

  // Activation is moderation-only (Phase 2 fact-lifecycle closure). The admin
  // Active toggle may DEACTIVATE a fact (true→false is always safe) but may NOT
  // ACTIVATE one: a false→true flip here would bypass the entire production gate
  // that approveForProduction/activateFact enforce (Visual Concept check,
  // active-root parent revalidation, the pending_reviews transition,
  // production-approval recording, submitter notification). To bring a
  // deactivated fact back, re-moderate it. So: reject any false→true request;
  // asserting isActive=true on an already-active fact is a harmless no-op that we
  // simply drop.
  if (nonTextUpdates.isActive === true) {
    if (current!.isActive === false) {
      res.status(400).json({
        error: "A fact can only be activated through moderation. Deactivated facts must be re-moderated to go live again.",
        code: "ACTIVATION_REQUIRES_MODERATION",
      });
      return;
    }
    delete nonTextUpdates.isActive;
  }

  // Active-root parent invariant: this PATCH's parentId field is otherwise
  // unguarded, so an admin could point an ACTIVE fact at an inactive/missing/
  // non-root parent, bypassing the same active-root revalidation activateFact
  // performs at activation time — reintroducing exactly the orphan state Phase 2
  // closes. Only matters when the target fact IS (or remains) active: a fact
  // that's inactive, or being deactivated by this same request, can point
  // anywhere (activateFact will revalidate whenever it's next activated).
  //
  // A fact can never be its own parent, active or not — this is a structural
  // invariant, not just an active-root one, and cheap to check up front.
  if (nonTextUpdates.parentId !== undefined && nonTextUpdates.parentId === id) {
    res.status(400).json({ error: "A fact cannot be its own parent.", code: "SELF_PARENT" });
    return;
  }
  // The active-root lookup + active-children check, however, MUST run inside
  // the same transaction as the write, with the parent row locked (`FOR
  // UPDATE`) — otherwise a concurrent deactivate/delete of that parent (or a
  // concurrent variant created under `id`) between this check and the write
  // below could still land an active variant under an inactive/missing root,
  // exactly mirroring the TOCTOU `activateFact` itself guards against. See the
  // transaction below.
  const reparenting = nonTextUpdates.parentId !== undefined && nonTextUpdates.parentId !== null;
  const reparentStaysActive = reparenting && current!.isActive && nonTextUpdates.isActive !== false;

  // ── Non-text-only PATCH — unchanged behavior ──────────────────────────────
  if (text === undefined) {
    if (Object.keys(nonTextUpdates).length === 0) {
      const [current] = await db.select().from(factsTable).where(eq(factsTable.id, id)).limit(1);
      if (!current) { res.status(404).json({ error: "Fact not found" }); return; }
      respondFactUpdate(res, current);
      return;
    }
    // Deactivating a fact that's an active root with active children would
    // strand those children active under a now-inactive parent, so cascade in
    // the same transaction (no-op if there's nothing to cascade — see
    // cascadeDeactivateActiveChildren).
    const deactivating = nonTextUpdates.isActive === false;
    type PatchTxResult =
      | { kind: "guard"; status: number; body: Record<string, unknown> }
      | { kind: "ok"; row: typeof factsTable.$inferSelect | undefined };
    const result: PatchTxResult = await db.transaction(async (tx): Promise<PatchTxResult> => {
      if (reparentStaysActive) {
        // Lock `id`'s own row BEFORE checking its active children —
        // assertReparentAllowed's contract requires the target already locked
        // by the caller (confirmedFactTextEdit's text-edit path satisfies this
        // incidentally, since it locks the fact row for its own CAS first; this
        // branch didn't). Without it, a concurrent activateFact activating a
        // variant UNDER `id` (which locks `id` as the parent via the same
        // FOR UPDATE primitive) can interleave between this check and the
        // reparent UPDATE below: whichever side loses the race for `id`'s lock
        // sees the other's committed result — either `id` already has a new
        // parent (so activateFact's own parent-revalidation then correctly
        // fails), or `id` already has the newly-active child (so the
        // active-children check below, now running after the lock, correctly
        // rejects) — instead of both proceeding on stale reads.
        const [targetLock] = await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).for("update").limit(1);
        if (!targetLock) {
          return { kind: "guard", status: 404, body: { error: "Fact not found" } };
        }
        const failure = await assertReparentAllowed(tx, { factId: id, parentId: nonTextUpdates.parentId as number });
        if (failure) {
          return { kind: "guard", status: 400, body: { error: failure.message, code: failure.code } };
        }
      }
      const [row] = await tx.update(factsTable).set(nonTextUpdates).where(eq(factsTable.id, id)).returning();
      if (row && deactivating) {
        await cascadeDeactivateActiveChildren(tx, id);
      }
      return { kind: "ok", row };
    });
    if (result.kind === "guard") { res.status(result.status).json(result.body); return; }
    if (!result.row) { res.status(404).json({ error: "Fact not found" }); return; }
    respondFactUpdate(res, result.row);
    return;
  }

  // ── Text present → the approved-fact-text lock service owns the decision ───
  const outcome = await confirmedFactTextEdit({
    factId: id,
    rawText: String(text),
    confirmation: confirmTextEdit,
    performedBy: req.user!.id,
    nonTextUpdates,
  });

  switch (outcome.kind) {
    case "not_found":
      res.status(404).json({ error: "Fact not found" });
      return;
    case "too_long":
      res.status(422).json({ error: outcome.message, code: FACT_TEXT_EDIT_CODES.TOO_LONG });
      return;
    case "grammar_invalid":
      res.status(422).json({ error: outcome.message, code: FACT_TEXT_EDIT_CODES.GRAMMAR_INVALID });
      return;
    case "invalid_confirmation":
      res.status(422).json({ error: outcome.message, code: FACT_TEXT_EDIT_CODES.INVALID_CONFIRMATION });
      return;
    case "confirmation_required":
      res.status(409).json({ error: "This fact is approved — editing its text needs explicit confirmation.", code: FACT_TEXT_EDIT_CODES.REQUIRES_CONFIRMATION, impact: outcome.impact });
      return;
    case "stale_baseline":
      res.status(409).json({ error: "The stored wording changed since you opened this — review the new diff.", code: FACT_TEXT_EDIT_CODES.STALE_BASELINE, impact: outcome.impact });
      return;
    case "staging_prep_in_progress":
      res.status(409).json({ error: "Prep is still running for this fact. Wait for it to finish, then edit.", code: FACT_TEXT_EDIT_CODES.STAGING_PREP_IN_PROGRESS });
      return;
    case "reparent_rejected":
      res.status(400).json({ error: outcome.failure.message, code: outcome.failure.code });
      return;
    case "no_text_change":
      respondFactUpdate(res, outcome.fact);
      return;
    case "protected_committed":
      // Confirmed edit: re-embed + re-seed stock photos for the fact being
      // edited, root or variant (variant independence — a variant generates
      // its own images/embedding too, not just a root).
      void embedFactAsync(outcome.fact.id, outcome.fact.text, outcome.fact.canonicalText ?? undefined);
      void runFactImagePipeline(outcome.fact.id, outcome.fact.text);
      respondFactUpdate(res, outcome.fact, { auditRowId: outcome.auditRowId });
      return;
    case "staging_restarted":
      respondFactUpdate(res, outcome.fact, { prepDispatch: outcome.prepDispatch });
      return;
  }
});

// GET /admin/facts/:id/text-edit-history — the rare, dire-warning-gated edits
// of this fact's approved text (approved-fact-text lock). Admin-only,
// fact-scoped, newest-first, paginated. The actor is rendered from the joined
// user row, with a deleted/system fallback when performed_by was set null by a
// hard user deletion.
router.get("/admin/facts/:id/text-edit-history", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 20, 1), 100);
  const offset = Math.max(Number(req.query["offset"]) || 0, 0);

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: factTextEditHistoryTable.id,
        oldText: factTextEditHistoryTable.oldText,
        newText: factTextEditHistoryTable.newText,
        reason: factTextEditHistoryTable.reason,
        createdAt: factTextEditHistoryTable.createdAt,
        performedById: factTextEditHistoryTable.performedBy,
        performedByName: usersTable.displayName,
        performedByEmail: usersTable.email,
      })
      .from(factTextEditHistoryTable)
      .leftJoin(usersTable, eq(usersTable.id, factTextEditHistoryTable.performedBy))
      .where(eq(factTextEditHistoryTable.factId, id))
      .orderBy(desc(factTextEditHistoryTable.createdAt), desc(factTextEditHistoryTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factTextEditHistoryTable).where(eq(factTextEditHistoryTable.factId, id)),
  ]);

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      oldText: r.oldText,
      newText: r.newText,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      // Deleted-admin fallback: performed_by went null on hard user deletion.
      actor: r.performedById == null ? null : { id: r.performedById, name: r.performedByName ?? null, email: r.performedByEmail ?? null },
    })),
    total,
    limit,
    offset,
  });
});

// GET /admin/facts/:id/pexels-images — all stored Pexels thumbnails for the
// Facts editor. Admin-only and deliberately separate from the public paginated
// endpoint so inactive facts and all gender variants can be inspected.
router.get("/admin/facts/:id/pexels-images", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db
    .select({
      pexelsImages: factsTable.pexelsImages,
      pexelsStatus: factsTable.pexelsStatus,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const raw = fact.pexelsImages as FactPexelsImages | null;
  res.json({
    pexelsStatus: fact.pexelsStatus ?? null,
    factType: raw?.fact_type ?? null,
    keywords: raw?.keywords ?? null,
    images: {
      male: (raw?.male ?? []).map(toPexelsThumb),
      female: (raw?.female ?? []).map(toPexelsThumb),
      neutral: (raw?.neutral ?? []).map(toPexelsThumb),
    },
  });
});

// GET /admin/facts/:id — admin detail shape for the Facts editor. Intentionally
// trimmed: includes the editable scalars + the enrichment blob and
// enrichmentStatus, but omits the embedding vector and the large generation
// blobs (aiScenePrompts, aiMemeImages, raw pexelsImages) the editor never
// touches. `:id` must be a positive integer (a non-numeric segment is a 400,
// never a silent match against a static subpath like /import).
router.get("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [row] = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      canonicalText: factsTable.canonicalText,
      parentId: factsTable.parentId,
      useCase: factsTable.useCase,
      isActive: factsTable.isActive,
      upvotes: factsTable.upvotes,
      downvotes: factsTable.downvotes,
      score: factsTable.score,
      wilsonScore: factsTable.wilsonScore,
      commentCount: factsTable.commentCount,
      shareCount: factsTable.shareCount,
      submittedById: factsTable.submittedById,
      splitTokenIndex: factsTable.splitTokenIndex,
      createdAt: factsTable.createdAt,
      updatedAt: factsTable.updatedAt,
      enrichment: factsTable.enrichment,
      enrichmentStatus: factsTable.enrichmentStatus,
      hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
      hasPexelsImages: sql<boolean>`(${factsTable.pexelsImages} IS NOT NULL)`,
      // Eval golden-set membership, so the focused/deep-linked Facts editor
      // (e.g. /admin/facts?focus=<id>) reflects the saved state and can toggle it
      // — matching the list projection above.
      evalGolden: factsTable.evalGolden,
      evalGoldenReason: factsTable.evalGoldenReason,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Fact not found" }); return; }

  res.json(row);
});

// The override-layer machinery (loadFactOverrideState, serializeResolved,
// applyOverrideUpsert/Reset, provenance stamping) lives in
// lib/enrichmentOverrideLayers.ts, SHARED with the refresh-candidate editing
// routes so the two write paths can never drift. This file keeps owning the
// fact-specific persistence: row locks, the refresh write-freeze check,
// materialization onto facts.*, and override-history audit rows.
// GET /admin/facts/:id/enrichment-resolved — the AI baseline, the manual override
// map, the materialized effective blob, and the unified manual-intervention
// summary the editor uses to decorate diverged fields.
router.get("/admin/facts/:id/enrichment-resolved", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const state = await loadFactOverrideState(db, id);
  if (!state) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json(serializeResolved(state));
});

// PUT /admin/facts/:id/enrichment-overrides — create/update a manual override for
// one allowlisted path. Runs in a transaction with a row lock and merges against
// the latest stored overrides so concurrent edits to different paths never clobber
// each other. Resetting to the AI value deletes the override (never stores
// override == AI). Validates the full effective before persisting.
router.put("/admin/facts/:id/enrichment-overrides", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const body = (req.body ?? {}) as { path?: unknown; value?: unknown; reason?: unknown; acknowledgeCurrentAiBaseline?: unknown };
  const path = String(body.path ?? "");
  if (!isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
  const acknowledge = body.acknowledgeCurrentAiBaseline === true;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; error?: string; body?: object; state?: OverrideLayers }> => {
      const state = await loadFactOverrideState(tx, id, true);
      if (!state) return { status: 404, error: "Fact not found" };
      // WRITE FREEZE: while a refresh candidate is in review, the live layers
      // are read-only (checked under the fact row lock, so it can't race the
      // send-back transaction). See findInFlightRefreshCandidate.
      const inFlight = await findInFlightRefreshCandidate(id, tx);
      if (inFlight) return { status: 409, body: refreshInReviewErrorBody(inFlight) };
      if (!state.aiDerived) return { status: 409, error: "Fact has no enrichment baseline yet — classify it first" };
      // Required Visual Concept (blocking) — same invariant as the whole-blob
      // PATCH: a fact can't be saved without one. This is a separate tracked-
      // field write path (PUT /enrichment-overrides), so it needs its own gate.
      if (!state.visualPromptStrategyOverride?.coreSceneOverride?.trim()) {
        return { status: 400, error: "visual_concept_required" };
      }
      const aiDerived = state.aiDerived;

      // Shared merge core: validation, reset-when-equal-AI, acknowledge
      // semantics, subtype auto-link, cross-field validation.
      const result = applyOverrideUpsert({
        layers: { ...state, aiDerived },
        path,
        value: body.value,
        ...(reason !== undefined ? { reason } : {}),
        acknowledge,
        adminId,
      });
      if (!result.ok) return { status: result.status, error: result.error };

      const { columns } = materializeEnrichment({ aiDerived, overrides: result.overrides, visualPromptStrategyOverride: state.visualPromptStrategyOverride });
      await tx.update(factsTable).set({ ...columns, enrichmentStatus: "ok" }).where(eq(factsTable.id, id));
      // Fact edits are the audited surface — map the change list to history rows.
      await recordOverrideHistory(
        result.changes.map((c): InsertEnrichmentOverrideHistory => ({
          factId: id, path: c.path, action: c.action, oldValue: c.oldValue, newValue: c.newValue,
          aiGenerationId: c.aiGenerationId, reason: c.reason, performedBy: adminId,
        })),
        tx,
      );
      return { status: 200, state: { ...state, overrides: result.overrides } };
    });

    if (out.status !== 200 || !out.state) { res.status(out.status).json(out.body ?? { error: out.error ?? "Error" }); return; }
    res.json({ success: true, ...serializeResolved({ ...out.state, enrichmentStatus: "ok" }) });
  } catch (e) {
    logger.error({ err: e, factId: id, path }, "[PUT /admin/facts/:id/enrichment-overrides] failed");
    res.status(500).json({ error: "Failed to save override" });
  }
});

// DELETE /admin/facts/:id/enrichment-overrides[?path=…] — reset one override (or
// ALL of them when no `path` is given) back to the AI baseline.
router.delete("/admin/facts/:id/enrichment-overrides", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const rawPath = req.query["path"];
  const path = rawPath !== undefined ? String(rawPath) : null;
  if (path !== null && !isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; error?: string; body?: object; state?: OverrideLayers }> => {
      const state = await loadFactOverrideState(tx, id, true);
      if (!state) return { status: 404, error: "Fact not found" };
      // WRITE FREEZE while a refresh candidate is in review (see the PUT handler).
      const inFlight = await findInFlightRefreshCandidate(id, tx);
      if (inFlight) return { status: 409, body: refreshInReviewErrorBody(inFlight) };
      if (!state.aiDerived) return { status: 409, error: "Fact has no enrichment baseline yet" };
      // Required Visual Concept (blocking) — same invariant as the PUT handler
      // above; a reset is still a save and must not bypass the gate.
      if (!state.visualPromptStrategyOverride?.coreSceneOverride?.trim()) {
        return { status: 400, error: "visual_concept_required" };
      }
      const aiDerived = state.aiDerived;

      const result = applyOverrideReset({ layers: { ...state, aiDerived }, path: path as OverridablePath | null });

      const { columns } = materializeEnrichment({ aiDerived, overrides: result.overrides, visualPromptStrategyOverride: state.visualPromptStrategyOverride });
      await tx.update(factsTable).set({ ...columns, enrichmentStatus: "ok" }).where(eq(factsTable.id, id));
      await recordOverrideHistory(
        result.changes.map((c): InsertEnrichmentOverrideHistory => ({
          factId: id, path: c.path, action: c.action, oldValue: c.oldValue, newValue: c.newValue,
          aiGenerationId: c.aiGenerationId, reason: c.reason, performedBy: adminId,
        })),
        tx,
      );
      return { status: 200, state: { ...state, overrides: result.overrides } };
    });

    if (out.status !== 200 || !out.state) { res.status(out.status).json(out.body ?? { error: out.error ?? "Error" }); return; }
    res.json({ success: true, ...serializeResolved({ ...out.state, enrichmentStatus: "ok" }) });
  } catch (e) {
    logger.error({ err: e, factId: id, path }, "[DELETE /admin/facts/:id/enrichment-overrides] failed");
    res.status(500).json({ error: "Failed to reset override" });
  }
});

// GET /admin/facts/:id/enrichment-overrides/history — the audit trail.
router.get("/admin/facts/:id/enrichment-overrides/history", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const history = await db
    .select()
    .from(enrichmentOverrideHistoryTable)
    .where(eq(enrichmentOverrideHistoryTable.factId, id))
    .orderBy(desc(enrichmentOverrideHistoryTable.createdAt))
    .limit(200);
  res.json({ history });
});

// PATCH /admin/facts/:id/enrichment — persist admin edits to the NON-tracked
// enrichment fields only (the moderator visual-strategy override + suggested
// hashtags). Tracked taxonomy/notes paths are owned by the override endpoints
// (PUT/DELETE /enrichment-overrides); a PATCH that tries to CHANGE any tracked
// field is rejected with 400 so stale clients can't overwrite them in place.
router.patch("/admin/facts/:id/enrichment", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const result = validateEnrichment((req.body as { enrichment?: unknown } | null | undefined)?.enrichment);
  if (!result.ok) { res.status(400).json({ error: `Invalid enrichment: ${result.error}` }); return; }
  const submitted = result.data;

  // §10 rendered-text budget: reject a NEW save whose moderator Concept +
  // additions would (worst-case, once names/pronouns are filled in) overflow the
  // engine prompt budget — before it can silently drop policy guardrails at
  // compile. Legacy stored content stays readable; this gates saves only.
  const submittedVso = (submitted as { visualPromptStrategyOverride?: VisualPromptStrategyOverride }).visualPromptStrategyOverride;
  if (submittedVso) {
    // Presence-based (the enable toggle was retired): validate whenever a VSO is
    // submitted. Additions + bubbles are measured through the REAL compiler (wrapping
    // included), not a raw field sum, so a save the gate accepts can't overflow
    // at render. One shared preflight with the review-candidate PATCH and
    // candidate-concept pickability.
    const budget = validateVisualStrategyOverridePersistence(submittedVso);
    if (!budget.ok) {
      res.status(400).json({ error: "visual_strategy_override_over_budget", details: budget.errors });
      return;
    }
  }

  const state = await loadFactOverrideState(db, id);
  if (!state) { res.status(404).json({ error: "Fact not found" }); return; }

  // WRITE FREEZE while a refresh candidate is in review (see the PUT handler).
  const inFlightPatch = await findInFlightRefreshCandidate(id);
  if (inFlightPatch) { res.status(409).json(refreshInReviewErrorBody(inFlightPatch)); return; }

  // Reject any attempt to change a tracked field through PATCH.
  if (state.effective) {
    const changed = OVERRIDABLE_PATH_KEYS.filter((p) => {
      const field = pathToField(p);
      return !overrideValuesEqual(
        (submitted as Record<string, unknown>)[field],
        (state.effective as unknown as Record<string, unknown>)[field],
      );
    });
    if (changed.length > 0) {
      res.status(400).json({
        error: `Tracked field(s) ${changed.map((p) => OVERRIDABLE_PATHS[p].label).join(", ")} must be changed via the override endpoints (PUT/DELETE /admin/facts/${id}/enrichment-overrides), not PATCH`,
        trackedPaths: changed,
      });
      return;
    }
  }

  // Required Visual Concept (blocking): a valid admin-authored enrichment save must carry
  // a non-empty Visual Concept — including when the override is absent entirely. A fact
  // cannot reach production without a scene for the image/video engines; this is the
  // admin-save half of that gate (approval gates are enforced separately). Placed after the
  // structural checks (404 / write-freeze / tracked-field) so it never shadows them, and
  // after — automated enrichment jobs write through the worker, not this admin route.
  if (!submittedVso?.coreSceneOverride?.trim()) {
    res.status(400).json({ error: "visual_concept_required" });
    return;
  }

  // Apply only the non-tracked edits. suggestedHashtags is an AI field edited in
  // place on the baseline (not tracked); the visual override is the separate
  // additive layer with server-owned provenance.
  const baseline = state.aiDerived ?? stripVisualOverride(submitted);
  if (!baseline) { res.status(409).json({ error: "Fact has no enrichment baseline yet" }); return; }
  const newAiDerived = { ...baseline, suggestedHashtags: submitted.suggestedHashtags } as FactEnrichment;

  const actor = (req as AuthenticatedRequest).user;
  const actorLabel = actor?.displayName ?? actor?.email ?? null;
  const stamped = stampOverrideProvenance(
    { ...newAiDerived, visualPromptStrategyOverride: submitted.visualPromptStrategyOverride } as FactEnrichment,
    state.effective ?? null,
    actorLabel,
  );
  const visualPromptStrategyOverride = (stamped as { visualPromptStrategyOverride?: VisualOverride }).visualPromptStrategyOverride;

  const { columns } = materializeEnrichment({ aiDerived: newAiDerived, overrides: state.overrides, visualPromptStrategyOverride });
  const [updated] = await db
    .update(factsTable)
    .set({ ...columns, enrichmentStatus: "ok" })
    .where(eq(factsTable.id, id))
    .returning({ id: factsTable.id });
  if (!updated) { res.status(404).json({ error: "Fact not found" }); return; }

  res.json({
    success: true,
    enrichment: columns.enrichment,
    projection: {
      primaryArchetype: columns.primaryArchetype,
      subtype: columns.subtype,
      overhypeFit: columns.overhypeFit,
      adultSuitability: columns.adultSuitability,
    },
  });
});

// POST /admin/facts/:id/enrich — re-run classification on a live fact. Marks
// enrichmentStatus "pending" and enqueues the (generalized) enrichment job for
// the fact target. The destructive "this overwrites admin-tuned metadata"
// confirmation is enforced client-side; this endpoint just enqueues.
router.post("/admin/facts/:id/enrich", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  // WRITE FREEZE while a refresh candidate is in review: a direct re-enrich
  // rewrites facts.* out from under the cycle the moderator is judging.
  const inFlight = await findInFlightRefreshCandidate(id);
  if (inFlight) { res.status(409).json(refreshInReviewErrorBody(inFlight)); return; }

  await db.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, id));
  await enqueueJob({
    queue: "enrichment",
    payload: { factId: id },
    dedupeKey: `enrichment:fact:${id}`,
  });

  res.json({ success: true, enrichmentStatus: "pending" });
});

// POST /admin/facts/:id/send-back-to-review — start a versioned-enrichment
// REFRESH cycle for a live fact (stale-fact refresh). Thin wrapper over the
// shared primitive; the fact stays live throughout, the candidate is
// classified by the async job, and the cycle lands in the moderation queue at
// Step 2. `clearOverrides` wipes the CANDIDATE's seeded manual-edit layers
// only (the fact's own layers are never touched here).
router.post("/admin/facts/:id/send-back-to-review", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const clearOverrides = (req.body as { clearOverrides?: unknown } | null | undefined)?.clearOverrides === true;
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const result = await sendFactBackToReview({ factId: id, clearOverrides, adminId });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof SendBackToReviewError) {
      if (err.code === "FACT_NOT_FOUND") { res.status(404).json({ error: err.message }); return; }
      // NOT_ACTIVE / REFRESH_ALREADY_IN_PROGRESS — the in-progress case names
      // the in-flight cycle so the UI can link to it.
      res.status(409).json({
        error: err.message,
        code: err.code,
        ...(err.existing ? { reviewId: err.existing.reviewId, candidateVersionId: err.existing.candidateVersionId } : {}),
      });
      return;
    }
    logger.error({ err, factId: id }, "[POST /admin/facts/:id/send-back-to-review] failed");
    res.status(500).json({ error: "Failed to send fact back to review" });
  }
});

// POST /admin/facts/:id/resubmit-for-moderation — re-enter an INACTIVE fact
// into moderation (the opposite case from send-back-to-review, which requires
// the fact to already be active). Reuses the existing factId/history; no
// duplicate fact is created. See resubmitForModeration.ts for why this exists.
router.post("/admin/facts/:id/resubmit-for-moderation", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const result = await resubmitInactiveFactForModeration({ factId: id, adminId });
    res.json({ success: true, workflowStage: "prep_pending", ...result });
  } catch (err) {
    if (err instanceof ResubmitForModerationError) {
      if (err.code === "FACT_NOT_FOUND") { res.status(404).json({ error: err.message }); return; }
      // ALREADY_ACTIVE / REVIEW_ALREADY_IN_PROGRESS / ORPHANED_PARENT — the
      // in-progress case names the in-flight review so the UI can link to it.
      res.status(409).json({
        error: err.message,
        code: err.code,
        ...(err.existing ? { reviewId: err.existing.reviewId } : {}),
      });
      return;
    }
    logger.error({ err, factId: id }, "[POST /admin/facts/:id/resubmit-for-moderation] failed");
    res.status(500).json({ error: "Failed to resubmit fact for moderation" });
  }
});

// GET /admin/facts/:id/enrichment-versions — the fact's versioned-enrichment
// history, METADATA ONLY (no jsonb blobs — the panel is for visibility, not
// rollback). "current" is derived from facts.* (the sole active truth — the
// version table never holds an active row); "inFlight" is the refresh cycle in
// review, if any, and doubles as the Facts page's freeze/disable signal.
router.get("/admin/facts/:id/enrichment-versions", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db
    .select({
      enrichment: factsTable.enrichment,
      enrichmentStatus: factsTable.enrichmentStatus,
      enrichmentOverrides: factsTable.enrichmentOverrides,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const createdByUsers = alias(usersTable, "created_by_users");
  const rows = await db
    .select({
      id: factEnrichmentVersionsTable.id,
      versionNo: factEnrichmentVersionsTable.versionNo,
      status: factEnrichmentVersionsTable.status,
      source: factEnrichmentVersionsTable.source,
      sourceReviewId: factEnrichmentVersionsTable.sourceReviewId,
      note: factEnrichmentVersionsTable.note,
      createdByDisplayName: createdByUsers.displayName,
      createdByEmail: createdByUsers.email,
      createdAt: factEnrichmentVersionsTable.createdAt,
      promotedAt: factEnrichmentVersionsTable.promotedAt,
      supersededAt: factEnrichmentVersionsTable.supersededAt,
      rejectedAt: factEnrichmentVersionsTable.rejectedAt,
      enrichmentReady: sql<boolean>`(${factEnrichmentVersionsTable.enrichment} IS NOT NULL)`,
    })
    .from(factEnrichmentVersionsTable)
    .leftJoin(createdByUsers, eq(factEnrichmentVersionsTable.createdBy, createdByUsers.id))
    .where(eq(factEnrichmentVersionsTable.factId, id))
    .orderBy(desc(factEnrichmentVersionsTable.createdAt));

  const candidate = rows.find((r) => r.status === "candidate");
  res.json({
    current: {
      hasEnrichment: fact.enrichment != null,
      enrichmentStatus: fact.enrichmentStatus ?? null,
      hasOverrides: Object.keys((fact.enrichmentOverrides ?? {}) as Record<string, unknown>).length > 0,
    },
    inFlight: candidate ? { candidateVersionId: candidate.id, reviewId: candidate.sourceReviewId } : null,
    versions: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      promotedAt: r.promotedAt?.toISOString() ?? null,
      supersededAt: r.supersededAt?.toISOString() ?? null,
      rejectedAt: r.rejectedAt?.toISOString() ?? null,
    })),
  });
});

// POST /admin/facts/:id/variants — create a variant linked to a root fact
router.post("/admin/facts/:id/variants", requireAdmin, async (req: Request, res: Response) => {
  const rootId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(rootId)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [root] = await db.select({ id: factsTable.id, parentId: factsTable.parentId }).from(factsTable).where(and(eq(factsTable.id, rootId), eq(factsTable.isActive, true))).limit(1);
  if (!root) { res.status(404).json({ error: "Fact not found" }); return; }
  if (root.parentId !== null) { res.status(400).json({ error: "Cannot add a variant to a variant. Target the root fact." }); return; }
  const { text } = req.body as Record<string, unknown>;
  if (!text || typeof text !== "string" || text.trim().length === 0) { res.status(400).json({ error: "text is required" }); return; }
  // A variant is a normal fact that happens to have a parent (Phase 2
  // fact-lifecycle closure): it enters moderation at Stage 1 like any other
  // submission, carrying its parent linkage on the review. It earns its own
  // triage/enrichment/concept and only becomes an active variant on production
  // approval (where activateFact revalidates the parent as an active root).
  const normalized = normalizeFactTemplateForPendingReview(text.trim());
  if (!normalized.valid) {
    res.status(422).json({
      error: `Template grammar validation failed: ${normalized.grammarResult.error}`,
    });
    return;
  }
  const review = await createTriageReview(db, {
    submittedText: normalized.text,
    submittedById: (req as AuthenticatedRequest).user!.id,
    hashtags: [],
    parentFactId: rootId,
  });
  res.status(201).json({ success: true, queued: true, reviewId: review.id });
});

// DELETE /admin/facts/variants/:variantId — soft-delete a single variant
router.delete("/admin/facts/variants/:variantId", requireAdmin, async (req: Request, res: Response) => {
  const variantId = parseInt(String(req.params["variantId"] ?? ""), 10);
  if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variant id" }); return; }
  const [v] = await db.select({ id: factsTable.id, parentId: factsTable.parentId, isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, variantId)).limit(1);
  if (!v || !v.isActive) { res.status(404).json({ error: "Variant not found" }); return; }
  if (v.parentId === null) { res.status(400).json({ error: "Cannot delete a root fact via this endpoint." }); return; }
  await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, variantId));
  res.json({ success: true });
});

// Bound the batch so a single call can't insert an unbounded number of rows
// (or hold a huge payload in memory). 1000 rows / 2000 chars each is generous
// for a bulk import; split larger imports across calls.
export const FactsImportBody = z.object({
  facts: z.array(z.union([
    z.string().max(2000),
    z.object({ text: z.string().max(2000) }).passthrough(),
  ])).min(1).max(1000),
});

/**
 * Shared bulk-ingestion funnel (Phase 2 fact-lifecycle closure) for the two
 * session-admin import endpoints. Dedups each text against existing facts AND
 * unresolved reviews, then creates a Stage-1 triage review per new text
 * (submittedById = the acting admin). Bulk import LOADS the moderation queue — it
 * does NOT publish — so nothing here inserts an active fact; enrichment/hashtags/
 * embeddings are deferred to the pipeline. Returns queued/skipped counts.
 */
async function queueTextsForTriage(
  submittedById: string | null,
  texts: string[],
): Promise<{ queued: number; skipped: number }> {
  if (texts.length === 0) return { queued: 0, skipped: 0 };
  const [factRows, reviewRows] = await Promise.all([
    db.select({ text: factsTable.text }).from(factsTable).where(inArray(factsTable.text, texts)),
    db
      .select({ text: pendingReviewsTable.submittedText })
      .from(pendingReviewsTable)
      .where(
        and(
          inArray(pendingReviewsTable.submittedText, texts),
          inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
        ),
      ),
  ]);
  const seen = new Set<string>([...factRows.map((r) => r.text), ...reviewRows.map((r) => r.text)]);
  let queued = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const text of texts) {
      if (seen.has(text)) { skipped++; continue; }
      seen.add(text);
      await createTriageReview(tx, { submittedText: text, submittedById, hashtags: [] });
      queued++;
    }
  });
  return { queued, skipped };
}

router.post("/admin/facts/import", requireAdmin, async (req: Request, res: Response) => {
  const parsed = FactsImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { facts } = parsed.data;

  const texts: string[] = [];
  for (const item of facts) {
    if (typeof item === "string" && item.trim().length > 0) {
      texts.push(item.trim());
    } else if (typeof item === "object" && item !== null && "text" in item && typeof (item as Record<string, unknown>).text === "string") {
      const t = ((item as Record<string, unknown>).text as string).trim();
      if (t.length > 0) texts.push(t);
    }
  }

  if (texts.length === 0) {
    res.status(400).json({ error: "No valid fact texts found in import" });
    return;
  }

  // Normalize + validate each row through the SAME normalizer user submissions
  // use, then QUEUE valid rows for moderation (Stage-1 triage reviews) rather
  // than inserting active facts. Partial success: invalid rows are reported in
  // `failed` and skipped; valid rows are queued.
  const validTexts: string[] = [];
  const failed: { index: number; text: string; error: string }[] = [];
  texts.forEach((text, index) => {
    const normalized = normalizeFactTemplateForPendingReview(text);
    if (!normalized.valid) {
      failed.push({ index, text, error: `Template grammar validation failed: ${normalized.grammarResult.error}` });
      return;
    }
    validTexts.push(normalized.text);
  });

  const { queued, skipped } = await queueTextsForTriage((req as AuthenticatedRequest).user!.id, validTexts);

  res.json({ success: true, queued, skipped, failed });
});

// Cap the raw CSV size (≤2 MB) so an unbounded string can't exhaust memory.
export const ImportCsvBody = z.object({ csv: z.string().min(1).max(2_000_000) });
const IMPORT_CSV_MAX_ROWS = 2000;

router.post("/admin/facts/import-csv", requireAdmin, async (req: Request, res: Response) => {
  const parsed = ImportCsvBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { csv } = parsed.data;

  const lines = csv.split("\n")
    .map((l) => l.replace(/^["']|["']$/g, "").trim())
    .filter((l) => l.length > 5);

  if (lines.length === 0) {
    res.status(400).json({ error: "No valid lines found in CSV" });
    return;
  }
  // Reject (don't silently truncate) an over-large batch so the caller knows to split.
  if (lines.length > IMPORT_CSV_MAX_ROWS) {
    res.status(400).json({ error: `Too many rows (${lines.length}); import at most ${IMPORT_CSV_MAX_ROWS} per call` });
    return;
  }

  // Normalize + validate each row, then QUEUE valid rows for moderation (Stage-1
  // triage reviews) rather than inserting active facts. Partial success: invalid
  // rows are reported in `failed` and skipped; valid rows are queued.
  const validTexts: string[] = [];
  const failed: { index: number; text: string; error: string }[] = [];
  lines.forEach((text, index) => {
    const normalized = normalizeFactTemplateForPendingReview(text);
    if (!normalized.valid) {
      failed.push({ index, text, error: `Template grammar validation failed: ${normalized.grammarResult.error}` });
      return;
    }
    validTexts.push(normalized.text);
  });

  const { queued, skipped } = await queueTextsForTriage((req as AuthenticatedRequest).user!.id, validTexts);

  res.json({ success: true, queued, skipped, failed });
});

// GET /admin/comments/pending — comments awaiting first moderation
router.get("/admin/comments/pending", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: commentsTable.id,
      factId: commentsTable.factId,
      text: commentsTable.text,
      authorId: commentsTable.authorId,
      createdAt: commentsTable.createdAt,
    })
    .from(commentsTable)
    .where(eq(commentsTable.status, "pending"))
    .orderBy(desc(commentsTable.createdAt))
    .limit(100);

  const authorIds = [...new Set(rows.filter((r) => r.authorId).map((r) => r.authorId!))];
  const authorMap = new Map<string, { displayName: string | null; email: string | null }>();
  if (authorIds.length) {
    const users = await db
      .select({ id: usersTable.id, displayName: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
    for (const u of users) authorMap.set(u.id, u);
  }

  res.json({
    comments: rows.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      authorDisplayName: c.authorId ? (authorMap.get(c.authorId)?.displayName ?? null) : null,
      authorEmail: c.authorId ? (authorMap.get(c.authorId)?.email ?? null) : null,
    })),
    total: rows.length,
  });
});

// GET /admin/comments/pending/count — badge count for nav
router.get("/admin/comments/pending/count", requireAdmin, async (_req: Request, res: Response) => {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(commentsTable)
    .where(eq(commentsTable.status, "pending"));
  res.json({ total });
});

// GET /admin/comments/flagged — approved comments that were later AI-flagged
router.get("/admin/comments/flagged", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: commentsTable.id,
      factId: commentsTable.factId,
      text: commentsTable.text,
      authorId: commentsTable.authorId,
      flagReason: commentsTable.flagReason,
      createdAt: commentsTable.createdAt,
    })
    .from(commentsTable)
    .where(and(eq(commentsTable.status, "approved"), eq(commentsTable.flagged, true)))
    .orderBy(desc(commentsTable.createdAt))
    .limit(100);

  const authorIds = [...new Set(rows.filter((r) => r.authorId).map((r) => r.authorId!))];
  const authorMap = new Map<string, { displayName: string | null; email: string | null }>();
  if (authorIds.length) {
    const users = await db
      .select({ id: usersTable.id, displayName: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
    for (const u of users) authorMap.set(u.id, u);
  }

  res.json({
    comments: rows.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      authorDisplayName: c.authorId ? (authorMap.get(c.authorId)?.displayName ?? null) : null,
      authorEmail: c.authorId ? (authorMap.get(c.authorId)?.email ?? null) : null,
    })),
  });
});

// POST /admin/comments/:id/approve — approve a pending or flagged comment
router.post("/admin/comments/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [current] = await db
    .select({ factId: commentsTable.factId, status: commentsTable.status, authorId: commentsTable.authorId })
    .from(commentsTable)
    .where(eq(commentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Comment not found" }); return; }
  await db.update(commentsTable).set({ status: "approved", flagged: false, flagReason: null }).where(eq(commentsTable.id, id));
  if (current.status === "pending") {
    await db
      .update(factsTable)
      .set({ commentCount: sql`${factsTable.commentCount} + 1` })
      .where(eq(factsTable.id, current.factId));
  }
  if (current.authorId) {
    void logActivity({
      userId: current.authorId,
      actionType: "comment_approved",
      message: "Your comment was approved and is now visible publicly.",
      metadata: { commentId: id, factId: current.factId },
    });
  }
  res.json({ success: true });
});

// POST /admin/comments/:id/reject — reject a pending or flagged comment (soft delete, sets status)
router.post("/admin/comments/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = req.body as Record<string, unknown>;
  const note = body["note"] && typeof body["note"] === "string" ? body["note"].trim() : null;
  const [current] = await db
    .select({ factId: commentsTable.factId, status: commentsTable.status, authorId: commentsTable.authorId })
    .from(commentsTable)
    .where(eq(commentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Comment not found" }); return; }
  await db.update(commentsTable).set({ status: "rejected", flagged: true, flagReason: note || null }).where(eq(commentsTable.id, id));
  if (current.status === "approved") {
    await db
      .update(factsTable)
      .set({ commentCount: sql`GREATEST(0, ${factsTable.commentCount} - 1)` })
      .where(eq(factsTable.id, current.factId));
  }
  if (current.authorId) {
    const message = note
      ? `Your comment was rejected. Reason: ${note}`
      : "Your comment was rejected by a moderator.";
    void logActivity({
      userId: current.authorId,
      actionType: "comment_rejected",
      message,
      metadata: { commentId: id, factId: current.factId, ...(note ? { note } : {}) },
    });
  }
  res.json({ success: true });
});

// DELETE /admin/comments/:id — permanently delete any non-approved comment
router.delete("/admin/comments/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db
    .delete(commentsTable)
    .where(eq(commentsTable.id, id))
    .returning({ factId: commentsTable.factId });
  if (!deleted) { res.status(404).json({ error: "Comment not found" }); return; }
  res.json({ success: true });
});

// POST /admin/users/:id/verify-email — manually mark a user's email as verified
router.post("/admin/users/:id/verify-email", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const [updated] = await db
    .update(usersTable)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(usersTable.id, id), eq(usersTable.isActive, true)))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }

  res.json({ success: true, user: updated });
});

// GET /api/admin/users/:id/spend — monthly spend history for any user (computed at request time)
router.get("/admin/users/:id/spend", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const rows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      month: sql<number>`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      totalUsd: sql<string>`COALESCE(SUM(${userGenerationCostsTable.computedCostUsd}), 0)::text`,
    })
    .from(userGenerationCostsTable)
    .where(eq(userGenerationCostsTable.userId, id))
    .groupBy(
      sql`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`,
      sql`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`,
    )
    .orderBy(
      desc(sql`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`),
      desc(sql`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`),
    );

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const history = rows.map((r) => ({
    year: r.year,
    month: r.month,
    totalUsd: parseFloat(r.totalUsd),
    isCurrent: r.year === currentYear && r.month === currentMonth,
  }));

  const lifetimeTotal = rows.reduce((sum, r) => sum + parseFloat(r.totalUsd), 0);

  const current = history.find((h) => h.isCurrent) ?? {
    year: currentYear,
    month: currentMonth,
    totalUsd: 0,
    isCurrent: true,
  };

  res.json({ current, history, lifetimeTotal });
});

// POST /admin/facts/backfill-embeddings
// One-shot endpoint to generate pgvector embeddings for all facts that don't have one yet.
// Accepts either an authenticated admin session OR the ADMIN_API_KEY header.
export async function requireAdminOrApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers["x-api-key"];
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (adminApiKey && apiKey === adminApiKey) {
    next();
    return;
  }
  return requireAdmin(req, res, next) as unknown as void;
}

// POST /admin/users/set-password — reset a user's password by email (API key auth)
router.post("/admin/users/set-password", requireAdminOrApiKey, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== "string") { res.status(400).json({ error: "email is required" }); return; }
  const normalizedEmail = email.trim().toLowerCase();
  // Reachable with only the static ADMIN_API_KEY (no admin session), so require
  // a well-formed, length-bounded email in addition to the password rules.
  if (!z.string().email().max(320).safeParse(normalizedEmail).success) {
    res.status(400).json({ error: "a valid email is required" });
    return;
  }
  if (!password || typeof password !== "string") { res.status(400).json({ error: "password is required" }); return; }
  // Keep these explicit, message-specific checks (the C7 regression asserts the
  // "at least 8" wording) rather than folding them into a generic zod 400.
  if (password.length < 8) { res.status(400).json({ error: "password must be at least 8 characters" }); return; }
  if (password.length > 128) { res.status(400).json({ error: "password must be at most 128 characters" }); return; }
  const [user] = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
  res.json({ success: true, email: user.email });
});

router.post("/admin/users/enable-notifications", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  const updated = await db
    .update(usersTable)
    .set({ adminNotifications: true })
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.isActive, true)))
    .returning({ id: usersTable.id, email: usersTable.email, adminNotifications: usersTable.adminNotifications });
  res.json({ success: true, updated });
});

// POST /admin/facts/:id/refresh-images — manually re-run the image pipeline for one fact
// Query param: ?force=true to overwrite existing images (default: skip if already has images)
router.post("/admin/facts/:id/refresh-images", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const force = req.query["force"] === "true";
  const [fact] = await db.select({ id: factsTable.id, text: factsTable.text, pexelsImages: factsTable.pexelsImages })
    .from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (!force && fact.pexelsImages !== null) {
    res.json({ success: true, skipped: true, message: "Fact already has images. Pass force=true to overwrite." });
    return;
  }
  void runFactImagePipeline(fact.id, fact.text);
  res.json({ success: true, skipped: false, message: "Image pipeline started. Results will appear shortly." });
});

interface BulkBackfillJob {
  factId: number;
  jobId: number;
  deduped: boolean;
  /** Bounded text preview for admin-UI display — never render factId raw. */
  label: string;
}
interface BulkBackfillSkip {
  factId: number;
  status: "skipped";
  reason: "not_active";
  label: string;
}
/** A per-fact enqueue call rejected — the job was never created for this fact. */
interface BulkBackfillEnqueueFailure {
  factId: number;
  status: "failed";
  error: string;
  label: string;
}
type BulkBackfillOutcome = BulkBackfillSkip | BulkBackfillEnqueueFailure;
interface BulkBackfillResponse {
  success: true;
  jobs: BulkBackfillJob[];
  outcomes: BulkBackfillOutcome[];
  summary: { requested: number; queued: number; skipped: number; failed: number };
}

const BULK_BACKFILL_LABEL_MAX = 60;

/**
 * Shared enqueue loop for the three bulk-backfill routes: check `isActive`
 * per fact (route-level skip, no enqueue at all — the selection query itself
 * still has no `isActive` predicate, a pre-existing, out-of-scope gap this
 * doesn't widen), then enqueue through the given per-fact enqueuer. Returns
 * the queued job descriptors + skip/failure outcomes for the frontend to poll
 * via the existing `/admin/taxonomy-health/job-status` endpoint
 * (queue-agnostic). A single fact's enqueue rejecting is caught and recorded
 * as a failure outcome rather than aborting the request — earlier facts in
 * the same loop already committed durable (potentially paid) jobs, and those
 * descriptors must still reach the caller (Codex review, PR #256).
 */
export async function enqueueBulkBackfill(
  facts: { id: number; text: string; isActive: boolean }[],
  enqueue: (factId: number) => Promise<{ jobId: number; inserted: boolean }>,
): Promise<BulkBackfillResponse> {
  const jobs: BulkBackfillJob[] = [];
  const outcomes: BulkBackfillOutcome[] = [];
  for (const fact of facts) {
    const label = fact.text.slice(0, BULK_BACKFILL_LABEL_MAX);
    if (!fact.isActive) {
      outcomes.push({ factId: fact.id, status: "skipped", reason: "not_active", label });
      continue;
    }
    try {
      const result = await enqueue(fact.id);
      jobs.push({ factId: fact.id, jobId: result.jobId, deduped: !result.inserted, label });
    } catch (err) {
      logger.error({ err, factId: fact.id }, "[admin] bulk-backfill enqueue failed for fact");
      outcomes.push({ factId: fact.id, status: "failed", error: "Could not queue the job.", label });
    }
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  return {
    success: true,
    jobs,
    outcomes,
    summary: { requested: facts.length, queued: jobs.length, skipped: outcomes.length - failed, failed },
  };
}

// POST /admin/facts/backfill-images — enqueue durable Pexels image prep
// (FACT_PEXELS_QUEUE) for every active fact (root or variant) missing images.
router.post("/admin/facts/backfill-images", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const facts = await db.select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive })
      .from(factsTable).where(isNull(factsTable.pexelsImages));
    const response = await enqueueBulkBackfill(facts, (factId) => enqueueFactPexels(factId, { bulkBackfill: true }));
    res.status(202).json(response);
  } catch (err) {
    logger.error({ err }, "[admin] Backfill images error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// POST /admin/backfill-pexels — enqueue durable Pexels image prep for every
// active fact (root or variant) that currently has NULL pexelsImages.
// Idempotent: skips facts that already have images.
router.post("/admin/backfill-pexels", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const facts = await db
      .select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive })
      .from(factsTable)
      .where(isNull(factsTable.pexelsImages));
    const response = await enqueueBulkBackfill(facts, (factId) => enqueueFactPexels(factId, { bulkBackfill: true }));
    res.status(202).json(response);
  } catch (err) {
    logger.error({ err }, "[admin] backfill-pexels error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// POST /admin/facts/backfill-ai-memes — enqueue durable AI-meme generation
// (fact_ai_meme_backfill queue) for every active fact (root or variant)
// missing AI-meme images (or every active fact with ?force=true).
router.post("/admin/facts/backfill-ai-memes", requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const force = String((req.query as Record<string, unknown>)["force"] ?? "") === "true";

    const facts = force
      ? await db.select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive }).from(factsTable)
      : await db
          .select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive })
          .from(factsTable)
          .where(isNull(factsTable.aiMemeImages));

    const response = await enqueueBulkBackfill(facts, (factId) => enqueueFactAiMemeBackfill(factId));
    res.status(202).json(response);
  } catch (err) {
    logger.error({ err }, "[admin] Backfill AI memes error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

router.post("/admin/facts/backfill-embeddings", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const result = await backfillEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "[admin] Backfill embeddings error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// Backfill visual-taxonomy enrichment onto existing facts (covers bulk-imported
// facts too). With ?force=true, re-enriches every active fact; otherwise only
// facts that have no enrichment yet. Runs sequentially in the background to
// respect OpenAI rate limits.
router.post("/admin/facts/backfill-enrichment", requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const force = String((req.query as Record<string, unknown>)["force"] ?? "") === "true";

    const rows = await db
      .select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment })
      .from(factsTable)
      .where(force
        ? eq(factsTable.isActive, true)
        : and(eq(factsTable.isActive, true), isNull(factsTable.enrichment)));

    const total = rows.length;
    res.json({ success: true, queued: total, message: `Enriching ${total} facts sequentially in the background.` });

    void (async () => {
      logger.info({ total, force }, "[admin] backfill-enrichment: starting");
      let done = 0;
      let failed = 0;
      for (const fact of rows) {
        try {
          const enrichment = await enrichFact({ factText: fact.text });
          // Preserve the moderator's Visual Concept (visualPromptStrategyOverride)
          // from the EXISTING row: fresh classifier output never carries a VSO, so
          // materializing from it alone would strip the human concept (breaking
          // render, and failing the active-requires-concept CHECK on active rows).
          // Re-apply the current row's VSO onto the fresh AI baseline via the
          // VSO-preserving materialize path — the preservation source is the
          // existing row, not the new baseline.
          const priorVSO = (fact.enrichment as FactEnrichment | null)?.visualPromptStrategyOverride;
          const aiDerived = { ...enrichment } as FactEnrichment;
          delete (aiDerived as Record<string, unknown>)["visualPromptStrategyOverride"];
          const { columns } = materializeEnrichment({ aiDerived, overrides: {}, visualPromptStrategyOverride: priorVSO });
          await db.update(factsTable).set(columns).where(eq(factsTable.id, fact.id));
          done++;
        } catch (err) {
          failed++;
          logger.warn({ err, factId: fact.id }, "[admin] backfill-enrichment: fact failed");
        }
      }
      logger.info({ total, done, failed }, "[admin] backfill-enrichment: done");
    })();
  } catch (err) {
    logger.error({ err }, "[admin] Backfill enrichment error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// ─── Config ───────────────────────────────────────────────────────────────────

router.get("/config/public", async (_req: Request, res: Response) => {
  try {
    const config = await getPublicConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: "Failed to load public config" });
  }
});

router.get("/admin/config", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await getAllConfig();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load config" });
  }
});

router.patch("/admin/config/:key", requireAdmin, async (req: Request, res: Response) => {
  const key = String(req.params["key"]);
  const body = req.body as {
    value?: unknown;
    valueLabel?: unknown;
    debugValue?: unknown;
    debugValueLabel?: unknown;
    clearDebugValue?: boolean;
  };

  // At least one of value or debugValue (or clearDebugValue) must be provided
  const hasValue = body.value !== undefined && body.value !== null && String(body.value).trim() !== "";
  const hasDebugValue = body.debugValue !== undefined;
  const clearDebug = body.clearDebugValue === true;

  if (!hasValue && !hasDebugValue && !clearDebug) {
    res.status(400).json({ error: "value, debugValue, or clearDebugValue is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, key))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Config key not found" });
    return;
  }

  let newValue: string | undefined;
  let newValueLabel: string | null | undefined;
  let newDebugValue: string | null | undefined;
  let newDebugValueLabel: string | null | undefined;

  if (hasValue) {
    const rawValue = String(body.value).trim();
    if (existing.dataType === "integer") {
      const parsed = parseInt(rawValue, 10);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Value must be an integer" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Value must be at most ${existing.maxValue}` });
        return;
      }
    } else if (existing.dataType === "float") {
      const parsed = parseFloat(rawValue);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Value must be a number" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Value must be at most ${existing.maxValue}` });
        return;
      }
    }
    // Some settings are only coherent against each other: the entitlement
    // lease must outlive the bounded Stripe retrieval plus the apply, the
    // reconciliation run lease must outlive three heartbeats, and the downgrade
    // allowance must not exceed the absolute cap. Every individual range can
    // pass while the SET is broken, and a relational invariant enforced on one
    // side only is not enforced — so this runs on a write to ANY component.
    if (isMembershipConfigKey(key)) {
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed)) {
        res.status(400).json({ error: "Value must be a number" });
        return;
      }
      const relationalError = validateMembershipConfigWrite(
        key,
        parsed,
        await loadMembershipConfig(),
      );
      if (relationalError) {
        res.status(400).json({ error: relationalError });
        return;
      }
    }

    newValue = rawValue;
    newValueLabel = body.valueLabel !== undefined && body.valueLabel !== null
      ? String(body.valueLabel).trim() || null
      : undefined;
  }

  if (hasDebugValue) {
    const rawDebug = body.debugValue === null || String(body.debugValue).trim() === ""
      ? null
      : String(body.debugValue).trim();
    if (rawDebug !== null && existing.dataType === "integer") {
      const parsed = parseInt(rawDebug, 10);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Debug value must be an integer" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Debug value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Debug value must be at most ${existing.maxValue}` });
        return;
      }
    } else if (rawDebug !== null && existing.dataType === "float") {
      const parsed = parseFloat(rawDebug);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Debug value must be a number" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Debug value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Debug value must be at most ${existing.maxValue}` });
        return;
      }
    }
    // Debug mode makes debugValue the EFFECTIVE value everywhere (see
    // adminConfig.ts's resolveValue) — so a debugValue write is just as capable
    // of breaking the lease/heartbeat/downgrade-allowance relationships as a
    // write to value, and skipping the check here left debug mode a backdoor
    // around it.
    if (rawDebug !== null && isMembershipConfigKey(key)) {
      const parsed = Number(rawDebug);
      if (Number.isNaN(parsed)) {
        res.status(400).json({ error: "Debug value must be a number" });
        return;
      }
      const relationalError = validateMembershipConfigWrite(
        key,
        parsed,
        await loadMembershipConfig(),
      );
      if (relationalError) {
        res.status(400).json({ error: `Debug value: ${relationalError}` });
        return;
      }
    }
    newDebugValue = rawDebug;
    newDebugValueLabel = body.debugValueLabel !== undefined && body.debugValueLabel !== null
      ? String(body.debugValueLabel).trim() || null
      : undefined;
  } else if (clearDebug) {
    newDebugValue = null;
    newDebugValueLabel = null;
  }

  const [updated] = await db
    .update(adminConfigTable)
    .set({
      ...(newValue !== undefined ? { value: newValue } : {}),
      ...(newValueLabel !== undefined ? { valueLabel: newValueLabel } : {}),
      ...(newDebugValue !== undefined ? { debugValue: newDebugValue } : {}),
      ...(newDebugValueLabel !== undefined ? { debugValueLabel: newDebugValueLabel } : {}),
      updatedAt: new Date(),
      updatedById: req.user?.id ?? null,
    })
    .where(eq(adminConfigTable.key, key))
    .returning();

  bustConfigCache();

  // When stripe_live_mode changes, invalidate the cached Stripe instance and
  // kick off a FULL resync so every mode-scoped resource (products, prices,
  // plans, customers, subscriptions, invoices, charges, payment methods) lands
  // for the new mode without waiting for webhook traffic. Shares the same
  // in-process lock as the manual scoped sync, so a concurrent admin click on
  // "Sync Stripe data" will see alreadyRunning and short-circuit with 409.
  if (key === "stripe_live_mode") {
    const { invalidateStripeSync, getStripeSync } = await import("../lib/stripeClient");
    const { runFullSync } = await import("../lib/stripeSyncRunner");
    invalidateStripeSync();
    try {
      const sync = await getStripeSync();
      runFullSync(sync);
    } catch (err) {
      logger.error({ err }, "[admin] Stripe full sync error after mode toggle");
    }
  }

  res.json(updated);
});

// ─── Fact-enrichment prompt provenance + reset ─────────────────────────────────

/**
 * Report the EFFECTIVE fact-enrichment system prompt's provenance (without the
 * prompt text): source, hash, code-default hash, and whether they match. Powers
 * the "reset to code default" confirmation so admins see current vs code-default
 * before replacing a stored/overridden prompt.
 */
router.get(
  "/admin/config/fact-enrichment-system/provenance",
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const r = await resolveFactEnrichmentSystemPrompt();
      res.json({
        source: r.source,
        hash: r.hash,
        length: r.length,
        codeDefaultHash: r.codeDefaultHash,
        matchesCodeDefault: r.matchesCodeDefault,
      });
    } catch (err) {
      logger.error({ err }, "[admin] failed to resolve fact-enrichment prompt provenance");
      res.status(500).json({ error: "Failed to resolve prompt provenance" });
    }
  },
);

/**
 * Reset the stored fact-enrichment system prompt to the current code default
 * and clear any debug override. Destructive (replaces admin-customized prompt),
 * so the UI gates this behind a confirmation showing current vs code-default
 * hashes.
 */
router.post(
  "/admin/config/fact-enrichment-system/reset-to-default",
  requireAdmin,
  async (req: Request, res: Response) => {
    const [updated] = await db
      .update(adminConfigTable)
      .set({
        value: FACT_ENRICHMENT_SYSTEM_DEFAULT,
        debugValue: null,
        debugValueLabel: null,
        updatedAt: new Date(),
        updatedById: req.user?.id ?? null,
      })
      .where(eq(adminConfigTable.key, FACT_ENRICHMENT_CONFIG_KEYS.system))
      .returning();

    bustConfigCache();

    if (!updated) {
      res.status(404).json({ error: "Config key not found" });
      return;
    }

    res.json({
      ok: true,
      key: FACT_ENRICHMENT_CONFIG_KEYS.system,
      hash: hashPromptText(FACT_ENRICHMENT_SYSTEM_DEFAULT),
      length: FACT_ENRICHMENT_SYSTEM_DEFAULT.length,
    });
  },
);

// ─── Video Styles ─────────────────────────────────────────────────────────────

router.get("/admin/video-styles", requireAdmin, async (_req: Request, res: Response) => {
  const styles = await db
    .select()
    .from(motionPresetsTable)
    .orderBy(asc(motionPresetsTable.sortOrder), asc(motionPresetsTable.id));
  res.json(styles);
});

router.post("/admin/video-styles", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const id = String(body.id ?? "").trim();
  if (!id) { res.status(400).json({ error: "id is required" }); return; }
  const label = String(body.label ?? "").trim();
  if (!label) { res.status(400).json({ error: "label is required" }); return; }

  const [created] = await db
    .insert(motionPresetsTable)
    .values({
      id,
      label,
      description: String(body.description ?? ""),
      motionPrompt: String(body.motionPrompt ?? ""),
      gradientFrom: String(body.gradientFrom ?? "#000000"),
      gradientTo: String(body.gradientTo ?? "#333333"),
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      isActive: body.isActive !== false,
    })
    .returning();
  res.status(201).json(created);
});

router.patch("/admin/video-styles/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  const body = req.body as Record<string, unknown>;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.label !== undefined)       updates.label        = String(body.label);
  if (body.description !== undefined) updates.description  = String(body.description);
  if (body.motionPrompt !== undefined) updates.motionPrompt = String(body.motionPrompt);
  if (body.gradientFrom !== undefined) updates.gradientFrom = String(body.gradientFrom);
  if (body.gradientTo !== undefined)   updates.gradientTo   = String(body.gradientTo);
  if (body.sortOrder !== undefined)    updates.sortOrder    = Number(body.sortOrder);
  if (body.isActive !== undefined)     updates.isActive     = Boolean(body.isActive);

  const [updated] = await db
    .update(motionPresetsTable)
    .set(updates)
    .where(eq(motionPresetsTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Style not found" }); return; }
  res.json(updated);
});

export const PreviewGifBody = z.object({ base64: z.string().trim().min(1).max(7_000_000) }); // ~5 MB decoded

// The `:id` is the motion-preset PK and gets interpolated into a storage object
// key, so it MUST NOT be able to escape the prefix (`id=../../x` → path
// traversal). Rather than REJECT non-slug ids — which would orphan a legacy
// style whose id isn't a strict slug (`My.Style`, `foo bar`), leaving it unable
// to ever receive a preview — derive a deterministic, traversal-safe key:
// unsafe chars are replaced and a short hash of the REAL id keeps distinct ids
// from colliding. The DB row is still matched on the real id and the resolved
// path is persisted, so retrieval/delete are unaffected.
export function safeStylePreviewKey(id: string): string {
  const slug = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "style";
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `video_style_previews/${slug}-${hash}.gif`;
}

router.post("/admin/video-styles/:id/preview-gif", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "style id required" }); return; }
  const bodyParsed = PreviewGifBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid input", details: bodyParsed.error.flatten() }); return; }
  const base64 = bodyParsed.data.base64;

  const buf = Buffer.from(base64, "base64");
  const subPath = safeStylePreviewKey(id);
  const storedPath = await _styleStorage.uploadObjectBuffer({
    subPath,
    buffer: buf,
    contentType: "image/gif",
  });

  try {
    await _styleStorage.trySetObjectEntityAclPolicy(storedPath, { owner: "system", visibility: "public" });
  } catch { /* non-fatal */ }

  const [updated] = await db
    .update(motionPresetsTable)
    .set({ previewGifPath: storedPath, updatedAt: new Date() })
    .where(eq(motionPresetsTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Style not found" }); return; }
  res.json(updated);
});

router.delete("/admin/video-styles/:id/preview-gif", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);

  const [style] = await db
    .select({ previewGifPath: motionPresetsTable.previewGifPath })
    .from(motionPresetsTable)
    .where(eq(motionPresetsTable.id, id))
    .limit(1);

  if (!style) { res.status(404).json({ error: "Style not found" }); return; }
  if (style.previewGifPath) {
    try {
      await _styleStorage.deleteObject(style.previewGifPath);
    } catch { /* non-fatal */ }
  }

  const [updated] = await db
    .update(motionPresetsTable)
    .set({ previewGifPath: null, updatedAt: new Date() })
    .where(eq(motionPresetsTable.id, id))
    .returning();

  res.json(updated);
});

// ─── Admin Stripe Endpoints ───────────────────────────────────────────────────

router.get("/admin/stripe/summary", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Active legendary subscribers = users with legendary tier and an active subscription
    // Registered members = users with registered tier (no payment)
    // ONE statement with conditional aggregation, not two in a Promise.all.
    // `now()` is the TRANSACTION timestamp, so two implicit transactions get two
    // different instants, and a user crossing their grace horizon between them
    // is counted twice or not at all. Sharing the expression makes the counts
    // agree on the RULE; only one statement makes them agree on the INSTANT.
    const [tierCounts] = await db
      .select({
        legendary: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'legendary')::int`,
        registered: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'registered')::int`,
      })
      .from(usersTable)
      .where(eq(usersTable.isActive, true));

    // Boolean-only presence checks for the Stripe env vars. We never echo the
    // values themselves — only whether each one is configured.
    const stripeEnv = {
      secretKeyTest: !!process.env.STRIPE_SECRET_KEY_TEST,
      secretKeyLive: !!process.env.STRIPE_SECRET_KEY_LIVE,
      publishableKeyTest: !!process.env.STRIPE_PUBLISHABLE_KEY_TEST,
      publishableKeyLive: !!process.env.STRIPE_PUBLISHABLE_KEY_LIVE,
      webhookSecretTest: !!process.env.STRIPE_WEBHOOK_SECRET_TEST,
      webhookSecretLive: !!process.env.STRIPE_WEBHOOK_SECRET_LIVE,
    };
    const webhookSecretConfigured =
      stripeEnv.webhookSecretTest || stripeEnv.webhookSecretLive;

    const webhookUrl = `${getSiteBaseUrl()}/api/stripe/webhook`;

    const [duplicateSuppressedRows, recentFailures] = await Promise.all([
      db.select({ cnt: sql<number>`count(*)::int` }).from(stripeWebhookAuditTable).where(eq(stripeWebhookAuditTable.state, "ignored_duplicate")),
      db.select().from(stripeWebhookAuditTable)
        .where(eq(stripeWebhookAuditTable.state, "failed"))
        .orderBy(desc(stripeWebhookAuditTable.createdAt))
        .limit(20),
    ]);

    res.json({
      activeSubscribers: tierCounts?.legendary ?? 0,
      registeredMembers: tierCounts?.registered ?? 0,
      webhookSecretConfigured,
      webhookUrl,
      stripeEnv,
      webhookAudit: {
        duplicateSuppressedCount: duplicateSuppressedRows[0]?.cnt ?? 0,
        recentFailures,
      },
    });
  } catch (err) {
    logger.error({ err }, "[admin] stripe/summary error");
    res.status(500).json({ error: "Failed to load stripe summary" });
  }
});

// POST /admin/stripe/full-sync — trigger a full backfill of every tracked
// resource (products, prices, plans, customers, subscriptions, invoices,
// charges, payment_methods). Shares the same in-process lock as the scoped
// sync — a concurrent scoped run returns 409 alreadyRunning.
//
// This is the same backfill that runs automatically after a live/test mode
// toggle, exposed here so admins can run it on demand without toggling modes.
router.post("/admin/stripe/full-sync", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { runFullSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const result = runFullSync(sync);
    if (result.alreadyRunning) {
      res.status(409).json({
        success: false,
        alreadyRunning: true,
        message: "Sync already in progress — current run will finish shortly.",
      });
      return;
    }
    res.json({
      success: true,
      message: "Full sync started — all resources will be refreshed.",
    });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/full-sync error");
    res.status(500).json({ error: "Failed to start full sync" });
  }
});

// POST /admin/stripe/sync — trigger a scoped resync of products/prices/plans.
//
// Scoped intentionally: customers/subscriptions/invoices/etc. are kept fresh
// by webhooks already, so the admin button only refreshes what it actually
// affects (the Plans block + checkout price IDs).
//
// Returns immediately after kicking off the background sync. The UI polls
// /admin/stripe/sync/status to render real-time progress per resource.
//
// If a sync is already running, this returns HTTP 409 + alreadyRunning:true
// rather than starting a duplicate concurrent sync.
router.post("/admin/stripe/sync", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { runScopedSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const result = runScopedSync(sync);
    if (result.alreadyRunning) {
      res.status(409).json({
        success: false,
        alreadyRunning: true,
        message: "Sync already in progress — current run will finish shortly.",
      });
      return;
    }
    res.json({
      success: true,
      message: "Stripe sync started — watch progress below.",
    });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/sync error");
    res.status(500).json({ error: "Failed to start sync" });
  }
});

// POST /admin/stripe/sync/_test/simulate — test-only hook used by the UI test
// for the per-resource progress panel. Drives the same `runScopedSync`
// machinery the real button uses, but with a stub driver that writes status
// rows directly so we can deterministically exercise success and failure paths
// without depending on what's in the test Stripe account at the moment.
//
// Disabled in production (returns 404) and gated behind requireAdmin like the
// real sync routes.
router.post("/admin/stripe/sync/_test/simulate", requireAdmin, async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  try {
    const body = (req.body ?? {}) as { failResource?: string; delayMs?: number };
    const failResource = body.failResource;
    const delayMs = typeof body.delayMs === "number" && body.delayMs >= 0 ? body.delayMs : 250;
    const allowed = ["products", "prices", "plans"] as const;
    type Res = (typeof allowed)[number];
    if (failResource !== undefined && !allowed.includes(failResource as Res)) {
      res.status(400).json({ error: "failResource must be one of products|prices|plans" });
      return;
    }

    const { getStripeSync } = await import("../lib/stripeClient");
    const { runScopedSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const accountId = await sync.getAccountId();

    const makeStub = (resource: Res, shouldFail: boolean) => async (): Promise<{ synced: number }> => {
      await db.execute(sql`
        INSERT INTO stripe._sync_status (resource, account_id, status)
        VALUES (${resource}, ${accountId}, 'running')
        ON CONFLICT (resource, account_id) DO UPDATE
          SET status = 'running', error_message = NULL, updated_at = now()
      `);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (shouldFail) {
        await db.execute(sql`
          UPDATE stripe._sync_status
          SET status = 'error', error_message = ${"Simulated failure for testing"}, updated_at = now()
          WHERE resource = ${resource} AND account_id = ${accountId}
        `);
        throw new Error("Simulated failure for testing");
      }
      await db.execute(sql`
        UPDATE stripe._sync_status
        SET status = 'complete', error_message = NULL, last_synced_at = now(), updated_at = now()
        WHERE resource = ${resource} AND account_id = ${accountId}
      `);
      return { synced: 0 };
    };

    // Reset existing _sync_status rows for these three resources so the UI
    // observes a true pending → running → complete transition. Without this,
    // a previous successful run leaves rows as "complete" and the UI would
    // show "N synced · X ago" for resources that haven't started yet in the
    // simulated run, defeating intermediate-state assertions.
    await db.execute(sql`
      DELETE FROM stripe._sync_status
      WHERE account_id = ${accountId}
        AND resource IN ('products', 'prices', 'plans')
    `);

    // SyncRunnerDriver requires every resource method, but `runScopedSync`
    // only invokes products/prices/plans. The customer-graph methods are
    // unreachable from this path; we stub them with a no-op resolving to 0
    // so the type is satisfied without changing simulate behaviour.
    const unreachable = async (): Promise<{ synced: number }> => ({ synced: 0 });
    const stub = {
      getAccountId: async () => accountId,
      syncProducts: makeStub("products", failResource === "products"),
      syncPrices: makeStub("prices", failResource === "prices"),
      syncPlans: makeStub("plans", failResource === "plans"),
      syncCustomers: unreachable,
      syncSubscriptions: unreachable,
      syncInvoices: unreachable,
      syncCharges: unreachable,
      syncPaymentMethods: unreachable,
    };

    const result = runScopedSync(stub);
    if (result.alreadyRunning) {
      res.status(409).json({ alreadyRunning: true, message: "Sync already in progress" });
      return;
    }
    res.json({ success: true, failResource: failResource ?? null, delayMs });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/sync/_test/simulate error");
    res.status(500).json({ error: "Failed to simulate sync" });
  }
});

// GET /admin/stripe/sync/status — read per-resource sync state for the UI poller.
router.get("/admin/stripe/sync/status", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { readSyncStatus } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const accountId = await sync.getAccountId();
    const status = await readSyncStatus(accountId);
    res.json(status);
  } catch (err) {
    logger.error({ err }, "[admin] GET /admin/stripe/sync/status error");
    res.status(500).json({ error: "Failed to read sync status" });
  }
});

router.post("/admin/stripe/test-event", requireAdmin, async (req: Request, res: Response) => {
  try {
    // Use getConfigStringRaw to be independent of debug-mode resolution
    const { getConfigStringRaw } = await import("../lib/adminConfig");
    const liveMode = await getConfigStringRaw("stripe_live_mode", "false");

    if (liveMode === "true") {
      res.status(403).json({ error: "Test events are only available in test mode" });
      return;
    }

    const { userId } = req.body as { userId?: string };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const [targetUser] = await db.select({ id: usersTable.id, stripeCustomerId: usersTable.stripeCustomerId, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.isActive, true)))
      .limit(1);

    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { stripeStorage } = await import("../lib/stripeStorage");
    const { getUncachableStripeClient } = await import("../lib/stripeClient");

    let customerId = targetUser.stripeCustomerId;
    if (!customerId) {
      const stripe = await getUncachableStripeClient();
      const customer = await stripe.customers.create({
        email: targetUser.email ?? undefined,
        metadata: { userId },
      });
      await stripeStorage.updateUserStripeCustomerId(userId, customer.id);
      customerId = customer.id;
    }

    // Build a minimal checkout.session.completed event with an embedded subscription object
    // (not a string ID) so the handler can process it without additional Stripe API calls.
    const { WebhookHandlers } = await import("../lib/webhookHandlers");

    const fakeSubId = `sub_test_${Date.now()}`;
    const embeddedSub = {
      id: fakeSubId,
      object: "subscription",
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      items: {
        object: "list",
        data: [
          {
            id: `si_test_${Date.now()}`,
            object: "subscription_item",
            price: {
              id: `price_test_${Date.now()}`,
              object: "price",
              type: "recurring",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed", aggregate_usage: null },
              product: {
                id: "prod_test",
                object: "product",
                active: true,
                metadata: {},
              },
            },
          },
        ],
        has_more: false,
        total_count: 1,
        url: "/v1/subscription_items",
      },
    };

    const fakeEvent = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      api_version: "2022-11-15",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          object: "checkout.session",
          customer: customerId,
          mode: "subscription",
          payment_status: "paid",
          status: "complete",
          subscription: embeddedSub,
          payment_intent: null,
          amount_total: 499,
          currency: "usd",
          metadata: {},
        },
      },
    };

    // processEventDirectly routes through the same domain switch as real webhooks,
    // with only Stripe sync + signature verification skipped (test mode only).
    await WebhookHandlers.processEventDirectly(fakeEvent as unknown as import("stripe").Stripe.Event);

    res.json({ success: true, message: `Test webhook processed — user ${userId} upgraded to legendary via checkout.session.completed domain handler` });
  } catch (err) {
    logger.error({ err }, "[admin] stripe/test-event error");
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Test event failed", details: msg });
  }
});

// ── Feature Flag Admin Endpoints ──────────────────────────────────────────────

router.get("/admin/feature-flags", requireAdmin, async (_req: Request, res: Response) => {
  const matrix = await getAllTierFeatureMatrix();
  res.json(matrix);
});

router.patch("/admin/feature-flags", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const tier = typeof body["tier"] === "string" ? body["tier"].trim() : null;
  const featureKey = typeof body["featureKey"] === "string" ? body["featureKey"].trim() : null;
  const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : null;

  if (!tier || !featureKey || enabled === null) {
    res.status(400).json({ error: "tier, featureKey, and enabled are required" });
    return;
  }

  const [flag] = await db
    .select({ key: featureFlagsTable.key })
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, featureKey))
    .limit(1);

  if (!flag) {
    res.status(404).json({ error: "Feature flag not found" });
    return;
  }

  await setTierFeature(tier, featureKey, enabled);
  bustTierFeaturesCache();

  res.json({ tier, featureKey, enabled });
});

router.post("/admin/_debug/sentry", requireAdmin, (req: Request, res: Response) => {
  const userId = req.user?.id ?? "unknown";
  Sentry.getIsolationScope().setTag("debug", "sentry-test");
  Sentry.getIsolationScope().setUser({ id: userId });
  throw new Error(`Sentry test error triggered by admin user ${userId}`);
});

// Reports whether the backend Sentry SDK is configured, and with which
// environment / release. Used by the admin "Sentry diagnostics" card.
// The DSN value itself is never returned — only a boolean — so this is
// safe to expose behind requireAdmin.
router.get("/admin/sentry-status", requireAdmin, (_req: Request, res: Response) => {
  const dsnConfigured = Boolean(process.env.SENTRY_DSN_BACKEND);
  const environment = process.env.NODE_ENV === "production" ? "production" : "development";
  const release =
    process.env.REPLIT_DEPLOYMENT_ID ??
    process.env.REPLIT_GIT_COMMIT_SHA?.slice(0, 7) ??
    "dev";
  res.json({ dsnConfigured, environment, release });
});

/**
 * GET /admin/route-stats
 * Returns route visit stats sorted by visit count descending.
 * Optional query param: since — ISO date string or relative shorthand like "7d" or "30d".
 * Admin-only.
 */
router.get("/admin/route-stats", requireAdmin, async (req: Request, res: Response) => {
  const { since } = req.query as { since?: string };

  let sinceDate: Date | null = null;
  if (since) {
    const relMatch = since.match(/^(\d+)d$/);
    if (relMatch) {
      const days = parseInt(relMatch[1]!, 10);
      sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    } else {
      const parsed = new Date(since);
      if (!isNaN(parsed.getTime())) sinceDate = parsed;
    }
  }

  if (sinceDate) {
    const rows = await db
      .select({
        routeKey: routeStatEventsTable.routeKey,
        visitCount: sum(routeStatEventsTable.delta).mapWith(Number),
        updatedAt: sql<Date>`max(${routeStatEventsTable.recordedAt})`,
      })
      .from(routeStatEventsTable)
      .where(gte(routeStatEventsTable.recordedAt, sinceDate))
      .groupBy(routeStatEventsTable.routeKey)
      .orderBy(desc(sum(routeStatEventsTable.delta)));
    res.json({ stats: rows });
    return;
  }

  const rows = await db
    .select()
    .from(routeStatsTable)
    .orderBy(desc(routeStatsTable.visitCount));
  res.json({ stats: rows });
});

// GET /admin/email-queue — paginated list of email outbox rows, filterable by status
// Admin email queue is a typed projection of the shared async_jobs table
// filtered to queue = "email". The status vocabulary is the generic one
// (pending / processing / done / failed) — the legacy email-only values
// (sending / delivered / abandoned) were normalized in migration 0063.
router.get("/admin/email-queue", requireAdmin, async (req: Request, res: Response) => {
  const VALID_STATUSES = ["pending", "processing", "done", "failed"] as const;
  type JobStatus = typeof VALID_STATUSES[number];

  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;

  const rawStatus = String(req.query["status"] ?? "").trim();
  const queueFilter = eq(asyncJobsTable.queue, "email");
  const statusFilter = rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
    ? and(queueFilter, eq(asyncJobsTable.status, rawStatus as JobStatus))
    : queueFilter;

  try {
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: asyncJobsTable.id,
          payload: asyncJobsTable.payload,
          status: asyncJobsTable.status,
          attempts: asyncJobsTable.attempts,
          maxAttempts: asyncJobsTable.maxAttempts,
          lastError: asyncJobsTable.lastError,
          nextAttemptAt: asyncJobsTable.nextAttemptAt,
          createdAt: asyncJobsTable.createdAt,
          updatedAt: asyncJobsTable.updatedAt,
        })
        .from(asyncJobsTable)
        .where(statusFilter)
        .orderBy(desc(asyncJobsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(asyncJobsTable).where(statusFilter),
    ]);

    // Flatten the payload back into the per-row shape the admin UI expects.
    const flattened = rows.map((r) => {
      const p = (r.payload ?? {}) as { to?: string; subject?: string; text?: string; html?: string | null; kind?: string | null };
      return {
        id: r.id,
        to: p.to ?? "",
        subject: p.subject ?? "",
        text: p.text ?? "",
        html: p.html ?? null,
        kind: p.kind ?? null,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        lastError: r.lastError,
        nextAttemptAt: r.nextAttemptAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    res.json({ rows: flattened, total, page, limit, validStatuses: VALID_STATUSES });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue error");
    const msg = err instanceof Error ? err.message : "Failed to load email queue";
    res.status(500).json({ error: msg });
  }
});

// DELETE /admin/email-queue?status=done|failed|pending — bulk-delete email-queue rows with the given status
router.delete("/admin/email-queue", requireAdmin, async (req: Request, res: Response) => {
  const CLEARABLE_STATUSES = ["done", "failed", "pending"] as const;
  type ClearableStatus = typeof CLEARABLE_STATUSES[number];

  const rawStatus = String(req.query["status"] ?? "").trim();
  if (!rawStatus || !(CLEARABLE_STATUSES as readonly string[]).includes(rawStatus)) {
    res.status(400).json({
      error: `status query param must be one of: ${CLEARABLE_STATUSES.join(", ")}`,
    });
    return;
  }

  const status = rawStatus as ClearableStatus;

  try {
    const deleted = await db
      .delete(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "email"), eq(asyncJobsTable.status, status)))
      .returning({ id: asyncJobsTable.id });

    res.json({ success: true, deleted: deleted.length });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue delete error");
    const msg = err instanceof Error ? err.message : "Delete failed";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/email-queue/:id/retry — reset a failed row back to pending
router.post("/admin/email-queue/:id/retry", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid email outbox id" });
    return;
  }

  try {
    // Atomic conditional update: only resets the row if it is still failed.
    // This prevents a race where two concurrent admin retries both pass a
    // read-then-check and then both reset the same row to pending.
    const [updated] = await db
      .update(asyncJobsTable)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(asyncJobsTable.id, id),
        eq(asyncJobsTable.queue, "email"),
        eq(asyncJobsTable.status, "failed"),
      ))
      .returning();

    if (!updated) {
      const [current] = await db
        .select({ id: asyncJobsTable.id, status: asyncJobsTable.status })
        .from(asyncJobsTable)
        .where(and(eq(asyncJobsTable.id, id), eq(asyncJobsTable.queue, "email")))
        .limit(1);

      if (!current) {
        res.status(404).json({ error: "Email outbox row not found" });
        return;
      }
      res.status(400).json({
        error: `Cannot retry a row with status "${current.status}" — only failed rows can be retried`,
      });
      return;
    }

    res.json({ success: true, row: updated });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue retry error");
    const msg = err instanceof Error ? err.message : "Retry failed";
    res.status(500).json({ error: msg });
  }
});


router.get("/admin/users/:id/data-export", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const payload = await exportUserData(id);
  res.json({ success: true, ...payload });
});

router.post("/admin/users/:id/data-delete", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const phase = String((req.body as Record<string, unknown>)?.["phase"] ?? "soft");
  if (phase === "soft") {
    const result = await softDeleteUserLifecycle(id);
    res.json({ success: true, phase, ...result });
    return;
  }
  if (phase === "hard") {
    await anonymizePaymentHistoryForUser(id);
    const result = await hardDeleteUserLifecycle(id);
    res.json({ success: true, phase, ...result });
    return;
  }
  res.status(400).json({ error: "Unsupported phase" });
});

router.post("/admin/retention/run", requireAdmin, async (_req: Request, res: Response) => {
  const result = await runRetentionWindowJobs();
  res.json({ success: true, result });
});

export default router;
