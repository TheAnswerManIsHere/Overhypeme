import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { factsTable, commentsTable } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and } from "drizzle-orm";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import { isAdminById } from "./auth";
import { backfillEmbeddings } from "../lib/embeddings";
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
      .where(eq(usersTable.id, req.user.id))
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
    db.select({ totalFacts: count() }).from(factsTable),
    db.select({ totalUsers: count() }).from(usersTable),
  ]);
  res.json({ totalFacts, totalUsers });
});

router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();

  const where = search
    ? sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.firstName} ilike ${`%${search}%`} OR ${usersTable.lastName} ilike ${`%${search}%`} OR ${usersTable.username} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`
    : undefined;

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
  if (body["firstName"] !== undefined) updates.firstName = body["firstName"] ? String(body["firstName"]) : null;
  if (body["lastName"] !== undefined) updates.lastName = body["lastName"] ? String(body["lastName"]) : null;
  if (body["email"] !== undefined) updates.email = body["email"] ? String(body["email"]) : null;
  if (body["username"] !== undefined) updates.username = body["username"] ? String(body["username"]) : null;
  if (body["membershipTier"] !== undefined && ["free", "premium"].includes(String(body["membershipTier"])))
    updates.membershipTier = String(body["membershipTier"]) as "free" | "premium";
  if (body["pronouns"] !== undefined && ["he/him", "she/her", "they/them"].includes(String(body["pronouns"])))
    updates.pronouns = String(body["pronouns"]);

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

router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  const password = body["password"] ? String(body["password"]) : null;
  const firstName = body["firstName"] ? String(body["firstName"]).trim() : null;
  const lastName = body["lastName"] ? String(body["lastName"]).trim() : null;
  const username = body["username"] ? String(body["username"]).trim().toLowerCase() : null;
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

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const [created] = await db
      .insert(usersTable)
      .values({ email, passwordHash, firstName, lastName, username, membershipTier, isAdmin })
      .returning();
    const { passwordHash: _omit, ...safeUser } = created;
    res.status(201).json({ success: true, user: safeUser });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      if (msg.includes("email")) {
        res.status(409).json({ error: "A user with that email already exists" });
      } else if (msg.includes("username")) {
        res.status(409).json({ error: "A user with that username already exists" });
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

  const where = search ? ilike(factsTable.text, `%${search}%`) : undefined;

  const [facts, [{ total }]] = await Promise.all([
    db.select().from(factsTable)
      .where(where)
      .orderBy(desc(factsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factsTable).where(where),
  ]);

  res.json({ facts, total, page, limit });
});

router.delete("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  await db.delete(factsTable).where(eq(factsTable.id, id));
  res.json({ success: true });
});

router.patch("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const { text, upvotes, downvotes, score, wilsonScore, commentCount, submittedById, parentId, useCase } = req.body as Record<string, unknown>;
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

  const [updated] = await db.update(factsTable).set(updates).where(eq(factsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json({ success: true, fact: updated });
});

// POST /admin/facts/:id/variants — create a variant linked to a root fact
router.post("/admin/facts/:id/variants", requireAdmin, async (req: Request, res: Response) => {
  const rootId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(rootId)) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [root] = await db.select({ id: factsTable.id, parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, rootId)).limit(1);
  if (!root) { res.status(404).json({ error: "Fact not found" }); return; }
  if (root.parentId !== null) { res.status(400).json({ error: "Cannot add a variant to a variant. Target the root fact." }); return; }
  const { text, useCase } = req.body as Record<string, unknown>;
  if (!text || typeof text !== "string" || text.trim().length === 0) { res.status(400).json({ error: "text is required" }); return; }
  const [variant] = await db.insert(factsTable).values({
    text: text.trim(),
    parentId: rootId,
    useCase: useCase ? String(useCase) : null,
  } as typeof factsTable.$inferInsert).returning();
  res.status(201).json({ success: true, variant });
});

// DELETE /admin/facts/variants/:variantId — delete a single variant
router.delete("/admin/facts/variants/:variantId", requireAdmin, async (req: Request, res: Response) => {
  const variantId = parseInt(String(req.params["variantId"] ?? ""), 10);
  if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variant id" }); return; }
  const [v] = await db.select({ id: factsTable.id, parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, variantId)).limit(1);
  if (!v) { res.status(404).json({ error: "Variant not found" }); return; }
  if (v.parentId === null) { res.status(400).json({ error: "Cannot delete a root fact via this endpoint." }); return; }
  await db.delete(factsTable).where(eq(factsTable.id, variantId));
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
    .values(texts.map((text) => ({ text })))
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
    .values(lines.map((text) => ({ text })))
    .returning();

  res.json({ success: true, imported: inserted.length });
});

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
    .where(eq(commentsTable.flagged, true))
    .orderBy(desc(commentsTable.createdAt))
    .limit(100);

  res.json({
    comments: rows.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
    })),
  });
});

router.post("/admin/comments/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [current] = await db
    .select({ factId: commentsTable.factId, wasFlagged: commentsTable.flagged })
    .from(commentsTable)
    .where(eq(commentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Comment not found" }); return; }
  await db.update(commentsTable).set({ flagged: false, flagReason: null }).where(eq(commentsTable.id, id));
  if (current.wasFlagged) {
    await db
      .update(factsTable)
      .set({ commentCount: sql`${factsTable.commentCount} + 1` })
      .where(eq(factsTable.id, current.factId));
  }
  res.json({ success: true });
});

router.delete("/admin/comments/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db
    .delete(commentsTable)
    .where(and(eq(commentsTable.id, id), eq(commentsTable.flagged, true)))
    .returning({ factId: commentsTable.factId });
  if (!deleted) {
    res.status(404).json({ error: "Flagged comment not found" });
    return;
  }
  res.json({ success: true });
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

router.post("/admin/facts/backfill-embeddings", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const result = await backfillEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[admin] Backfill embeddings error:", err);
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

export default router;
