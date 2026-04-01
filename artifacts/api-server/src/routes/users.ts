import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  ratingsTable, searchHistoryTable, usersTable,
} from "@workspace/db/schema";
import { eq, desc, inArray, and } from "drizzle-orm";
import { RecordSearchBody } from "@workspace/api-zod";
import { getSessionId, getSession, updateSession } from "../lib/auth";

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

  const submittedRows = await db.select().from(factsTable).where(and(eq(factsTable.submittedById, userId), eq(factsTable.isActive, true))).orderBy(desc(factsTable.createdAt)).limit(50);
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

  const searchRows = await db.select({ query: searchHistoryTable.query })
    .from(searchHistoryTable).where(eq(searchHistoryTable.userId, userId))
    .orderBy(desc(searchHistoryTable.createdAt)).limit(20);

  const [submittedSummaries, likedSummaries] = await Promise.all([
    buildFactSummaries(submittedRows, userId),
    buildFactSummaries(likedFacts, userId),
  ]);

  res.json({
    id: req.user.id,
    email: req.user.email ?? null,
    firstName: req.user.firstName ?? null,
    lastName: req.user.lastName ?? null,
    profileImageUrl: req.user.profileImageUrl ?? null,
    submittedFacts: submittedSummaries,
    likedFacts: likedSummaries,
    favoriteHashtags,
    searchHistory: searchRows.map((r) => r.query),
  });
});

router.post("/users/me/search-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(204).end(); return; }
  const parsed = RecordSearchBody.safeParse(req.body);
  if (!parsed.success) { res.status(204).end(); return; }
  await db.insert(searchHistoryTable).values({ userId: req.user.id, query: parsed.data.query });
  res.status(204).end();
});

async function verifyCaptcha(token: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (!secret) {
    if (isProd) return false;
    return true;
  }
  try {
    const resp = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const data = (await resp.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

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

export default router;
