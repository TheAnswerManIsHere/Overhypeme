/**
 * @purpose The /users/me routes: profile read and update, notification settings, search history, uploads, own memes and AI images, upload deletion, setting the profile image, onboarding captcha completion, and spend.
 * @subsystem accounts-auth
 */
import { isRealAdminRequest } from "../lib/adminIdentity";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  reactionsTable, searchHistoryTable, usersTable, emailVerificationTokensTable,
  userGenerationCostsTable, uploadImageMetadataTable,
} from "@workspace/db/schema";
import { getViewerFactRatings, getViewerReactionTargetIds } from "../lib/reactions";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { z } from "zod";
import { GetMySubmissionCountsQueryParams, ListMySubmissionsQueryParams, RecordSearchBody } from "@workspace/api-zod";
import crypto from "crypto";
import { sendEmail, buildEmailChangeVerificationEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { ObjectNotFoundError } from "../lib/objectStorage";
import { isRetryableMediaError } from "../lib/mediaBackup/preserve";
import { sanitizeAndValidatePersonalName, sanitizeAndValidatePronouns } from "../lib/validators/personalName";
import { getConfigInt } from "../lib/adminConfig";
import { logger } from "../lib/logger";
import { profilePictureUrl } from "../lib/profilePicture";
import { makeProfilePhoto, PhotoNotAvailableError, removeProfilePhoto } from "../lib/profilePhoto";
import { liveContent, restoreWindowDays } from "../lib/contentVisibility";
import {
  deleteAiImage, deleteUpload, listAiImagesPage, listMemesPage, listRecentlyDeleted, listUploadsPage,
  purgeNow, restoreAiImage, restoreUpload, type ContentChangeResult,
} from "../lib/myContent";
import { effectiveTierExpr } from "../lib/membershipState";
import { countMySubmissions, listMySubmissions } from "../lib/mySubmissions";

const router: IRouter = Router();

/**
 * A profile photo's ACL change failed, so nothing was saved. A retryable media
 * error (its backup copy could not be made first) is 503 "try again shortly";
 * a missing object is the caller's bad path; anything else is 500.
 */
function respondProfileImageAclFailure(res: Response, err: unknown, route: string): void {
  logger.error({ err }, `[users] Failed to set ACL on profile image (${route})`);
  if (isRetryableMediaError(err)) {
    res.status(503).json({ error: "Your photo could not be updated right now. Please try again shortly." });
  } else if (err instanceof ObjectNotFoundError) {
    res.status(400).json({ error: "Invalid profile image URL" });
  } else {
    res.status(500).json({ error: "Failed to update profile image" });
  }
}

async function buildFactSummaries(facts: (typeof factsTable.$inferSelect)[], userId?: string) {
  if (!facts.length) return [];
  const ids = facts.map((f) => f.id);

  const fhRows = await db.select({ factId: factHashtagsTable.factId, name: hashtagsTable.name })
    .from(factHashtagsTable).innerJoin(hashtagsTable, eq(factHashtagsTable.hashtagId, hashtagsTable.id))
    .where(inArray(factHashtagsTable.factId, ids));
  const hMap = new Map<number, string[]>();
  for (const r of fhRows) { if (!hMap.has(r.factId)) hMap.set(r.factId, []); hMap.get(r.factId)!.push(r.name); }

  const rMap = userId ? await getViewerFactRatings(userId, ids) : new Map<number, string>();

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
      emailVerifiedAt: usersTable.emailVerifiedAt,
      // The effective tier. GET /users/me re-selects the raw column separately
      // from authMiddleware, so with the convergence sweep failing and a grace
      // horizon passed, authorization demoted the user while this screen kept
      // showing Legendary — the server reporting a tier it no longer honours,
      // on the screen the user would check first.
      membershipTier: effectiveTierExpr(),
      googleLinked: usersTable.googleLinked,
      appleLinked: usersTable.appleLinked,
      passwordHash: usersTable.passwordHash,
      isAdmin: usersTable.isAdmin,
      adminNotifications: usersTable.adminNotifications,
      disputeNotifications: usersTable.disputeNotifications,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const likedRatings = await db.select({ factId: reactionsTable.targetId }).from(reactionsTable)
    .where(and(
      eq(reactionsTable.userId, userId),
      eq(reactionsTable.targetType, "fact"),
      eq(reactionsTable.reactionType, "up"),
    ));
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

  const likedSummaries = await buildFactSummaries(likedFacts, userId);

  // The canonical real-admin resolution, not a re-read of the stored column.
  // An ADMIN_USER_IDS- or bootstrap-granted admin was previously unable to even
  // SEE their own admin notification preferences here, because this projection
  // only knew about mechanism 1 of 3.
  const isAdmin = isRealAdminRequest(req);

  res.json({
    id: userId,
    email: userRow?.email ?? null,
    pendingEmail: userRow?.pendingEmail ?? null,
    emailVerified: userRow?.emailVerifiedAt !== null && userRow?.emailVerifiedAt !== undefined,
    // Billing name fields (used for Stripe invoices)
    firstName: userRow?.firstName ?? null,
    lastName: userRow?.lastName ?? null,
    displayName: userRow?.displayName ?? null,
    pronouns: userRow?.pronouns ?? null,
    profileImageUrl: profilePictureUrl(userRow?.profileImageUrl),
    membershipTier: userRow?.membershipTier ?? "registered",
    linkedProviders: [
      ...(userRow?.googleLinked ? ["google"] : []),
      ...(userRow?.appleLinked ? ["apple"] : []),
    ],
    hasPassword: !!(userRow?.passwordHash),
    ...(isAdmin && {
      adminNotifications: userRow?.adminNotifications ?? true,
      disputeNotifications: userRow?.disputeNotifications ?? true,
    }),
    likedFacts: likedSummaries,
    favoriteHashtags,
    searchHistory: searchRows,
  });
});

// GET /users/me/submissions/counts — how many of the current user's
// submissions are in each status, per type, and with `q`, how many match.
// Counted by the same predicates the list below pages through (plan
// PLAN_LIBRARY_SUBMISSIONS.md), so a count and its list never disagree.
router.get("/users/me/submissions/counts", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = GetMySubmissionCountsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid search" }); return; }
  res.json(await countMySubmissions(req.user.id, parsed.data.q));
});

// GET /users/me/submissions — one page of the current user's submissions of
// one type (facts | comments) in one status (review | live | declined | gone),
// optionally matching `q`, newest or oldest first; `cursor` is the previous
// page's `nextCursor`. Only the signed-in user's own submissions, ever.
const MY_SUBMISSIONS_PAGE = 24;
const SUBMISSION_BLANKS = {
  hashtags: [] as string[], decidedAt: null, progress: null, reason: null, teamNote: null,
  fact: null, factId: null, factText: null, factLive: null, hidden: null,
};
router.get("/users/me/submissions", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = ListMySubmissionsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { type, status, q, sort, cursor } = parsed.data;
  const page = await listMySubmissions(req.user.id, {
    type, status, q, cursor, oldest: sort === "oldest", limit: MY_SUBMISSIONS_PAGE,
  });

  const liveRows = page.items.flatMap((i) => (i.kind === "fact" ? [i.row] : []));
  const summaries = new Map((await buildFactSummaries(liveRows, req.user.id)).map((s) => [s.id, s]));

  res.json({
    nextCursor: page.nextCursor,
    // The contract is one flat shape; the fields a kind does not carry are null.
    items: page.items.map((i) => {
      if (i.kind !== "fact") return { ...SUBMISSION_BLANKS, ...i };
      const { row, ...rest } = i;
      const fact = summaries.get(row.id) ?? null;
      return { ...SUBMISSION_BLANKS, ...rest, hashtags: fact?.hashtags ?? [], fact };
    }),
  });
});

router.patch("/users/me", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const { displayName, firstName, lastName, pronouns, email, profileImageUrl } = req.body as {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    pronouns?: string;
    email?: string;
    profileImageUrl?: unknown;
  };

  // The picture has one setter, POST /users/me/profile-image, which checks
  // the upload is the caller's, makes it public and moves the Profile marker
  // in one transaction (plan PLAN_PHOTO_IS_YOUR_PICTURE.md). A picture sent
  // here is refused, so the shown photo, the Profile-marked photo and the
  // deletion-protected photo can never disagree.
  if (profileImageUrl !== undefined) {
    res.status(400).json({ error: "Choose your picture from your photos (POST /users/me/profile-image)." });
    return;
  }

  const updates: Record<string, unknown> = {};

  if (displayName !== undefined) {
    const result = await sanitizeAndValidatePersonalName(displayName);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    updates.displayName = result.value;
  }

  // Billing name fields (used for Stripe invoices).
  // Same prompt-injection rules as displayName — these end up rendered into LLM
  // and image generation prompts as part of the user's identity.
  if (firstName !== undefined) {
    if (typeof firstName === "string" && firstName.trim() === "") {
      updates.firstName = null;
    } else {
      const result = await sanitizeAndValidatePersonalName(firstName);
      if (!result.ok) { res.status(400).json({ error: result.error }); return; }
      updates.firstName = result.value;
    }
  }

  if (lastName !== undefined) {
    if (typeof lastName === "string" && lastName.trim() === "") {
      updates.lastName = null;
    } else {
      const result = await sanitizeAndValidatePersonalName(lastName);
      if (!result.ok) { res.status(400).json({ error: result.error }); return; }
      updates.lastName = result.value;
    }
  }

  if (pronouns !== undefined) {
    const result = await sanitizeAndValidatePronouns(pronouns);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    updates.pronouns = result.value;
  }

  // nsfwModeEnabled is withdrawn (launch Phase 5, S13): ignored if sent.

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
    sendEmail({ to: emailNormalized, kind: "email_change_verification", ...emailContent }).catch((err) => {
      logger.error({ err }, "[users] Failed to send email change verification");
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

  // Same three-mechanism gap as the projection in GET /users/me: an env- or
  // bootstrap-granted admin could neither see nor change these settings.
  if (!isRealAdminRequest(req)) {
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

  // Filters: transform = 'raw' (raw uploads only — the default) or 'all' (no
  // filter). With 'all' the caller may also pass factId to scope to one fact.
  // The AI-styling filters went with PuLID (launch Phase 4, removal 3); its
  // historical rows stay and are reachable only through 'all'. One page of
  // `displayLimit` at a time; `cursor` is the previous page's `nextCursor`
  // (plan S18). Only live photos are listed (plan S2).
  const transform = req.query.transform === "all" ? "all" : "raw";
  const factIdParam = typeof req.query.factId === "string" ? parseInt(req.query.factId, 10) : NaN;
  const factId = Number.isFinite(factIdParam) ? factIdParam : null;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  const [page, maxUploads] = await Promise.all([
    listUploadsPage(req.user.id, { transform, factId, cursor, limit: displayLimit }),
    getConfigInt("user_max_images", 1000),
  ]);

  res.json({
    uploads: page.items,
    uploadCount: page.total,
    maxUploads,
    displayLimit,
    nextCursor: page.nextCursor,
  });
});

/**
 * POST /users/me/profile-image
 *
 * Task #507: re-tag an existing library upload as the user's profile photo.
 * In one transaction, clears `is_profile` on any prior row for this user,
 * sets `is_profile=true` on the target row (which must belong to this user),
 * updates `users.profileImageUrl` to the public storage URL, and re-asserts a
 * public ACL on the object. Idempotent — submitting the same objectPath again
 * is a no-op.
 */
router.post("/users/me/profile-image", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const body = req.body as { objectPath?: unknown };
  const objectPath = typeof body?.objectPath === "string" ? body.objectPath.trim() : "";
  if (!objectPath || !objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "objectPath is required and must start with /objects/" });
    return;
  }

  // Verify the upload row exists, is live and belongs to this user. A row
  // with no owner is no one's photo to take (#810), the same answer as
  // another member's; a deleted photo is not found until it is restored.
  const owner = await db.execute(sql`
    SELECT user_id FROM upload_image_metadata
    WHERE object_path = ${objectPath} AND ${liveContent(uploadImageMetadataTable)}
    LIMIT 1
  `);
  const ownerRow = owner.rows[0] as { user_id: string | null } | undefined;
  if (!ownerRow) {
    res.status(404).json({ error: "Upload not found" });
    return;
  }
  if (ownerRow.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  let newProfileImageUrl: string;
  try {
    newProfileImageUrl = await makeProfilePhoto(userId, objectPath);
  } catch (err) {
    // Taken down or deleted after the check above: the photo is no longer theirs to show.
    if (err instanceof PhotoNotAvailableError) { res.status(404).json({ error: "Upload not found" }); return; }
    respondProfileImageAclFailure(res, err, "POST /users/me/profile-image");
    return;
  }

  res.json({ success: true, profileImageUrl: newProfileImageUrl, objectPath });
});

/**
 * DELETE /users/me/profile-image — "Remove my picture" (plan
 * PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md, Q17). The member goes back to their
 * initial; their photos stay in their library; Google's picture is never
 * copied in again. Idempotent.
 */
router.delete("/users/me/profile-image", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  await removeProfilePhoto(req.user.id);
  res.json({ success: true, profileImageUrl: null });
});

// GET /users/me/memes — one page of the current user's live memes, newest
// first; `cursor` is the previous page's `nextCursor` (plan S18).
const MY_MEMES_PAGE = 48;
router.get("/users/me/memes", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const page = await listMemesPage(req.user.id, { cursor, limit: MY_MEMES_PAGE });

  const heartedIds = await getViewerReactionTargetIds(
    req.user.id,
    "meme",
    "heart",
    page.items.map((m) => m.id),
  );

  res.json({
    memes: page.items.map(m => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      originalWidth: m.originalWidth ?? null,
      originalHeight: m.originalHeight ?? null,
      uploadFileSizeBytes: m.uploadFileSizeBytes ?? null,
      heartCount: m.heartCount ?? 0,
      viewerHasHearted: heartedIds.has(m.id),
    })),
    nextCursor: page.nextCursor,
  });
});

// GET /users/me/ai-images — one page of the current user's own live generated
// images, newest first. Query params: factId (optional), imageType (optional,
// default 'reference'), cursor (the previous page's `nextCursor`).
const MY_AI_IMAGES_PAGE = 48;
router.get("/users/me/ai-images", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const factIdRaw = req.query["factId"];
  const factId = factIdRaw ? parseInt(String(factIdRaw), 10) : null;
  if (factIdRaw !== undefined && (factId === null || isNaN(factId))) {
    res.status(400).json({ error: "Invalid factId" }); return;
  }

  const imageType = String(req.query["imageType"] ?? "reference");
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const page = await listAiImagesPage(req.user.id, { imageType, factId, cursor, limit: MY_AI_IMAGES_PAGE });

  res.json({ images: page.items, nextCursor: page.nextCursor });
});

/** The answer for a delete or restore that found nothing to act on, or the profile photo. */
function respondContentChange(res: Response, result: ContentChangeResult, notFound: string): void {
  if (result === "ok") { res.json({ success: true }); return; }
  if (result === "profile_photo") {
    res.status(409).json({
      error: "This is your profile photo. Choose a different profile photo before deleting it.",
      code: "profile_photo",
    });
    return;
  }
  res.status(404).json({ error: notFound });
}

// DELETE /users/me/uploads — delete one of the current user's photos.
// Query param: path (the objectPath value from GET /users/me/uploads). It moves
// to Recently deleted for the restore window; the content purger removes it
// from storage after that (plan S2; jobs/contentPurger.ts).
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

  respondContentChange(res, await deleteUpload(req.user.id, objectPath), "Upload not found or does not belong to you");
});

// POST /users/me/uploads/restore — body { path }: undo a photo's delete inside the window.
router.post("/users/me/uploads/restore", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const objectPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!objectPath) { res.status(400).json({ error: "path is required" }); return; }
  respondContentChange(res, await restoreUpload(req.user.id, objectPath), "Nothing to restore");
});

// DELETE /users/me/ai-images/:id — delete one of the current user's own generated images.
router.delete("/users/me/ai-images/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isSafeInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  respondContentChange(res, await deleteAiImage(req.user.id, id), "Image not found or not yours");
});

// POST /users/me/ai-images/:id/restore — undo a generated image's delete inside the window.
router.post("/users/me/ai-images/:id/restore", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isSafeInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  respondContentChange(res, await restoreAiImage(req.user.id, id), "Nothing to restore");
});

// GET /users/me/recently-deleted — everything the current user deleted that is
// still restorable, newest deletion first, with when each will be removed.
router.get("/users/me/recently-deleted", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [list, restoreWindow] = await Promise.all([listRecentlyDeleted(req.user.id), restoreWindowDays()]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...list, restoreWindowDays: restoreWindow });
});

// POST /users/me/recently-deleted/purge — body { kind, key }: "Delete now".
// Ends one of the current user's deleted items' restore window at once; it
// leaves Recently deleted and the content purger removes it within the hour.
const PurgeNowBody = z.object({
  kind: z.enum(["photo", "generated", "meme"]),
  key: z.string().trim().min(1).max(512),
}).strict();
router.post("/users/me/recently-deleted/purge", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = PurgeNowBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "kind and key are required" }); return; }
  respondContentChange(res, await purgeNow(req.user.id, parsed.data), "Nothing to delete");
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
