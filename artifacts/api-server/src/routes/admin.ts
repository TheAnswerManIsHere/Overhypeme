import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { factsTable, commentsTable } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and } from "drizzle-orm";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import { isAdminById } from "./auth";

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
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

  const [users, [{ total }]] = await Promise.all([
    db.select().from(usersTable).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(usersTable),
  ]);

  res.json({ users, total, page, limit });
});

router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const { isAdmin } = req.body as { isAdmin?: boolean };

  if (typeof isAdmin !== "boolean") {
    res.status(400).json({ error: "isAdmin must be a boolean" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ isAdmin })
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ success: true, user: updated });
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

export default router;
