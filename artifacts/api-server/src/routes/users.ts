import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  ratingsTable, searchHistoryTable, usersTable, emailVerificationTokensTable,
} from "@workspace/db/schema";
import { eq, desc, inArray, and } from "drizzle-orm";
import { RecordSearchBody } from "@workspace/api-zod";
import { getSessionId, getSession, updateSession } from "../lib/auth";
import crypto from "crypto";
import { sendEmail, buildEmailChangeVerificationEmail } from "../lib/email";

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
      username: usersTable.username,
      pronouns: usersTable.pronouns,
      profileImageUrl: usersTable.profileImageUrl,
      emailVerifiedAt: usersTable.emailVerifiedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

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
    id: userId,
    email: userRow?.email ?? null,
    pendingEmail: userRow?.pendingEmail ?? null,
    emailVerified: userRow?.emailVerifiedAt !== null && userRow?.emailVerifiedAt !== undefined,
    firstName: userRow?.firstName ?? null,
    lastName: userRow?.lastName ?? null,
    username: userRow?.username ?? null,
    pronouns: userRow?.pronouns ?? null,
    profileImageUrl: userRow?.profileImageUrl ?? null,
    submittedFacts: submittedSummaries,
    likedFacts: likedSummaries,
    favoriteHashtags,
    searchHistory: searchRows.map((r) => r.query),
  });
});

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

router.patch("/users/me", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;

  const { firstName, lastName, username, pronouns, email } = req.body as {
    firstName?: string;
    lastName?: string;
    username?: string;
    pronouns?: string;
    email?: string;
  };

  const updates: Record<string, unknown> = {};

  if (firstName !== undefined) {
    const trimmed = typeof firstName === "string" ? firstName.trim() : "";
    if (!trimmed) { res.status(400).json({ error: "First name cannot be empty" }); return; }
    updates.firstName = trimmed;
  }

  if (lastName !== undefined) {
    const trimmed = typeof lastName === "string" ? lastName.trim() : "";
    if (!trimmed) { res.status(400).json({ error: "Last name cannot be empty" }); return; }
    updates.lastName = trimmed;
  }

  if (username !== undefined) {
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      res.status(400).json({ error: "Username must be 3–30 characters, letters, numbers, or underscores only" });
      return;
    }
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.username, username)))
      .limit(1);
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }
    updates.username = username;
  }

  if (pronouns !== undefined) {
    if (typeof pronouns !== "string" || pronouns.trim().length === 0) {
      res.status(400).json({ error: "Pronouns cannot be empty" });
      return;
    }
    if (pronouns.length > 20) {
      res.status(400).json({ error: "Pronouns must be 20 characters or fewer" });
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

    const domain = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost";
    const verifyUrl = `https://${domain}/verify-email?token=${rawToken}`;
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
