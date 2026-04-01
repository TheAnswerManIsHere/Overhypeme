import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, usersTable, passwordResetTokensTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession, type SessionData } from "../lib/auth";
import { isAdminById } from "./auth";
import { sendEmail, buildPasswordResetEmail } from "../lib/email";

const router: IRouter = Router();

const SALT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Simple in-memory rate limiter for forgot-password: max 5 requests per IP per 15 minutes
const forgotPasswordAttempts = new Map<string, { count: number; resetAt: number }>();
const FORGOT_PASSWORD_MAX = 5;
const FORGOT_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

function checkForgotPasswordRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = forgotPasswordAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    forgotPasswordAttempts.set(ip, { count: 1, resetAt: now + FORGOT_PASSWORD_WINDOW_MS });
    return true;
  }
  if (entry.count >= FORGOT_PASSWORD_MAX) return false;
  entry.count += 1;
  return true;
}

function setSessionCookie(res: Response, sid: string) {
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
  res.cookie("sid", sid, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

router.post("/auth/register", async (req: Request, res: Response) => {
  const { username, password, email } = req.body as {
    username?: string;
    password?: string;
    email?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    res.status(400).json({
      error: "Username must be 3–30 characters, letters, numbers, or underscores only",
    });
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  if (password.length > 128) {
    res.status(400).json({ error: "Password must be 128 characters or fewer" });
    return;
  }

  if (email && typeof email === "string") {
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "Email is already in use" });
      return;
    }
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Username is already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      email: email || null,
      firstName: username,
      captchaVerified: false,
    })
    .returning();

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: false,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
});

router.post("/auth/local-login", async (req: Request, res: Response) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Invalid input types" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: user.captchaVerified,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
});

const GENERIC_RESET_MESSAGE = "If an account with that email exists and has a local password, you will receive a reset link shortly.";

router.post("/auth/forgot-password", async (req: Request, res: Response) => {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";

  if (!checkForgotPasswordRateLimit(ip)) {
    res.status(429).json({ message: GENERIC_RESET_MESSAGE });
    return;
  }

  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") {
    res.status(200).json({ message: GENERIC_RESET_MESSAGE });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()))
    .limit(1);

  // Silently skip if user not found or has no local password (Replit Auth users)
  if (!user || !user.passwordHash) {
    res.status(200).json({ message: GENERIC_RESET_MESSAGE });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost";
  const resetUrl = `https://${domain}/reset-password?token=${rawToken}`;

  const emailContent = buildPasswordResetEmail(resetUrl);
  await sendEmail({
    to: user.email!,
    ...emailContent,
  });

  res.status(200).json({ message: GENERIC_RESET_MESSAGE });
});

router.post("/auth/reset-password", async (req: Request, res: Response) => {
  const { token, newPassword } = req.body as { token?: string; newPassword?: string };

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Invalid or missing token" });
    return;
  }

  if (!newPassword || typeof newPassword !== "string") {
    res.status(400).json({ error: "New password is required" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  if (newPassword.length > 128) {
    res.status(400).json({ error: "Password must be 128 characters or fewer" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const [resetToken] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, tokenHash))
    .limit(1);

  if (!resetToken) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    return;
  }

  if (resetToken.usedAt !== null) {
    res.status(400).json({ error: "This reset link has already been used. Please request a new one." });
    return;
  }

  if (resetToken.expiresAt < new Date()) {
    res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, resetToken.userId));

  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokensTable.id, resetToken.id));

  // Invalidate all existing sessions for this user
  const userSessions = await db
    .select({ sid: sessionsTable.sid, sess: sessionsTable.sess })
    .from(sessionsTable);

  const userSessionIds = userSessions
    .filter((s) => {
      const sess = s.sess as { user?: { id?: string } };
      return sess?.user?.id === resetToken.userId;
    })
    .map((s) => s.sid);

  for (const sid of userSessionIds) {
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  }

  res.status(200).json({ message: "Password reset successfully. You can now log in with your new password." });
});

export default router;
