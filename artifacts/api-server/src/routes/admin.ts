import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import * as Sentry from "@sentry/node";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { factsTable, commentsTable, adminConfigTable, videoStylesTable, featureFlagsTable, tierFeaturePermissionsTable, userGenerationCostsTable, lifetimeEntitlementsTable, subscriptionsTable, membershipHistoryTable, activityFeedTable, memesTable, userAiImagesTable, routeVisitStatsTable } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and, or, inArray, isNull, asc, gt } from "drizzle-orm";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import { isAdminById } from "./auth";
import { deriveUserRole } from "../lib/userRole";
import { backfillEmbeddings } from "../lib/embeddings";
import { runFactImagePipeline } from "../lib/factImagePipeline";
import { generateAiMemeBackgrounds, type AiScenePrompts, type AiMemeImages } from "../lib/aiMemePipeline";
import { logActivity } from "../lib/activity";
import { getAllConfig, bustConfigCache, getPublicConfig } from "../lib/adminConfig";
import { getAllTierFeatureMatrix, setTierFeature, bustTierFeaturesCache } from "../lib/tierFeatures";
import { ObjectStorageService } from "../lib/objectStorage";
import { memeKey } from "../lib/storageKeys";
import bcrypt from "bcryptjs";

const _styleStorage = new ObjectStorageService();

async function resolveUserTierOnReinstatement(userId: string): Promise<"registered" | "legendary"> {
  const lifetimeRows = await db
    .select({ id: lifetimeEntitlementsTable.id })
    .from(lifetimeEntitlementsTable)
    .where(eq(lifetimeEntitlementsTable.userId, userId))
    .limit(1);
  if (lifetimeRows.length > 0) return "legendary";

  const activeSubRows = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(and(
      eq(subscriptionsTable.userId, userId),
      gt(subscriptionsTable.currentPeriodEnd, new Date()),
    ))
    .limit(1);
  if (activeSubRows.length > 0) return "legendary";

  return "registered";
}

const router: IRouter = Router();

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;

  const adminViaEnv = isAdminById(req.user.id);
  const adminViaSession = session?.isAdmin === true;

  if (!adminViaEnv && !adminViaSession) {
    const [dbUser] = await db
      .select({ isAdmin: usersTable.isAdmin, membershipTier: usersTable.membershipTier })
      .from(usersTable)
      .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
      .limit(1);
    const role = deriveUserRole(dbUser?.membershipTier, dbUser?.isAdmin);
    if (role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (session && sid) {
      await updateSession(sid, { ...session, isAdmin: true });
    }
  }

  next();
}

router.get("/admin/me", requireAdmin, (_req: Request, res: Response) => {
  res.json({ isAdmin: true });
});


router.get("/admin/stats", requireAdmin, async (_req: Request, res: Response) => {
  const [[{ totalFacts }], [{ totalUsers }]] = await Promise.all([
    db.select({ totalFacts: count() }).from(factsTable).where(eq(factsTable.isActive, true)),
    db.select({ totalUsers: count() }).from(usersTable).where(eq(usersTable.isActive, true)),
  ]);
  res.json({ totalFacts, totalUsers });
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

  const [users, [{ total }]] = await Promise.all([
    db.select().from(usersTable).where(where).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset),
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
  if (typeof body["captchaVerified"] === "boolean") updates.captchaVerified = body["captchaVerified"];
  if (body["displayName"] !== undefined) updates.displayName = body["displayName"] ? String(body["displayName"]) : null;
  if (body["email"] !== undefined) updates.email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  if (body["membershipTier"] !== undefined && ["unregistered", "registered", "legendary"].includes(String(body["membershipTier"])))
    updates.membershipTier = String(body["membershipTier"]) as "unregistered" | "registered" | "legendary";
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
        catch (e) { console.error(`[hard-delete] AI image cleanup failed for ${img.storagePath}:`, e); storageErrors++; }
      }
      for (const meme of userMemes) {
        const src = meme.imageSource as { type?: string; uploadKey?: string } | null;
        if (src === null) {
          // Pre-rendered meme image stored in object storage
          try { await storage.deleteObject(`/objects/${memeKey(meme.permalinkSlug, "jpg")}`); memeImagesDeleted++; }
          catch (e) { console.error(`[hard-delete] Meme image cleanup failed for ${meme.permalinkSlug}:`, e); storageErrors++; }
        } else if (src?.type === "upload" && src.uploadKey) {
          // User-uploaded background photo
          try { await storage.deleteObject(src.uploadKey); memeImagesDeleted++; }
          catch (e) { console.error(`[hard-delete] Upload image cleanup failed:`, e); storageErrors++; }
        }
      }

      // Step 2.5: Cancel active Stripe subscription (non-fatal — user is being permanently deleted)
      let subscriptionCanceled = false;
      const activeSubs = await db
        .select({ stripeSubscriptionId: subscriptionsTable.stripeSubscriptionId })
        .from(subscriptionsTable)
        .where(and(
          eq(subscriptionsTable.userId, id),
          or(eq(subscriptionsTable.status, "active"), eq(subscriptionsTable.status, "trialing"))
        ));
      if (activeSubs.length > 0) {
        try {
          const { getUncachableStripeClient } = await import("../lib/stripeClient");
          const stripe = await getUncachableStripeClient();
          let canceledCount = 0;
          for (const sub of activeSubs) {
            try {
              // Update cancel_at_period_end to false first to ensure cancel() is immediate
              await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
              await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
              canceledCount++;
            } catch (e) {
              console.error(`[hard-delete] Failed to cancel subscription ${sub.stripeSubscriptionId}:`, e);
            }
          }
          subscriptionCanceled = canceledCount > 0;
        } catch (e) {
          console.error("[hard-delete] Stripe client initialization failed:", e);
        }
      }

      // Step 3: Delete records with NOT NULL user_id FKs and no cascade
      currentStage = "membership";
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, id));
      await db.delete(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, id));
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
      console.error(`[hard-delete] Failed at stage "${currentStage}":`, e);
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
        .select({ stripeSubscriptionId: subscriptionsTable.stripeSubscriptionId })
        .from(subscriptionsTable)
        .where(and(
          eq(subscriptionsTable.userId, id),
          or(eq(subscriptionsTable.status, "active"), eq(subscriptionsTable.status, "trialing"))
        ));
      if (activeSubs.length > 0) {
        try {
          const { getUncachableStripeClient } = await import("../lib/stripeClient");
          const stripe = await getUncachableStripeClient();
          let canceledCount = 0;
          for (const sub of activeSubs) {
            try {
              // Update cancel_at_period_end to false first to ensure cancel() is immediate
              await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
              await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
              canceledCount++;
            } catch (e) {
              console.error(`[soft-delete] Failed to cancel subscription ${sub.stripeSubscriptionId}:`, e);
            }
          }
          subscriptionCanceled = canceledCount > 0;
        } catch (e) {
          console.error("[soft-delete] Stripe client initialization failed:", e);
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
      console.error(`[soft-delete] Failed at stage "${currentStage}":`, e);
      res.status(500).json({ error: e instanceof Error ? e.message : "Soft delete failed", stage: currentStage });
    }
  }
});

// GET /admin/users/:id/membership — full membership status for a user
router.get("/admin/users/:id/membership", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [lifetimeRows, subRows, historyRows] = await Promise.all([
      db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, id)).limit(1),
      db.select().from(subscriptionsTable)
        .where(eq(subscriptionsTable.userId, id))
        .orderBy(desc(subscriptionsTable.createdAt))
        .limit(1),
      db.select().from(membershipHistoryTable)
        .where(eq(membershipHistoryTable.userId, id))
        .orderBy(desc(membershipHistoryTable.createdAt))
        .limit(30),
    ]);

    const appSub = subRows[0] ?? null;

    let stripeSub: Record<string, unknown> | null = null;
    if (appSub?.stripeSubscriptionId) {
      const result = await db.execute(
        sql`SELECT s.id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.canceled_at, s.created
            FROM stripe.subscriptions s WHERE s.id = ${appSub.stripeSubscriptionId} LIMIT 1`,
      );
      stripeSub = (result.rows[0] as Record<string, unknown>) ?? null;
    }

    res.json({
      isLifetime: lifetimeRows.length > 0,
      lifetimeEntitlement: lifetimeRows[0] ?? null,
      appSubscription: appSub,
      stripeSub,
      history: historyRows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch membership data";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/grant-lifetime — manually grant Legendary for Life
router.post("/admin/users/:id/grant-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [existing, userRows] = await Promise.all([
      db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, id)).limit(1),
      db.select({ stripeCustomerId: usersTable.stripeCustomerId }).from(usersTable).where(eq(usersTable.id, id)).limit(1),
    ]);
    if (existing.length > 0) {
      res.status(400).json({ error: "User already has Legendary for Life" });
      return;
    }
    if (!userRows[0]) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const fakePaymentIntentId = `admin_grant_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    await db.transaction(async (tx) => {
      await tx.insert(lifetimeEntitlementsTable).values({
        userId: id,
        stripePaymentIntentId: fakePaymentIntentId,
        stripeCustomerId: userRows[0]!.stripeCustomerId ?? "admin_grant",
        amount: 0,
        currency: "usd",
      });
      await tx.update(usersTable).set({ membershipTier: "legendary" }).where(eq(usersTable.id, id));
      await tx.insert(membershipHistoryTable).values({
        userId: id,
        event: "lifetime_purchase",
        plan: "lifetime",
        amount: 0,
        currency: "usd",
        stripePaymentIntentId: fakePaymentIntentId,
      });
    });

    const [updated] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    res.json({ success: true, user: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Grant failed";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/revoke-lifetime — remove Legendary for Life entitlement
router.post("/admin/users/:id/revoke-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const existing = await db.select().from(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, id)).limit(1);
    if (existing.length === 0) {
      res.status(400).json({ error: "User does not have Legendary for Life" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx.delete(lifetimeEntitlementsTable).where(eq(lifetimeEntitlementsTable.userId, id));
      await tx.insert(membershipHistoryTable).values({
        userId: id,
        event: "subscription_cancelled",
        plan: "lifetime",
      });
    });

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
    const [created] = await db
      .insert(usersTable)
      .values({ email, passwordHash, displayName, membershipTier, isAdmin, isActive: true })
      .returning();
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
    console.error("[admin] Create user error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.get("/admin/facts", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const showInactive = req.query["inactive"] === "true";

  const activeFilter = showInactive ? undefined : eq(factsTable.isActive, true);
  const searchFilter = search ? ilike(factsTable.text, `%${search}%`) : undefined;
  const where = activeFilter && searchFilter ? and(activeFilter, searchFilter) : activeFilter ?? searchFilter;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
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
      submittedById: factsTable.submittedById,
      createdAt: factsTable.createdAt,
      updatedAt: factsTable.updatedAt,
      hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
      hasPexelsImages: sql<boolean>`(${factsTable.pexelsImages} IS NOT NULL)`,
    })
      .from(factsTable)
      .where(where)
      .orderBy(desc(factsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factsTable).where(where),
  ]);

  res.json({ facts: rows, total, page, limit });
});

router.delete("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const hard = req.query["hard"] === "true";

  if (hard) {
    const [deleted] = await db.delete(factsTable).where(eq(factsTable.id, id)).returning({ id: factsTable.id });
    if (!deleted) { res.status(404).json({ error: "Fact not found" }); return; }
    res.json({ success: true, deleted: true });
  } else {
    const [updated] = await db.update(factsTable).set({ isActive: false }).where(and(eq(factsTable.id, id), eq(factsTable.isActive, true))).returning({ id: factsTable.id });
    if (!updated) { res.status(404).json({ error: "Fact not found or already inactive" }); return; }
    res.json({ success: true, deleted: false });
  }
});

router.patch("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const { text, upvotes, downvotes, score, wilsonScore, commentCount, submittedById, parentId, useCase, isActive } = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (text !== undefined) updates.text = String(text);
  if (upvotes !== undefined) updates.upvotes = Number(upvotes);
  if (downvotes !== undefined) updates.downvotes = Number(downvotes);
  if (score !== undefined) updates.score = Number(score);
  if (wilsonScore !== undefined) updates.wilsonScore = Number(wilsonScore);
  if (commentCount !== undefined) updates.commentCount = Number(commentCount);
  if (submittedById !== undefined) updates.submittedById = submittedById ? String(submittedById) : null;
  if (parentId !== undefined) updates.parentId = parentId !== null && parentId !== "" ? Number(parentId) : null;
  if (useCase !== undefined) updates.useCase = useCase ? String(useCase) : null;
  if (isActive !== undefined) updates.isActive = Boolean(isActive);

  const [updated] = await db.update(factsTable).set(updates).where(eq(factsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Fact not found" }); return; }

  // Re-run image pipeline when the fact text changes and it's a root fact
  if (text !== undefined && updated.parentId === null) {
    void runFactImagePipeline(updated.id, updated.text);
  }

  const { embedding: _emb, ...factRow } = updated;
  res.json({ success: true, fact: { ...factRow, hasEmbedding: updated.embedding !== null } });
});

// POST /admin/facts/:id/variants — create a variant linked to a root fact
router.post("/admin/facts/:id/variants", requireAdmin, async (req: Request, res: Response) => {
  const rootId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(rootId)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [root] = await db.select({ id: factsTable.id, parentId: factsTable.parentId }).from(factsTable).where(and(eq(factsTable.id, rootId), eq(factsTable.isActive, true))).limit(1);
  if (!root) { res.status(404).json({ error: "Fact not found" }); return; }
  if (root.parentId !== null) { res.status(400).json({ error: "Cannot add a variant to a variant. Target the root fact." }); return; }
  const { text, useCase } = req.body as Record<string, unknown>;
  if (!text || typeof text !== "string" || text.trim().length === 0) { res.status(400).json({ error: "text is required" }); return; }
  const [variant] = await db.insert(factsTable).values({
    text: text.trim(),
    parentId: rootId,
    useCase: useCase ? String(useCase) : null,
    isActive: true,
  } as typeof factsTable.$inferInsert).returning();
  res.status(201).json({ success: true, variant });
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

router.post("/admin/facts/import", requireAdmin, async (req: Request, res: Response) => {
  const { facts } = req.body as { facts?: unknown };

  if (!Array.isArray(facts) || facts.length === 0) {
    res.status(400).json({ error: "facts must be a non-empty array of strings" });
    return;
  }

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

  const inserted = await db
    .insert(factsTable)
    .values(texts.map((text) => ({ text, isActive: true as const })))
    .returning();

  res.json({ success: true, imported: inserted.length, facts: inserted });
});

router.post("/admin/facts/import-csv", requireAdmin, async (req: Request, res: Response) => {
  const { csv } = req.body as { csv?: string };

  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "csv string is required" });
    return;
  }

  const lines = csv.split("\n")
    .map((l) => l.replace(/^["']|["']$/g, "").trim())
    .filter((l) => l.length > 5);

  if (lines.length === 0) {
    res.status(400).json({ error: "No valid lines found in CSV" });
    return;
  }

  const inserted = await db
    .insert(factsTable)
    .values(lines.map((text) => ({ text, isActive: true as const })))
    .returning();

  res.json({ success: true, imported: inserted.length });
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
async function requireAdminOrApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers["x-api-key"];
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (adminApiKey && apiKey === adminApiKey) {
    next();
    return;
  }
  return requireAdmin(req, res, next);
}

// POST /admin/users/set-password — reset a user's password by email (API key auth)
router.post("/admin/users/set-password", requireAdminOrApiKey, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== "string") { res.status(400).json({ error: "email is required" }); return; }
  if (!password || typeof password !== "string") { res.status(400).json({ error: "password is required" }); return; }
  if (password.length < 6) { res.status(400).json({ error: "password must be at least 6 characters" }); return; }
  if (password.length > 128) { res.status(400).json({ error: "password must be at most 128 characters" }); return; }
  const [user] = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.email, email.trim().toLowerCase())).limit(1);
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
  const [fact] = await db.select({ id: factsTable.id, text: factsTable.text, parentId: factsTable.parentId, pexelsImages: factsTable.pexelsImages })
    .from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (fact.parentId !== null) { res.status(400).json({ error: "Images are only stored on root facts, not variants." }); return; }
  if (!force && fact.pexelsImages !== null) {
    res.json({ success: true, skipped: true, message: "Fact already has images. Pass force=true to overwrite." });
    return;
  }
  void runFactImagePipeline(fact.id, fact.text);
  res.json({ success: true, skipped: false, message: "Image pipeline started. Results will appear shortly." });
});

router.post("/admin/facts/backfill-images", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const rootFacts = await db.select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable).where(isNull(factsTable.parentId));
    let triggered = 0;
    for (const fact of rootFacts) {
      void runFactImagePipeline(fact.id, fact.text);
      triggered++;
    }
    res.json({ success: true, triggered });
  } catch (err) {
    console.error("[admin] Backfill images error:", err);
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// POST /admin/backfill-pexels
// Backfill Pexels images for all root facts that currently have NULL pexelsImages.
// Idempotent: skips facts that already have images.
// Returns 202 immediately with the count of facts queued; processes sequentially in the background.
router.post("/admin/backfill-pexels", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const nullFacts = await db
      .select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable)
      .where(and(isNull(factsTable.parentId), isNull(factsTable.pexelsImages)));

    const queued = nullFacts.length;
    res.status(202).json({ success: true, queued, message: `Backfilling Pexels images for ${queued} fact(s) in the background.` });

    if (queued === 0) {
      console.log("[admin] backfill-pexels: all root facts already have images, nothing to do.");
      return;
    }

    void (async () => {
      console.log(`[admin] backfill-pexels: starting — ${queued} root fact(s) with NULL pexelsImages`);
      let succeeded = 0;
      let failed = 0;

      for (let i = 0; i < nullFacts.length; i++) {
        const fact = nullFacts[i]!;
        console.log(`[admin] backfill-pexels: [${i + 1}/${queued}] fact ${fact.id}: "${fact.text.slice(0, 60)}"`);

        await runFactImagePipeline(fact.id, fact.text);

        // runFactImagePipeline catches all errors internally — verify success via DB
        const [updated] = await db
          .select({ pexelsImages: factsTable.pexelsImages })
          .from(factsTable)
          .where(eq(factsTable.id, fact.id))
          .limit(1);

        if (updated?.pexelsImages != null) {
          succeeded++;
          console.log(`[admin] backfill-pexels: [${i + 1}/${queued}] fact ${fact.id} — OK`);
        } else {
          failed++;
          console.error(`[admin] backfill-pexels: [${i + 1}/${queued}] fact ${fact.id} — FAILED (pexelsImages still null)`);
        }

        // 1-second delay between requests to respect Pexels rate limits
        if (i < nullFacts.length - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
      }

      console.log(`[admin] backfill-pexels: done — ${succeeded} succeeded, ${failed} failed out of ${queued} total`);
    })();
  } catch (err) {
    console.error("[admin] backfill-pexels error:", err);
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

router.post("/admin/facts/backfill-ai-memes", requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const force = String((req.query as Record<string, unknown>)["force"] ?? "") === "true";

    let rootFacts;
    if (force) {
      rootFacts = await db
        .select({ id: factsTable.id, text: factsTable.text })
        .from(factsTable)
        .where(isNull(factsTable.parentId));
    } else {
      rootFacts = await db
        .select({ id: factsTable.id, text: factsTable.text })
        .from(factsTable)
        .where(and(isNull(factsTable.parentId), isNull(factsTable.aiMemeImages)));
    }

    const total = rootFacts.length;
    res.json({ success: true, queued: total, message: `Processing ${total} facts sequentially in the background.` });

    // Process sequentially so we don't hammer OpenAI rate limits
    void (async () => {
      console.log(`[admin] backfill-ai-memes: starting ${total} facts (force=${force})`);
      for (const fact of rootFacts) {
        await generateAiMemeBackgrounds(fact.id, fact.text, { suppressErrors: true });
      }
      console.log(`[admin] backfill-ai-memes: done — processed ${total} facts`);
    })();
  } catch (err) {
    console.error("[admin] Backfill AI memes error:", err);
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

router.post("/admin/facts/backfill-embeddings", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const result = await backfillEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[admin] Backfill embeddings error:", err);
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// ─── AI Meme admin endpoints ──────────────────────────────────────────────────

/**
 * GET /admin/facts/:id/ai-meme — return aiScenePrompts + aiMemeImages for a fact
 */
router.get("/admin/facts/:id/ai-meme", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, aiScenePrompts: factsTable.aiScenePrompts, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json({
    id: fact.id,
    aiScenePrompts: fact.aiScenePrompts ?? null,
    aiMemeImages: fact.aiMemeImages ?? null,
  });
});

/**
 * PUT /admin/facts/:id/ai-meme/generate — trigger full AI meme background generation
 * Body: { scenePrompts?: AiScenePrompts } — optional, to use custom prompts
 */
router.put("/admin/facts/:id/ai-meme/generate", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, parentId: factsTable.parentId, aiScenePrompts: factsTable.aiScenePrompts, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);

  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (fact.parentId !== null) { res.status(400).json({ error: "AI meme backgrounds are only generated for root facts" }); return; }

  const body = req.body as Record<string, unknown>;
  const customPrompts = body["scenePrompts"] as AiScenePrompts | undefined;

  // Start generation in background; do not wait
  void generateAiMemeBackgrounds(fact.id, fact.text, {
    existingPrompts: customPrompts ?? (fact.aiScenePrompts as AiScenePrompts | undefined),
    suppressErrors: true,
  });

  res.json({ success: true, message: "AI meme background generation started. Results will appear shortly." });
});

/**
 * PUT /admin/facts/:id/ai-meme/regenerate-image — regenerate a single AI meme image
 * Body: { gender: "male"|"female"|"neutral", imageIndex: 0|1|2 }
 */
router.put("/admin/facts/:id/ai-meme/regenerate-image", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const body = req.body as Record<string, unknown>;
  const gender = body["gender"] as string;
  const imageIndex = parseInt(String(body["imageIndex"] ?? "0"), 10);

  if (!["male", "female", "neutral"].includes(gender)) {
    res.status(400).json({ error: "gender must be male, female, or neutral" });
    return;
  }
  if (isNaN(imageIndex) || imageIndex < 0 || imageIndex > 2) {
    res.status(400).json({ error: "imageIndex must be 0, 1, or 2" });
    return;
  }

  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, parentId: factsTable.parentId, aiScenePrompts: factsTable.aiScenePrompts, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);

  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (fact.parentId !== null) { res.status(400).json({ error: "AI meme backgrounds are only generated for root facts" }); return; }

  const existingPrompts = fact.aiScenePrompts as AiScenePrompts | undefined;
  if (!existingPrompts) {
    res.status(400).json({ error: "No scene prompts found. Run full generation first." });
    return;
  }

  void generateAiMemeBackgrounds(fact.id, fact.text, {
    existingPrompts,
    existingImages: (fact.aiMemeImages as AiMemeImages | undefined),
    targetGender: gender as "male" | "female" | "neutral",
    targetIndex: imageIndex,
    suppressErrors: true,
  });

  res.json({ success: true, message: "Image regeneration started. Results will appear shortly." });
});

/**
 * PUT /admin/facts/:id/ai-scene-prompts — update scene prompts for a fact
 */
router.put("/admin/facts/:id/ai-scene-prompts", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const body = req.body as Record<string, unknown>;
  const prompts = body["prompts"] as AiScenePrompts | undefined;

  if (!prompts || typeof prompts.male !== "string" || typeof prompts.female !== "string" || typeof prompts.neutral !== "string") {
    res.status(400).json({ error: "prompts.male, prompts.female, and prompts.neutral are required strings" });
    return;
  }

  await db
    .update(factsTable)
    .set({ aiScenePrompts: prompts })
    .where(eq(factsTable.id, id));

  res.json({ success: true });
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

  // When stripe_live_mode changes, explicitly invalidate the cached Stripe instance
  // so the next request picks up the correct connector credentials.
  if (key === "stripe_live_mode") {
    const { invalidateStripeSync } = await import("../lib/stripeClient");
    invalidateStripeSync();
  }

  res.json(updated);
});

// ─── Video Styles ─────────────────────────────────────────────────────────────

router.get("/admin/video-styles", requireAdmin, async (_req: Request, res: Response) => {
  const styles = await db
    .select()
    .from(videoStylesTable)
    .orderBy(asc(videoStylesTable.sortOrder), asc(videoStylesTable.id));
  res.json(styles);
});

router.post("/admin/video-styles", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const id = String(body.id ?? "").trim();
  if (!id) { res.status(400).json({ error: "id is required" }); return; }
  const label = String(body.label ?? "").trim();
  if (!label) { res.status(400).json({ error: "label is required" }); return; }

  const [created] = await db
    .insert(videoStylesTable)
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
    .update(videoStylesTable)
    .set(updates)
    .where(eq(videoStylesTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Style not found" }); return; }
  res.json(updated);
});

router.post("/admin/video-styles/:id/preview-gif", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  const body = req.body as Record<string, unknown>;
  const base64 = String(body.base64 ?? "").trim();
  if (!base64) { res.status(400).json({ error: "base64 GIF data required" }); return; }

  const buf = Buffer.from(base64, "base64");
  const subPath = `video_style_previews/${id}.gif`;
  const storedPath = await _styleStorage.uploadObjectBuffer({
    subPath,
    buffer: buf,
    contentType: "image/gif",
  });

  try {
    await _styleStorage.trySetObjectEntityAclPolicy(storedPath, { owner: "system", visibility: "public" });
  } catch { /* non-fatal */ }

  const [updated] = await db
    .update(videoStylesTable)
    .set({ previewGifPath: storedPath, updatedAt: new Date() })
    .where(eq(videoStylesTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Style not found" }); return; }
  res.json(updated);
});

router.delete("/admin/video-styles/:id/preview-gif", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);

  const [style] = await db
    .select({ previewGifPath: videoStylesTable.previewGifPath })
    .from(videoStylesTable)
    .where(eq(videoStylesTable.id, id))
    .limit(1);

  if (!style) { res.status(404).json({ error: "Style not found" }); return; }
  if (style.previewGifPath) {
    try {
      await _styleStorage.deleteObject(style.previewGifPath);
    } catch { /* non-fatal */ }
  }

  const [updated] = await db
    .update(videoStylesTable)
    .set({ previewGifPath: null, updatedAt: new Date() })
    .where(eq(videoStylesTable.id, id))
    .returning();

  res.json(updated);
});

// ─── Admin Stripe Endpoints ───────────────────────────────────────────────────

router.get("/admin/stripe/summary", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Active legendary subscribers = users with legendary tier and an active subscription
    // Registered (free) members = users with registered tier (no payment)
    const [legendaryRows, registeredRows] = await Promise.all([
      db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(and(eq(usersTable.membershipTier, "legendary"), eq(usersTable.isActive, true))),
      db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(and(eq(usersTable.membershipTier, "registered"), eq(usersTable.isActive, true))),
    ]);

    const webhookSecretConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
    const priceIdsConfigured = !!(process.env.MEMBERSHIP_PRICE_IDS ?? "").trim();

    const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
    const webhookUrl = domain
      ? `https://${domain}/api/stripe/webhook`
      : null;

    res.json({
      activeSubscribers: legendaryRows[0]?.cnt ?? 0,
      registeredMembers: registeredRows[0]?.cnt ?? 0,
      webhookSecretConfigured,
      priceIdsConfigured,
      webhookUrl,
    });
  } catch (err) {
    console.error("[admin] stripe/summary error:", err);
    res.status(500).json({ error: "Failed to load stripe summary" });
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
    // Use a test price ID that IS in the MEMBERSHIP_PRICE_IDS allowlist or embed product
    // metadata so isMembershipPrice passes without external lookup.
    const { WebhookHandlers } = await import("../lib/webhookHandlers");

    const fakeSubId = `sub_test_${Date.now()}`;
    // Use the first configured membership price ID if available, otherwise use a recognizable test key
    const allowedPriceIds = (process.env.MEMBERSHIP_PRICE_IDS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
    // We embed the full price+product object in the subscription so isMembershipPrice
    // can read product.metadata.membership without hitting the Stripe API.
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
              id: allowedPriceIds[0] ?? `price_test_${Date.now()}`,
              object: "price",
              type: "recurring",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed", aggregate_usage: null },
              // Embed product with membership metadata so price validation passes without Stripe API call
              product: {
                id: "prod_test",
                object: "product",
                active: true,
                metadata: { membership: "true" },
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
    console.error("[admin] stripe/test-event error:", err);
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

// ---------------------------------------------------------------------------
// Route-visit stats — aggregate localStorage visit counts server-side
// ---------------------------------------------------------------------------

const VALID_ROUTE_KEYS = new Set([
  "home", "search", "facts", "submit", "profile",
  "onboard", "activity", "meme", "video", "pricing", "login",
]);

/**
 * POST /route-stats
 * Accepts a map of { routeKey: incrementAmount } from the client and adds
 * those counts into the shared server-side aggregates.  No auth required —
 * counts are low-sensitivity traffic data.  Input is strictly validated to
 * prevent injection of arbitrary keys or absurd counts.
 */
router.post("/route-stats", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const counts = body["counts"];

  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    res.status(400).json({ error: "counts must be an object" });
    return;
  }

  const entries: { routeKey: string; delta: number }[] = [];
  for (const [key, val] of Object.entries(counts as Record<string, unknown>)) {
    if (!VALID_ROUTE_KEYS.has(key)) continue;
    const delta = typeof val === "number" ? Math.floor(val) : parseInt(String(val), 10);
    if (isNaN(delta) || delta <= 0 || delta > 100_000) continue;
    entries.push({ routeKey: key, delta });
  }

  if (entries.length === 0) {
    res.json({ accepted: 0 });
    return;
  }

  await Promise.all(
    entries.map(({ routeKey, delta }) =>
      db
        .insert(routeVisitStatsTable)
        .values({ routeKey, visitCount: delta })
        .onConflictDoUpdate({
          target: routeVisitStatsTable.routeKey,
          set: {
            visitCount: sql`${routeVisitStatsTable.visitCount} + ${delta}`,
            updatedAt: sql`now()`,
          },
        }),
    ),
  );

  res.json({ accepted: entries.length });
});

/**
 * GET /admin/route-stats
 * Returns all route visit stats sorted by visit count descending.
 * Admin-only.
 */
router.get("/admin/route-stats", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(routeVisitStatsTable)
    .orderBy(desc(routeVisitStatsTable.visitCount));
  res.json({ stats: rows });
});

export default router;
