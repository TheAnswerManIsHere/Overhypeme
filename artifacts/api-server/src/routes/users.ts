import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  ratingsTable, searchHistoryTable, usersTable, emailVerificationTokensTable, memesTable,
  userGenerationCostsTable, pendingReviewsTable, commentsTable,
} from "@workspace/db/schema";
import { eq, desc, inArray, and, sql, isNull } from "drizzle-orm";
import { RecordSearchBody } from "@workspace/api-zod";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import crypto from "crypto";
import { sendEmail, buildEmailChangeVerificationEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { ObjectStorageService } from "../lib/objectStorage";
import { getConfigInt } from "../lib/adminConfig";
import { verifyCaptcha } from "../lib/captcha";

const router: IRouter = Router();

async function buildFactSummaries(facts: (typeof factsTable.$inferSelect)[], userId?: string) {
  if (!facts.length) return [];
  const ids = facts.map((f) => f.id);

  const fhRows = await db.select({ factId: factHashtagsTable.factId, name: hashtagsTable.name })
    .from(factHashtagsTable).innerJoin(hashtagsTable, eq(factHashtagsTable.hashtagId, hashtagsTable.id))
    .where(inArray(factHashtagsTable.factId, ids));
  const hMap = new Map<number, string[]>();
  for (const r of fhRows) { if (!hMap.has(r.factId)) hMap.set(r.factId, []); hMap.get(r.factId)!.push(r.name); }

  const rMap = new Map<number, string>();
  if (userId) {
    const rRows = await db.select({ factId: ratingsTable.factId, rating: ratingsTable.rating })
      .from(ratingsTable).where(and(eq(ratingsTable.userId, userId), inArray(ratingsTable.factId, ids)));
    for (const r of rRows) rMap.set(r.factId, r.rating);
  }

  return facts.map((f) => ({
    id: f.id, text: f.text, upvotes: f.upvotes, downvotes: f.downvotes, score: f.score,
    commentCount: f.commentCount, hashtags: hMap.get(f.id) ?? [],
    submittedBy: null, submittedByImage: null,
    userRating: userId ? (rMap.get(f.id) ?? null) : null,
    createdAt: f.createdAt.toISOString(),
  }));
}

router.get("/users/me", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const [userRow] = await db
    .select({
      email: usersTable.email,
      pendingEmail: usersTable.pendingEmail,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      displayName: usersTable.displayName,
      pronouns: usersTable.pronouns,
      profileImageUrl: usersTable.profileImageUrl,
      avatarStyle: usersTable.avatarStyle,
      avatarSource: usersTable.avatarSource,
      emailVerifiedAt: usersTable.emailVerifiedAt,
      membershipTier: usersTable.membershipTier,
      oauthProvider: usersTable.oauthProvider,
      passwordHash: usersTable.passwordHash,
      isAdmin: usersTable.isAdmin,
      adminNotifications: usersTable.adminNotifications,
      disputeNotifications: usersTable.disputeNotifications,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const submittedRows = await db.select().from(factsTable).where(and(eq(factsTable.submittedById, userId), eq(factsTable.isActive, true))).orderBy(desc(factsTable.createdAt)).limit(50);
  const pendingRows = await db.select({
    id: pendingReviewsTable.id,
    text: pendingReviewsTable.submittedText,
    status: pendingReviewsTable.status,
    hashtags: pendingReviewsTable.hashtags,
    createdAt: pendingReviewsTable.createdAt,
    reason: pendingReviewsTable.reason,
  }).from(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, userId)).orderBy(desc(pendingReviewsTable.createdAt)).limit(50);
  const likedRatings = await db.select({ factId: ratingsTable.factId }).from(ratingsTable).where(and(eq(ratingsTable.userId, userId), eq(ratingsTable.rating, "up")));
  const likedIds = likedRatings.map((r) => r.factId);
  const likedFacts = likedIds.length ? await db.select().from(factsTable).where(and(inArray(factsTable.id, likedIds), eq(factsTable.isActive, true))).limit(50) : [];

  const favoriteHashtagRows = await db
    .select({ name: hashtagsTable.name })
    .from(factHashtagsTable)
    .innerJoin(hashtagsTable, eq(factHashtagsTable.hashtagId, hashtagsTable.id))
    .innerJoin(factsTable, eq(factHashtagsTable.factId, factsTable.id))
    .where(and(eq(factsTable.submittedById, userId), eq(factsTable.isActive, true)));

  const hashtagCounts = new Map<string, number>();
  for (const r of favoriteHashtagRows) {
    hashtagCounts.set(r.name, (hashtagCounts.get(r.name) ?? 0) + 1);
  }
  const favoriteHashtags = [...hashtagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name);

  const rawSearchRows = await db.select({ query: searchHistoryTable.query })
    .from(searchHistoryTable).where(eq(searchHistoryTable.userId, userId))
    .orderBy(desc(searchHistoryTable.createdAt)).limit(200);
  const seenQueries = new Set<string>();
  const searchRows: string[] = [];
  for (const r of rawSearchRows) {
    if (!seenQueries.has(r.query)) {
      seenQueries.add(r.query);
      searchRows.push(r.query);
      if (searchRows.length >= 20) break;
    }
  }

  const [submittedSummaries, likedSummaries, myCommentRows] = await Promise.all([
    buildFactSummaries(submittedRows, userId),
    buildFactSummaries(likedFacts, userId),
    db.select({
      id: commentsTable.id,
      factId: commentsTable.factId,
      factText: factsTable.text,
      text: commentsTable.text,
      status: commentsTable.status,
      createdAt: commentsTable.createdAt,
    })
      .from(commentsTable)
      .leftJoin(factsTable, eq(commentsTable.factId, factsTable.id))
      .where(eq(commentsTable.authorId, userId))
      .orderBy(desc(commentsTable.createdAt))
      .limit(50),
  ]);

  const isAdmin = userRow?.isAdmin === true;

  res.json({
    id: userId,
    email: userRow?.email ?? null,
    pendingEmail: userRow?.pendingEmail ?? null,
    emailVerified: userRow?.emailVerifiedAt !== null && userRow?.emailVerifiedAt !== undefined,
    // Billing/fulfillment name fields (used for Stripe invoices and Zazzle orders)
    firstName: userRow?.firstName ?? null,
    lastName: userRow?.lastName ?? null,
    displayName: userRow?.displayName ?? null,
    pronouns: userRow?.pronouns ?? null,
    profileImageUrl: userRow?.profileImageUrl ?? null,
    avatarStyle: userRow?.avatarStyle ?? "bottts",
    avatarSource: userRow?.avatarSource ?? "avatar",
    isPremium: userRow?.membershipTier === "legendary",
    oauthProvider: userRow?.oauthProvider ?? null,
    hasPassword: !!(userRow?.passwordHash),
    ...(isAdmin && {
      adminNotifications: userRow?.adminNotifications ?? true,
      disputeNotifications: userRow?.disputeNotifications ?? true,
    }),
    submittedFacts: submittedSummaries,
    pendingSubmissions: pendingRows.map((r) => ({
      id: r.id,
      text: r.text,
      status: r.status,
      hashtags: r.hashtags ?? [],
      createdAt: r.createdAt.toISOString(),
      reason: r.reason ?? null,
    })),
    likedFacts: likedSummaries,
    favoriteHashtags,
    searchHistory: searchRows,
    myComments: myCommentRows.map((r) => ({
      id: r.id,
      factId: r.factId,
      factText: r.factText ?? null,
      text: r.text,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.patch("/users/me", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const { displayName, firstName, lastName, pronouns, email, profileImageUrl, avatarStyle, avatarSource } = req.body as {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    pronouns?: string;
    email?: string;
    profileImageUrl?: string;
    avatarStyle?: string;
    avatarSource?: string;
  };

  const ALLOWED_AVATAR_STYLES = ["bottts", "pixel-art", "adventurer", "identicon", "shapes", "thumbs"];

  const updates: Record<string, unknown> = {};

  if (displayName !== undefined) {
    const trimmed = typeof displayName === "string" ? displayName.trim() : "";
    if (!trimmed) { res.status(400).json({ error: "Display name cannot be empty" }); return; }
    if (trimmed.length > 80) { res.status(400).json({ error: "Display name must be 80 characters or fewer" }); return; }
    updates.displayName = trimmed;
  }

  // Billing/fulfillment name fields (used for Stripe invoices and Zazzle orders)
  if (firstName !== undefined) {
    const trimmed = typeof firstName === "string" ? firstName.trim() : "";
    if (trimmed.length > 80) { res.status(400).json({ error: "First name must be 80 characters or fewer" }); return; }
    updates.firstName = trimmed || null;
  }

  if (lastName !== undefined) {
    const trimmed = typeof lastName === "string" ? lastName.trim() : "";
    if (trimmed.length > 80) { res.status(400).json({ error: "Last name must be 80 characters or fewer" }); return; }
    updates.lastName = trimmed || null;
  }

  if (avatarStyle !== undefined) {
    if (!ALLOWED_AVATAR_STYLES.includes(avatarStyle)) {
      res.status(400).json({ error: "Invalid avatar style" }); return;
    }
    updates.avatarStyle = avatarStyle;
  }

  if (avatarSource !== undefined) {
    if (avatarSource !== "avatar" && avatarSource !== "photo") {
      res.status(400).json({ error: "avatarSource must be 'avatar' or 'photo'" }); return;
    }
    updates.avatarSource = avatarSource;
  }

  if (profileImageUrl !== undefined) {
    // Photo uploads require legendary membership
    const [userRow] = await db
      .select({ membershipTier: usersTable.membershipTier })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (userRow?.membershipTier !== "legendary") {
      res.status(403).json({ error: "Custom photo upload is a Legendary feature" }); return;
    }
    if (typeof profileImageUrl !== "string") {
      res.status(400).json({ error: "Invalid profile image URL" }); return;
    }
    const valid = profileImageUrl.startsWith("/api/storage/objects/") || profileImageUrl.startsWith("https://");
    if (!valid) { res.status(400).json({ error: "Invalid profile image URL" }); return; }
    updates.profileImageUrl = profileImageUrl;

    // Set the uploaded file as public so it can be served as an <img> to any viewer
    if (profileImageUrl.startsWith("/api/storage/objects/")) {
      const objectPath = profileImageUrl.replace("/api/storage", "");
      try {
        const objectStorageService = new ObjectStorageService();
        await objectStorageService.trySetObjectEntityAclPolicy(objectPath, { owner: userId, visibility: "public" });
      } catch (err) {
        console.error("[users] Failed to set ACL on profile image:", err);
      }
    }
  }

  if (pronouns !== undefined) {
    if (typeof pronouns !== "string" || pronouns.trim().length === 0) {
      res.status(400).json({ error: "Pronouns cannot be empty" });
      return;
    }
    if (pronouns.length > 80) {
      res.status(400).json({ error: "Pronouns must be 80 characters or fewer" });
      return;
    }
    updates.pronouns = pronouns.trim();
  }

  let emailVerificationPending = false;

  if (email !== undefined) {
    if (typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "A valid email address is required" });
      return;
    }
    const emailNormalized = email.trim().toLowerCase();

    // Check uniqueness against confirmed emails (not pending)
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, emailNormalized))
      .limit(1);
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: "Email is already in use" });
      return;
    }

    // Store as pendingEmail and send verification
    updates.pendingEmail = emailNormalized;

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.insert(emailVerificationTokensTable).values({
      userId,
      tokenHash,
      expiresAt,
      pendingEmail: emailNormalized,
    });

    const verifyUrl = `${getSiteBaseUrl()}/verify-email?token=${rawToken}`;
    const emailContent = buildEmailChangeVerificationEmail(emailNormalized, verifyUrl);
    sendEmail({ to: emailNormalized, ...emailContent }).catch((err) => {
      console.error("[users] Failed to send email change verification:", err);
    });

    emailVerificationPending = true;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(usersTable).set(updates).where(eq(usersTable.id, userId));
  }

  res.json({ success: true, emailVerificationPending });
});

router.patch("/users/me/notifications", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const [userRow] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!userRow?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if (typeof body["adminNotifications"] === "boolean") updates.adminNotifications = body["adminNotifications"];
  if (typeof body["disputeNotifications"] === "boolean") updates.disputeNotifications = body["disputeNotifications"];

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning({
      adminNotifications: usersTable.adminNotifications,
      disputeNotifications: usersTable.disputeNotifications,
    });

  res.json({ success: true, adminNotifications: updated?.adminNotifications, disputeNotifications: updated?.disputeNotifications });
});

router.post("/users/me/search-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(204).end(); return; }
  const parsed = RecordSearchBody.safeParse(req.body);
  if (!parsed.success) { res.status(204).end(); return; }
  const [last] = await db.select({ query: searchHistoryTable.query })
    .from(searchHistoryTable)
    .where(eq(searchHistoryTable.userId, req.user.id))
    .orderBy(desc(searchHistoryTable.createdAt))
    .limit(1);
  if (last?.query !== parsed.data.query) {
    await db.insert(searchHistoryTable).values({ userId: req.user.id, query: parsed.data.query });
  }
  res.status(204).end();
});

router.get("/users/me/uploads", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const displayLimit = await getConfigInt("bg_display_limit_upload", 20);

  const [rows, countResult, maxUploads] = await Promise.all([
    db.execute(sql`
      SELECT object_path, width, height, is_low_res, file_size_bytes, created_at
      FROM upload_image_metadata
      WHERE user_id = ${req.user.id}
      ORDER BY created_at DESC
      LIMIT ${displayLimit}
    `),
    db.execute(sql`
      SELECT COUNT(*)::integer AS total
      FROM upload_image_metadata
      WHERE user_id = ${req.user.id}
    `),
    getConfigInt("user_max_images", 1000),
  ]);

  const uploads = (rows.rows as Array<{
    object_path: string;
    width: number;
    height: number;
    is_low_res: boolean;
    file_size_bytes: number;
    created_at: string;
  }>).map(r => ({
    objectPath: r.object_path,
    width: r.width,
    height: r.height,
    isLowRes: r.is_low_res,
    fileSizeBytes: r.file_size_bytes,
    createdAt: r.created_at,
  }));

  const uploadCount = (countResult.rows[0] as { total: number } | undefined)?.total ?? 0;

  res.json({ uploads, uploadCount, maxUploads, displayLimit });
});

// GET /users/me/memes — list all non-deleted memes created by the current user
router.get("/users/me/memes", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const memes = await db
    .select({
      id: memesTable.id,
      factId: memesTable.factId,
      templateId: memesTable.templateId,
      imageUrl: memesTable.imageUrl,
      permalinkSlug: memesTable.permalinkSlug,
      isPublic: memesTable.isPublic,
      createdAt: memesTable.createdAt,
      originalWidth: memesTable.originalWidth,
      originalHeight: memesTable.originalHeight,
      uploadFileSizeBytes: memesTable.uploadFileSizeBytes,
    })
    .from(memesTable)
    .where(and(eq(memesTable.createdById, req.user.id), isNull(memesTable.deletedAt)))
    .orderBy(desc(memesTable.createdAt))
    .limit(100);

  res.json({
    memes: memes.map(m => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      originalWidth: m.originalWidth ?? null,
      originalHeight: m.originalHeight ?? null,
      uploadFileSizeBytes: m.uploadFileSizeBytes ?? null,
    })),
  });
});

// GET /users/me/ai-images — list AI-generated images owned by the current user
// Query params: factId (optional), imageType (optional, default 'reference')
router.get("/users/me/ai-images", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const factIdRaw = req.query["factId"];
  const factId = factIdRaw ? parseInt(String(factIdRaw), 10) : null;
  if (factIdRaw !== undefined && (factId === null || isNaN(factId))) {
    res.status(400).json({ error: "Invalid factId" }); return;
  }

  const imageType = String(req.query["imageType"] ?? "reference");

  const rows = await db.execute<{
    id: number;
    fact_id: number;
    gender: string;
    storage_path: string;
    image_type: string;
    created_at: string;
  }>(sql`
    SELECT id, fact_id, gender, storage_path, image_type, created_at
    FROM user_ai_images
    WHERE user_id = ${req.user.id}
      ${factId !== null ? sql`AND fact_id = ${factId}` : sql``}
      AND image_type = ${imageType}
    ORDER BY created_at DESC
    LIMIT 200
  `);

  const images = rows.rows.map(r => ({
    id: r.id,
    factId: r.fact_id,
    gender: r.gender,
    storagePath: r.storage_path,
    imageType: r.image_type,
    createdAt: r.created_at,
  }));

  res.json({ images });
});

// DELETE /users/me/uploads — hard-delete an uploaded image owned by the current user
// Query param: path (the object_path value from GET /users/me/uploads)
router.delete("/users/me/uploads", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const objectPath = String(req.query["path"] ?? "").trim();
  if (!objectPath) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }

  // Verify the upload belongs to the requesting user
  const rows = await db.execute(sql`
    SELECT object_path FROM upload_image_metadata
    WHERE user_id = ${req.user.id} AND object_path = ${objectPath}
    LIMIT 1
  `);

  if (!rows.rows.length) {
    res.status(404).json({ error: "Upload not found or does not belong to you" });
    return;
  }

  // Hard-delete from storage FIRST — if this fails, do not touch DB (strict hard-delete)
  try {
    const storageService = new ObjectStorageService();
    await storageService.deleteObject(objectPath);
  } catch (e) {
    console.error("[DELETE /users/me/uploads] Storage delete failed:", e);
    res.status(500).json({ error: "Failed to delete image from storage. Please try again." });
    return;
  }

  // Remove metadata row only after confirmed storage delete
  await db.execute(sql`
    DELETE FROM upload_image_metadata
    WHERE user_id = ${req.user.id} AND object_path = ${objectPath}
  `);

  res.json({ success: true });
});

router.post("/users/me/complete-onboarding", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { captchaToken } = req.body as { captchaToken?: string };
  if (!captchaToken) {
    res.status(400).json({ error: "captchaToken is required" });
    return;
  }

  const ok = await verifyCaptcha(captchaToken);
  if (!ok) {
    res.status(400).json({ error: "CAPTCHA verification failed" });
    return;
  }

  await db.update(usersTable)
    .set({ captchaVerified: true })
    .where(eq(usersTable.id, req.user.id));

  const sid = getSessionId(req);
  if (sid) {
    const session = await getSession(sid);
    if (session) {
      await updateSession(sid, { ...session, captchaVerified: true });
    }
  }

  res.json({ success: true });
});

// GET /api/users/me/spend — authenticated user's monthly spend history (computed at request time)
router.get("/users/me/spend", async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: "Authentication required" }); return; }

  const rows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      month: sql<number>`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      totalUsd: sql<string>`COALESCE(SUM(${userGenerationCostsTable.computedCostUsd}), 0)::text`,
    })
    .from(userGenerationCostsTable)
    .where(eq(userGenerationCostsTable.userId, req.user.id))
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

export default router;
