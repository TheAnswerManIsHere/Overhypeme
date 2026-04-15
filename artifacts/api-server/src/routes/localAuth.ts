import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, usersTable, passwordResetTokensTable, sessionsTable, emailVerificationTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createSession, type SessionData } from "../lib/auth";
import { isAdminById } from "./auth";
import { sendEmail, buildPasswordResetEmail, buildEmailVerificationEmail, buildEmailChangeVerificationEmail, getSiteBaseUrl } from "../lib/email";

const router: IRouter = Router();

const SALT_ROUNDS = 10;

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

// Rate limiter for resend-verification: max 3 requests per user per hour
const resendVerificationAttempts = new Map<string, { count: number; resetAt: number }>();
const RESEND_VERIFICATION_MAX = 3;
const RESEND_VERIFICATION_WINDOW_MS = 60 * 60 * 1000;

function checkResendVerificationRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = resendVerificationAttempts.get(userId);
  if (!entry || now > entry.resetAt) {
    resendVerificationAttempts.set(userId, { count: 1, resetAt: now + RESEND_VERIFICATION_WINDOW_MS });
    return true;
  }
  if (entry.count >= RESEND_VERIFICATION_MAX) return false;
  entry.count += 1;
  return true;
}

async function sendVerificationEmail(userId: string, email: string, pendingEmail?: string): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await db.insert(emailVerificationTokensTable).values({ userId, tokenHash, expiresAt, pendingEmail: pendingEmail ?? null });

  const verifyUrl = `${getSiteBaseUrl()}/verify-email?token=${rawToken}`;

  let emailContent;
  if (pendingEmail) {
    emailContent = buildEmailChangeVerificationEmail(pendingEmail, verifyUrl);
  } else {
    emailContent = buildEmailVerificationEmail(verifyUrl);
  }
  await sendEmail({ to: email, ...emailContent });
}

function setSessionCookie(res: Response, sid: string) {
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
  // SameSite=None; Secure is required for the Replit preview iframe context.
  res.cookie("sid", sid, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

router.post("/auth/register", async (req: Request, res: Response) => {
  const { password, email, displayName, pronouns, firstName, lastName } = req.body as {
    password?: string;
    email?: string;
    displayName?: string;
    pronouns?: string;
    firstName?: string;
    lastName?: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  if (typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required" });
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

  const displayNameTrimmed = typeof displayName === "string" ? displayName.trim() : "";

  if (!displayNameTrimmed) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }

  if (displayNameTrimmed.length > 100) {
    res.status(400).json({ error: "Display name must be 100 characters or fewer" });
    return;
  }

  const emailNormalized = (email && typeof email === "string") ? email.trim().toLowerCase() : null;

  if (emailNormalized) {
    const [existingEmail] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, emailNormalized))
      .limit(1);
    if (existingEmail) {
      res.status(409).json({ error: "Email is already in use" });
      return;
    }
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Sanitize pronouns: preset "he/him" style or pipe-delimited custom, max 80 chars
  let sanitizedPronouns: string | null = null;
  if (pronouns && typeof pronouns === "string" && pronouns.trim()) {
    sanitizedPronouns = pronouns.trim().slice(0, 80);
  }

  const firstNameTrimmed = typeof firstName === "string" ? firstName.trim().slice(0, 100) : null;
  const lastNameTrimmed  = typeof lastName  === "string" ? lastName.trim().slice(0, 100)  : null;

  const [user] = await db
    .insert(usersTable)
    .values({
      passwordHash,
      email: emailNormalized,
      displayName: displayNameTrimmed,
      firstName: firstNameTrimmed || null,
      lastName:  lastNameTrimmed  || null,
      pronouns: sanitizedPronouns,
      captchaVerified: false,
      isActive: true,
    })
    .returning();

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: false,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData, user.id);
  setSessionCookie(res, sid);

  // Fire verification email asynchronously — don't block registration
  if (emailNormalized) {
    sendVerificationEmail(user.id, emailNormalized).catch((err) => {
      console.error("[auth] Failed to send verification email:", err);
    });
  }

  res.status(201).json({
    sid,
    user: {
      id: user.id,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
});

router.post("/auth/local-login", async (req: Request, res: Response) => {
  const { email, password } = req.body as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Invalid input types" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.email, email.trim().toLowerCase()), eq(usersTable.isActive, true)))
    .limit(1);

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: user.captchaVerified,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData, user.id);
  setSessionCookie(res, sid);

  res.json({
    sid,
    user: {
      id: user.id,
      email: user.email,
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

  const resetUrl = `${getSiteBaseUrl()}/reset-password?token=${rawToken}`;

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

router.get("/auth/verify-email", async (req: Request, res: Response) => {
  const { token } = req.query as { token?: string };

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Invalid or missing token" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const [record] = await db
    .select()
    .from(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    res.status(400).json({ error: "This verification link is invalid or has expired." });
    return;
  }

  if (record.usedAt !== null) {
    res.status(200).json({ message: "Email already verified." });
    return;
  }

  if (record.expiresAt < new Date()) {
    res.status(400).json({ error: "This verification link has expired. Please request a new one." });
    return;
  }

  if (record.pendingEmail) {
    // Email change verification — promote pendingEmail to email
    await db
      .update(usersTable)
      .set({ email: record.pendingEmail, pendingEmail: null, emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, record.userId));
  } else {
    // New account email verification
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, record.userId));
  }

  await db
    .update(emailVerificationTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokensTable.id, record.id));

  res.status(200).json({ success: true, message: "Email verified successfully!" });
});

router.get("/auth/email-status", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db
    .select({ email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    email: user.email,
    verified: user.emailVerifiedAt !== null,
    verifiedAt: user.emailVerifiedAt,
  });
});

router.post("/auth/resend-verification", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const userId = req.user.id;

  if (!checkResendVerificationRateLimit(userId)) {
    res.status(429).json({ error: "Too many requests. Please wait before requesting another verification email." });
    return;
  }

  const [user] = await db
    .select({ email: usersTable.email, pendingEmail: usersTable.pendingEmail, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // If there's a pending email change, resend the change verification email
  if (user.pendingEmail) {
    sendVerificationEmail(userId, user.pendingEmail, user.pendingEmail).catch((err) => {
      console.error("[auth] Failed to resend email change verification:", err);
    });
    res.status(200).json({ message: "Verification email sent to your new address. Please check your inbox." });
    return;
  }

  if (user.emailVerifiedAt !== null) {
    res.status(200).json({ message: "Your email is already verified." });
    return;
  }

  if (!user.email) {
    res.status(400).json({ error: "No email address on file." });
    return;
  }

  sendVerificationEmail(userId, user.email).catch((err) => {
    console.error("[auth] Failed to resend verification email:", err);
  });

  res.status(200).json({ message: "Verification email sent. Please check your inbox." });
});

// ── Secret admin login ────────────────────────────────────────────────────────
// Dev: no credentials needed — triple-click the logo.
// Production: requires the correct ADMIN_API_KEY in the x-admin-key header.
router.post("/auth/dev-admin-login", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    const adminKey = process.env.ADMIN_API_KEY;
    const provided = req.headers["x-admin-key"];
    if (!adminKey || !provided || provided !== adminKey) {
      res.status(403).json({ error: "Invalid admin key" });
      return;
    }
  }

  const ADMIN_EMAIL = "david@davidcarlos.net";
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.email, ADMIN_EMAIL), eq(usersTable.isActive, true)))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Admin user not found" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
    access_token: "",
    captchaVerified: user.captchaVerified,
    isAdmin: user.isAdmin || isAdminById(user.id),
  };

  const sid = await createSession(sessionData, user.id);
  setSessionCookie(res, sid);
  res.json({ sid, user: { id: user.id, email: user.email } });
});

export default router;
