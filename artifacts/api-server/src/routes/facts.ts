import { Router, type IRouter, type Request, type Response } from "express";
import { moderateComment, checkDuplicateInternal } from "./ai";
import { embedFactAsync } from "../lib/embeddings";
import { logActivity } from "../lib/activity";
import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  ratingsTable, commentsTable, externalLinksTable, usersTable,
} from "@workspace/db/schema";
import { stripeStorage } from "../lib/stripeStorage";
import { eq, sql, desc, asc, ilike, and, inArray, isNull } from "drizzle-orm";
import {
  ListFactsQueryParams, CreateFactBody, GetFactParams,
  RateFactParams, RateFactBody,
  ListCommentsParams, ListCommentsQueryParams, AddCommentParams, AddCommentBody,
  ListLinksParams, AddLinkParams, AddLinkBody, DeleteLinkParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function computeWilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const pHat = upvotes / n;
  const numerator = pHat + (z * z) / (2 * n) - z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return numerator / denominator;
}

async function verifyCaptcha(token: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      return false;
    }
    console.warn("[dev] HCAPTCHA_SECRET not set — bypassing CAPTCHA verification");
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

function detectPlatform(url: string): string | null {
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
  if (url.includes("tiktok.com")) return "TikTok";
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("vimeo.com")) return "Vimeo";
  if (url.includes("twitter.com") || url.includes("x.com")) return "X/Twitter";
  if (url.includes("facebook.com")) return "Facebook";
  return null;
}

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

  const sIds = [...new Set(facts.filter((f) => f.submittedById).map((f) => f.submittedById!))];
  const sMap = new Map<string, { firstName: string | null; profileImageUrl: string | null }>();
  if (sIds.length) {
    const rows = await db.select({ id: usersTable.id, firstName: usersTable.firstName, profileImageUrl: usersTable.profileImageUrl })
      .from(usersTable).where(inArray(usersTable.id, sIds));
    for (const r of rows) sMap.set(r.id, r);
  }

  return facts.map((f) => ({
    id: f.id, text: f.text, upvotes: f.upvotes, downvotes: f.downvotes, score: f.score, wilsonScore: f.wilsonScore,
    commentCount: f.commentCount, hashtags: hMap.get(f.id) ?? [],
    submittedBy: f.submittedById ? (sMap.get(f.submittedById)?.firstName ?? null) : null,
    submittedByImage: f.submittedById ? (sMap.get(f.submittedById)?.profileImageUrl ?? null) : null,
    userRating: userId ? (rMap.get(f.id) ?? null) : null,
    createdAt: f.createdAt.toISOString(),
  }));
}

// GET /facts
router.get("/facts", async (req: Request, res: Response) => {
  const parsed = ListFactsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query params" }); return; }
  const { search, hashtag, sort, limit, offset } = parsed.data;
  const conds = [];

  if (search) conds.push(ilike(factsTable.text, `%${search}%`));

  if (hashtag) {
    const [ht] = await db.select({ id: hashtagsTable.id }).from(hashtagsTable).where(eq(hashtagsTable.name, hashtag)).limit(1);
    if (!ht) { res.json({ facts: [], total: 0 }); return; }
    const fIds = (await db.select({ factId: factHashtagsTable.factId }).from(factHashtagsTable).where(eq(factHashtagsTable.hashtagId, ht.id))).map((r) => r.factId);
    if (!fIds.length) { res.json({ facts: [], total: 0 }); return; }
    conds.push(inArray(factsTable.id, fIds));
  }

  conds.push(isNull(factsTable.parentId));
  const where = and(...conds);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(factsTable).where(where);
  const order = sort === "newest" ? desc(factsTable.createdAt) : sort === "trending" ? desc(factsTable.commentCount) : desc(factsTable.wilsonScore);
  const rows = await db.select().from(factsTable).where(where).orderBy(order).limit(limit).offset(offset);
  res.json({ facts: await buildFactSummaries(rows, req.user?.id), total: count });
});

// GET /facts/:factId
router.get("/facts/:factId", async (req: Request, res: Response) => {
  const parsed = GetFactParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, parsed.data.factId)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  const [{ rank }] = await db.select({ rank: sql<number>`(count(*) + 1)::int` }).from(factsTable).where(sql`${factsTable.wilsonScore} > ${fact.wilsonScore}`);
  const [summary] = await buildFactSummaries([fact], req.user?.id);
  const linkRows = await db.select().from(externalLinksTable).where(eq(externalLinksTable.factId, fact.id)).orderBy(desc(externalLinksTable.createdAt));
  const links = await Promise.all(linkRows.map(async (l) => {
    let addedBy = null;
    if (l.addedById) {
      const [u] = await db.select({ firstName: usersTable.firstName }).from(usersTable).where(eq(usersTable.id, l.addedById)).limit(1);
      addedBy = u?.firstName ?? null;
    }
    return { id: l.id, factId: l.factId, url: l.url, title: l.title ?? null, platform: l.platform ?? null, addedBy, addedById: l.addedById ?? null, createdAt: l.createdAt.toISOString() };
  }));
  // Fetch variants (children) — always from the canonical root
  const rootId = fact.parentId ?? fact.id;
  const variantRows = await db.select({
    id: factsTable.id, text: factsTable.text, useCase: factsTable.useCase,
    createdAt: factsTable.createdAt, parentId: factsTable.parentId,
  }).from(factsTable).where(eq(factsTable.parentId, rootId)).orderBy(asc(factsTable.useCase));
  const variants = variantRows.map(v => ({
    id: v.id, text: v.text, useCase: v.useCase ?? null, createdAt: v.createdAt.toISOString(),
  }));
  res.json({ ...summary, rank, links, variants, parentId: fact.parentId ?? null, useCase: fact.useCase ?? null });
});

// POST /facts
router.post("/facts", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = CreateFactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() }); return; }
  const { text, hashtags = [], captchaToken, skipDuplicateCheck } = parsed.data;

  // Premium members bypass CAPTCHA
  const membershipTier = await stripeStorage.getMembershipTierForUser(req.user.id);
  if (membershipTier !== "premium") {
    if (!captchaToken || !(await verifyCaptcha(captchaToken))) {
      res.status(400).json({ error: "CAPTCHA verification failed" });
      return;
    }
  }

  if (!skipDuplicateCheck) {
    try {
      const dupResult = await checkDuplicateInternal(text);
      if (dupResult.isDuplicate) {
        res.status(409).json({
          error: "Possible duplicate detected. Set skipDuplicateCheck to true to submit anyway.",
          isDuplicate: true,
          confidence: dupResult.confidence,
          matchingFactId: dupResult.matchingFactId,
          matchingFactText: dupResult.matchingFactText,
        });
        return;
      }
    } catch (err) {
      // Duplicate check failed (e.g. embedding API unavailable) — allow submission
      console.warn("[facts] Duplicate check skipped:", (err as Error).message);
    }
  }

  const tokenizedText = text
    .replace(/\{First_Name\}\s*\{Last_Name\}/g, "{Name}")
    .replace(/\bchuck norris\b/gi, "{Name}");
  const [fact] = await db.insert(factsTable).values({ text: tokenizedText, submittedById: req.user.id }).returning();

  // Generate and persist the pgvector embedding in the background (non-blocking)
  void embedFactAsync(fact.id, fact.text);

  // Log to activity feed
  void logActivity({
    userId: req.user.id,
    actionType: "fact_submitted",
    message: `You submitted a new fact to the database.`,
    metadata: { factId: fact.id, text: text.slice(0, 120) },
  });

  if (hashtags.length) {
    for (const tag of hashtags) {
      const name = tag.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!name) continue;
      let [ht] = await db.select().from(hashtagsTable).where(eq(hashtagsTable.name, name)).limit(1);
      if (!ht) {
        [ht] = await db.insert(hashtagsTable).values({ name }).returning();
      }
      const [joined] = await db.insert(factHashtagsTable).values({ factId: fact.id, hashtagId: ht.id }).onConflictDoNothing().returning();
      if (joined) {
        await db.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, ht.id));
      }
    }
  }

  const [summary] = await buildFactSummaries([fact], req.user.id);
  res.status(201).json({ ...summary, links: [] });
});

// POST /facts/:factId/rating
router.post("/facts/:factId/rating", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const paramsParsed = RateFactParams.safeParse(req.params);
  const bodyParsed = RateFactBody.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) { res.status(400).json({ error: "Invalid input" }); return; }

  const factId = paramsParsed.data.factId;
  const userId = req.user.id;
  const { rating } = bodyParsed.data;

  const [factExists] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!factExists) { res.status(404).json({ error: "Fact not found" }); return; }

  const [existing] = await db.select().from(ratingsTable).where(and(eq(ratingsTable.factId, factId), eq(ratingsTable.userId, userId))).limit(1);

  if (rating === "none") {
    if (existing) {
      await db.delete(ratingsTable).where(and(eq(ratingsTable.factId, factId), eq(ratingsTable.userId, userId)));
      if (existing.rating === "up") {
        await db.update(factsTable).set({ upvotes: sql`${factsTable.upvotes} - 1`, score: sql`${factsTable.score} - 1` }).where(eq(factsTable.id, factId));
      } else {
        await db.update(factsTable).set({ downvotes: sql`${factsTable.downvotes} - 1`, score: sql`${factsTable.score} + 1` }).where(eq(factsTable.id, factId));
      }
    }
  } else {
    if (!existing) {
      await db.insert(ratingsTable).values({ factId, userId, rating });
      if (rating === "up") {
        await db.update(factsTable).set({ upvotes: sql`${factsTable.upvotes} + 1`, score: sql`${factsTable.score} + 1` }).where(eq(factsTable.id, factId));
      } else {
        await db.update(factsTable).set({ downvotes: sql`${factsTable.downvotes} + 1`, score: sql`${factsTable.score} - 1` }).where(eq(factsTable.id, factId));
      }
    } else if (existing.rating !== rating) {
      await db.update(ratingsTable).set({ rating }).where(and(eq(ratingsTable.factId, factId), eq(ratingsTable.userId, userId)));
      if (rating === "up") {
        await db.update(factsTable).set({ upvotes: sql`${factsTable.upvotes} + 1`, downvotes: sql`${factsTable.downvotes} - 1`, score: sql`${factsTable.score} + 2` }).where(eq(factsTable.id, factId));
      } else {
        await db.update(factsTable).set({ downvotes: sql`${factsTable.downvotes} + 1`, upvotes: sql`${factsTable.upvotes} - 1`, score: sql`${factsTable.score} - 2` }).where(eq(factsTable.id, factId));
      }
    }
  }

  const [updated] = await db.select({ upvotes: factsTable.upvotes, downvotes: factsTable.downvotes }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  const wilsonScore = computeWilsonScore(updated.upvotes, updated.downvotes);
  await db.update(factsTable).set({ wilsonScore }).where(eq(factsTable.id, factId));

  const [newRating] = await db.select({ rating: ratingsTable.rating }).from(ratingsTable).where(and(eq(ratingsTable.factId, factId), eq(ratingsTable.userId, userId))).limit(1);
  res.json({ upvotes: updated.upvotes, downvotes: updated.downvotes, userRating: newRating?.rating ?? null });
});

// GET /facts/:factId/comments
router.get("/facts/:factId/comments", async (req: Request, res: Response) => {
  const paramsParsed = ListCommentsParams.safeParse(req.params);
  const queryParsed = ListCommentsQueryParams.safeParse(req.query);
  if (!paramsParsed.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const factId = paramsParsed.data.factId;
  const limit = queryParsed.success ? (queryParsed.data.limit ?? 20) : 20;
  const offset = queryParsed.success ? (queryParsed.data.offset ?? 0) : 0;

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(commentsTable)
    .where(and(eq(commentsTable.factId, factId), eq(commentsTable.flagged, false)));

  const rows = await db.select().from(commentsTable)
    .where(and(eq(commentsTable.factId, factId), eq(commentsTable.flagged, false)))
    .orderBy(asc(commentsTable.createdAt)).limit(limit).offset(offset);

  const authorIds = [...new Set(rows.filter((r) => r.authorId).map((r) => r.authorId!))];
  const aMap = new Map<string, { firstName: string | null; profileImageUrl: string | null }>();
  if (authorIds.length) {
    const users = await db.select({ id: usersTable.id, firstName: usersTable.firstName, profileImageUrl: usersTable.profileImageUrl })
      .from(usersTable).where(inArray(usersTable.id, authorIds));
    for (const u of users) aMap.set(u.id, u);
  }

  const comments = rows.map((c) => ({
    id: c.id, factId: c.factId, text: c.text,
    authorId: c.authorId ?? null,
    authorName: c.authorId ? (aMap.get(c.authorId)?.firstName ?? null) : null,
    authorImage: c.authorId ? (aMap.get(c.authorId)?.profileImageUrl ?? null) : null,
    createdAt: c.createdAt.toISOString(),
  }));
  res.json({ comments, total: count });
});

// POST /facts/:factId/comments
router.post("/facts/:factId/comments", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const paramsParsed = AddCommentParams.safeParse(req.params);
  const bodyParsed = AddCommentBody.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const factId = paramsParsed.data.factId;
  const { text, captchaToken } = bodyParsed.data;

  const [factExists] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!factExists) { res.status(404).json({ error: "Fact not found" }); return; }

  // Premium members bypass CAPTCHA for comments
  const commentMembershipTier = await stripeStorage.getMembershipTierForUser(req.user.id);
  if (commentMembershipTier !== "premium") {
    if (!captchaToken || !(await verifyCaptcha(captchaToken))) {
      res.status(400).json({ error: "CAPTCHA verification failed" });
      return;
    }
  }

  const [comment] = await db.insert(commentsTable).values({ factId, authorId: req.user.id, text }).returning();
  await db.update(factsTable).set({ commentCount: sql`${factsTable.commentCount} + 1` }).where(eq(factsTable.id, factId));

  res.status(201).json({
    id: comment.id, factId: comment.factId, text: comment.text,
    authorId: req.user.id, authorName: req.user.firstName ?? null,
    authorImage: req.user.profileImageUrl ?? null,
    createdAt: comment.createdAt.toISOString(),
  });

  moderateComment(comment.id, text).catch(() => {});
});

// GET /facts/:factId/links
router.get("/facts/:factId/links", async (req: Request, res: Response) => {
  const parsed = ListLinksParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const rows = await db.select().from(externalLinksTable).where(eq(externalLinksTable.factId, parsed.data.factId)).orderBy(desc(externalLinksTable.createdAt));
  const links = rows.map((l) => ({ id: l.id, factId: l.factId, url: l.url, title: l.title ?? null, platform: l.platform ?? null, addedBy: null, createdAt: l.createdAt.toISOString() }));
  res.json({ links });
});

// POST /facts/:factId/links
router.post("/facts/:factId/links", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const paramsParsed = AddLinkParams.safeParse(req.params);
  const bodyParsed = AddLinkBody.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const factId = paramsParsed.data.factId;
  const { url, title } = bodyParsed.data;
  const platform = detectPlatform(url);
  const [link] = await db.insert(externalLinksTable).values({ factId, url, title: title ?? null, platform, addedById: req.user.id }).returning();
  res.status(201).json({ id: link.id, factId: link.factId, url: link.url, title: link.title ?? null, platform: link.platform ?? null, addedBy: req.user.firstName ?? null, addedById: req.user.id, createdAt: link.createdAt.toISOString() });
});

// DELETE /facts/:factId/links/:linkId
router.delete("/facts/:factId/links/:linkId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = DeleteLinkParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { factId, linkId } = parsed.data;
  const [link] = await db.select().from(externalLinksTable).where(and(eq(externalLinksTable.id, linkId), eq(externalLinksTable.factId, factId))).limit(1);
  if (!link) { res.status(404).json({ error: "Link not found" }); return; }
  if (link.addedById !== req.user.id) { res.status(403).json({ error: "Forbidden" }); return; }
  await db.delete(externalLinksTable).where(eq(externalLinksTable.id, linkId));
  res.status(204).send();
});

export default router;
