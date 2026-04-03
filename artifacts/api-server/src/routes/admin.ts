import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { factsTable, commentsTable } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and, or, inArray, isNull } from "drizzle-orm";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import { isAdminById } from "./auth";
import { backfillEmbeddings } from "../lib/embeddings";
import { runFactImagePipeline } from "../lib/factImagePipeline";
import { generateAiMemeBackgrounds, type AiScenePrompts, type AiMemeImages } from "../lib/aiMemePipeline";
import { logActivity } from "../lib/activity";
import bcrypt from "bcryptjs";

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
      .select({ isAdmin: usersTable.isAdmin })
      .from(usersTable)
      .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
      .limit(1);
    if (!dbUser?.isAdmin) {
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

  const activeFilter = eq(usersTable.isActive, true);
  const where = search
    ? and(activeFilter, sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.displayName} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`)
    : activeFilter;

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
  if (typeof body["isAdmin"] === "boolean") updates.isAdmin = body["isAdmin"];
  if (typeof body["captchaVerified"] === "boolean") updates.captchaVerified = body["captchaVerified"];
  if (body["displayName"] !== undefined) updates.displayName = body["displayName"] ? String(body["displayName"]) : null;
  if (body["email"] !== undefined) updates.email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  if (body["membershipTier"] !== undefined && ["free", "premium"].includes(String(body["membershipTier"])))
    updates.membershipTier = String(body["membershipTier"]) as "free" | "premium";
  if (body["pronouns"] !== undefined) {
    const p = String(body["pronouns"]).trim();
    if (p.length > 0 && p.length <= 80) updates.pronouns = p;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
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

router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const hard = req.query["hard"] === "true";

  if (hard) {
    const [deleted] = await db.delete(usersTable).where(eq(usersTable.id, id)).returning({ id: usersTable.id });
    if (!deleted) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ success: true, deleted: true });
  } else {
    const [updated] = await db.update(usersTable).set({ isActive: false }).where(and(eq(usersTable.id, id), eq(usersTable.isActive, true))).returning({ id: usersTable.id });
    if (!updated) { res.status(404).json({ error: "User not found or already inactive" }); return; }
    res.json({ success: true, deleted: false });
  }
});

router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  const password = body["password"] ? String(body["password"]) : null;
  const displayName = body["displayName"] ? String(body["displayName"]).trim() : null;
  const membershipTier = ["free", "premium"].includes(String(body["membershipTier"] ?? "free"))
    ? (String(body["membershipTier"] ?? "free") as "free" | "premium")
    : "free";
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

// POST /admin/facts/:id/refresh-images — manually re-run the image pipeline for one fact
router.post("/admin/facts/:id/refresh-images", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [fact] = await db.select({ id: factsTable.id, text: factsTable.text, parentId: factsTable.parentId })
    .from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (fact.parentId !== null) { res.status(400).json({ error: "Images are only stored on root facts, not variants." }); return; }
  void runFactImagePipeline(fact.id, fact.text);
  res.json({ success: true, message: "Image pipeline started. Results will appear shortly." });
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
        await generateAiMemeBackgrounds(fact.id, fact.text);
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

export default router;
