import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, usersTable, passwordResetTokensTable, sessionsTable, emailVerificationTokensTable } from "@workspace/db";
import { eq, and, or, sql } from "drizzle-orm";
import { createSession, updateSession, getSessionId, type SessionData } from "../lib/auth";
import { isAdminById } from "./auth";
import { sendEmail, buildPasswordResetEmail, buildEmailVerificationEmail, buildEmailChangeVerificationEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { logger } from "../lib/logger";
import { sanitizeAndValidatePersonalName, sanitizeAndValidatePronouns } from "../lib/validators/personalName";

const router: IRouter = Router();

// bcrypt cost. Production uses 10 rounds (~70ms/hash). Tests can override
// with BCRYPT_SALT_ROUNDS to keep auth-test wall time low — 4 rounds runs
// in ~1ms while still exercising the same hash/compare code path. Clamped
// to bcrypt's supported range [4, 31].
const SALT_ROUNDS = (() => {
  const fromEnv = Number(process.env.BCRYPT_SALT_ROUNDS);
  if (Number.isInteger(fromEnv) && fromEnv >= 4 && fromEnv <= 31) {
    return fromEnv;
  }
  return 10;
})();

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const FORGOT_PASSWORD_MAX = 5;
const FORGOT_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

const RESEND_VERIFICATION_MAX = 3;
const RESEND_VERIFICATION_WINDOW_MS = 60 * 60 * 1000;

// App-level login/register throttles — defense-in-depth behind Cloudflare's edge
// rate limiting. Login is limited per-IP (single-source brute force) AND
// per-email (distributed credential stuffing / a targeted account); register is
// limited per-IP (signup spam). Thresholds are deliberately generous so a
// fumbling legitimate user is not locked out while automated abuse is bounded.
const LOGIN_IP_MAX = 10;
const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_MAX = 30;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_IP_MAX = 10;
const REGISTER_IP_WINDOW_MS = 60 * 60 * 1000;
// Generic throttle copy — never reveals whether an account exists.
const GENERIC_THROTTLE_MESSAGE = "Too many attempts. Please try again in a few minutes.";

// Best-effort client IP for app-level rate limiting. Mirrors the existing
// forgot-password extraction; the edge (Cloudflare) is the authoritative
// per-IP control, this is a second layer at the origin.
function getRequestIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
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
  const registerIpLimit = await checkSharedRateLimit(
    { endpoint: "auth.register", ip: getRequestIp(req) },
    { limit: REGISTER_IP_MAX, windowMs: REGISTER_IP_WINDOW_MS },
  );
  if (!registerIpLimit.allowed) {
    res.status(429).json({ error: GENERIC_THROTTLE_MESSAGE });
    return;
  }

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

  const displayNameResult = await sanitizeAndValidatePersonalName(displayName);
  if (!displayNameResult.ok) {
    res.status(400).json({ error: displayNameResult.error });
    return;
  }
  const displayNameTrimmed = displayNameResult.value;

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

  let sanitizedPronouns: string | null = null;
  if (pronouns && typeof pronouns === "string" && pronouns.trim()) {
    const pronounsResult = await sanitizeAndValidatePronouns(pronouns);
    if (!pronounsResult.ok) {
      res.status(400).json({ error: pronounsResult.error });
      return;
    }
    sanitizedPronouns = pronounsResult.value;
  }

  if (typeof firstName !== "string" || firstName.trim() === "") {
    return res.status(400).json({ error: "First Name is required." });
  }
  if (typeof lastName !== "string" || lastName.trim() === "") {
    return res.status(400).json({ error: "Last Name is required." });
  }
  const firstNameResult = await sanitizeAndValidatePersonalName(firstName);
  if (!firstNameResult.ok) {
    return res.status(400).json({ error: firstNameResult.error });
  }
  const lastNameResult = await sanitizeAndValidatePersonalName(lastName);
  if (!lastNameResult.ok) {
    return res.status(400).json({ error: lastNameResult.error });
  }
  const firstNameTrimmed = firstNameResult.value;
  const lastNameTrimmed = lastNameResult.value;

  const [user] = await db
    .insert(usersTable)
    .values({
      passwordHash,
      email: emailNormalized,
      displayName: displayNameTrimmed,
      firstName: firstNameTrimmed,
      lastName:  lastNameTrimmed,
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
      logger.error({ err }, "[auth] Failed to send verification email");
    });
  }

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      membershipTier: user.membershipTier,
    },
  });
  return;
});

router.post("/auth/local-login", async (req: Request, res: Response) => {
  const loginIpLimit = await checkSharedRateLimit(
    { endpoint: "auth.local-login", ip: getRequestIp(req) },
    { limit: LOGIN_IP_MAX, windowMs: LOGIN_IP_WINDOW_MS },
  );
  if (!loginIpLimit.allowed) {
    res.status(429).json({ error: GENERIC_THROTTLE_MESSAGE });
    return;
  }

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

  const normalizedEmail = email.trim().toLowerCase();

  // Per-account throttle (distributed stuffing / a targeted account). Keyed by
  // email, so it is independent of the per-IP limit above.
  const loginEmailLimit = await checkSharedRateLimit(
    { endpoint: "auth.local-login", recipientEmail: normalizedEmail },
    { limit: LOGIN_EMAIL_MAX, windowMs: LOGIN_EMAIL_WINDOW_MS },
  );
  if (!loginEmailLimit.allowed) {
    res.status(429).json({ error: GENERIC_THROTTLE_MESSAGE });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.email, normalizedEmail), eq(usersTable.isActive, true)))
    .limit(1);

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  if (!user.passwordHash) {
    const linkedNames: string[] = [];
    if (user.googleLinked) linkedNames.push("Google");
    if (user.appleLinked) linkedNames.push("Apple");
    if (linkedNames.length > 0) {
      const methods = linkedNames.map((n) => `"Continue with ${n}"`).join(" or ");
      res.status(401).json({ error: `This account uses ${linkedNames.join(" and ")} sign-in. Please click ${methods} to log in.` });
    } else {
      res.status(401).json({ error: "This account does not have a password set. Please use your social sign-in method." });
    }
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
  const { email } = req.body as { email?: string };
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";

  const forgotLimit = await checkSharedRateLimit(
    { endpoint: "auth.forgot-password", ip },
    { limit: FORGOT_PASSWORD_MAX, windowMs: FORGOT_PASSWORD_WINDOW_MS },
  );

  if (!forgotLimit.allowed) {
    res.status(429).json({ message: GENERIC_RESET_MESSAGE });
    return;
  }

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

  // Invalidate all existing sessions for this user in a single DB-side delete.
  // Match the indexed `userId` column (the common case) and, for defense in
  // depth, legacy rows written before that column was populated (their user id
  // lives only in the jsonb `sess.user.id`). This replaces the previous pattern
  // of pulling the entire sessions table into app memory and filtering there.
  await db
    .delete(sessionsTable)
    .where(
      or(
        eq(sessionsTable.userId, resetToken.userId),
        sql`${sessionsTable.sess} -> 'user' ->> 'id' = ${resetToken.userId}`,
      ),
    );

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

  // Fetch the updated user so we can establish a session
  const [verifiedUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, record.userId))
    .limit(1);

  if (verifiedUser) {
    const sessionData: SessionData = {
      user: {
        id: verifiedUser.id,
        email: verifiedUser.email,
        profileImageUrl: verifiedUser.profileImageUrl,
        membershipTier: verifiedUser.membershipTier,
      },
      access_token: "",
      captchaVerified: verifiedUser.captchaVerified,
      isAdmin: verifiedUser.isAdmin || isAdminById(verifiedUser.id),
    };

    if (record.pendingEmail) {
      // Email change: user is already logged in — just update their existing session
      const existingSid = getSessionId(req);
      if (existingSid) {
        await updateSession(existingSid, sessionData);
      } else {
        const sid = await createSession(sessionData, verifiedUser.id);
        setSessionCookie(res, sid);
      }
    } else {
      // New account: create a fresh session so the user is immediately logged in
      const sid = await createSession(sessionData, verifiedUser.id);
      setSessionCookie(res, sid);
    }
  }

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

  const resendLimit = await checkSharedRateLimit(
    { endpoint: "auth.resend-verification", userId, recipientEmail: req.user.email ?? null },
    { limit: RESEND_VERIFICATION_MAX, windowMs: RESEND_VERIFICATION_WINDOW_MS },
  );

  if (!resendLimit.allowed) {
    res.status(429).json({ error: "Too many resend attempts. Try again later." });
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
      logger.error({ err }, "[auth] Failed to resend email change verification");
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
    logger.error({ err }, "[auth] Failed to resend verification email");
  });

  res.status(200).json({ message: "Verification email sent. Please check your inbox." });
});

// ── Set / change password (authenticated) ────────────────────────────────────
// Works for both OAuth-only users (no current password required) and
// email/password users who want to change their password (current password required).
router.post("/auth/set-password", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

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

  const [user] = await db
    .select({ passwordHash: usersTable.passwordHash })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // If the user already has a password, require the current one for verification
  if (user.passwordHash) {
    if (!currentPassword || typeof currentPassword !== "string") {
      res.status(400).json({ error: "Current password is required to set a new one" });
      return;
    }
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db
    .update(usersTable)
    .set({ passwordHash: newHash })
    .where(eq(usersTable.id, req.user.id));

  res.status(200).json({ message: "Password updated successfully." });
});

// ── Unlink OAuth provider ─────────────────────────────────────────────────────
// Only allowed when the user has at least one remaining sign-in method
// (password or another linked provider) to prevent account lockout.
router.delete("/auth/unlink-provider", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const provider = (req.body as { provider?: string } | null | undefined)?.provider;
  if (provider !== "google" && provider !== "apple") {
    res.status(400).json({ error: "provider must be \"google\" or \"apple\"" });
    return;
  }

  const [user] = await db
    .select({
      passwordHash: usersTable.passwordHash,
      googleLinked: usersTable.googleLinked,
      appleLinked: usersTable.appleLinked,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const isLinked = provider === "google" ? user.googleLinked : user.appleLinked;
  if (!isLinked) {
    res.status(400).json({ error: "No linked social account to remove" });
    return;
  }

  // Prevent lockout: user must have another auth method remaining after unlink.
  const otherProviderLinked = provider === "google" ? user.appleLinked : user.googleLinked;
  if (!user.passwordHash && !otherProviderLinked) {
    res.status(400).json({ error: "You must set a password or link another provider before unlinking your only social account." });
    return;
  }

  const updates: Record<string, unknown> = provider === "google"
    ? { googleLinked: false }
    : { appleLinked: false };

  await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.user.id));

  res.status(200).json({ message: "Sign-in method unlinked successfully." });
});

// ── Secret admin login ────────────────────────────────────────────────────────
// Triple-tap the wordmark to instantly switch into the admin account.
//
// Strategy: mutate the caller's EXISTING session in-place so the browser's
// current sid cookie keeps working without having to store any new cookie.
// This bypasses every cookie-storage edge-case (iframe third-party blocking,
// Replit proxy redirect handling, SameSite restrictions, etc.).
// If the caller has no session yet, a fresh one is created and the cookie set.
async function handleDevAdminLogin(req: Request, res: Response) {
  const ADMIN_EMAIL = "overhypeme+admin@gmail.com";
  const [adminUser] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.email, ADMIN_EMAIL), eq(usersTable.isActive, true)))
    .limit(1);

  if (!adminUser) {
    res.status(404).json({ error: "Admin user not found" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: adminUser.id,
      email: adminUser.email,
      profileImageUrl: adminUser.profileImageUrl,
      membershipTier: adminUser.membershipTier,
    },
    access_token: "",
    captchaVerified: adminUser.captchaVerified,
    isAdmin: adminUser.isAdmin || isAdminById(adminUser.id),
    adminModeDisabled: false,
  };

  // Prefer in-place mutation — no new cookie needed, browser keeps sending
  // the same sid it already has and the server now returns the admin user.
  // We also need `effectiveSid` in scope for the GET branch so it can be
  // written into localStorage (Bearer-token fallback for Chrome/iframe).
  const existingSid = getSessionId(req);
  let effectiveSid: string;
  if (existingSid) {
    await updateSession(existingSid, sessionData);
    effectiveSid = existingSid;
  } else {
    effectiveSid = await createSession(sessionData, adminUser.id);
    setSessionCookie(res, effectiveSid);
  }

  if (req.method === "GET") {
    // Return an HTML page that does two things before navigating away:
    //
    //   1. Writes effectiveSid into localStorage["auth_token"] so the
    //      global fetch interceptor in main.tsx sends it as
    //      "Authorization: Bearer <sid>" on every /api/ request.
    //      This bypasses iframe cookie restrictions in Chrome on Windows:
    //      CHIPS / storage partitioning silently drops Set-Cookie headers
    //      in cross-site iframe contexts (the Replit canvas preview pane),
    //      so cookies never land even with SameSite=None; Secure.
    //      Bearer-token auth is unaffected by cookie policy.
    //
    //   2. JS-redirects to returnTo so the SPA reloads with fresh auth.
    //
    // The Set-Cookie above is still sent for browsers/environments where
    // cookies work (Safari, direct URL access, etc.) — both paths stay active.
    const returnTo = typeof req.query["returnTo"] === "string" ? req.query["returnTo"] : "/";
    res.setHeader("Content-Type", "text/html");
    res.send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>` +
      `<script>` +
      `try{localStorage.setItem("auth_token",${JSON.stringify(effectiveSid)});}catch(e){}` +
      `window.location.replace(${JSON.stringify(returnTo)});` +
      `</script>` +
      `</body></html>`,
    );
  } else {
    res.json({ ok: true, email: adminUser.email });
  }
}

// ⚠️ SECURITY TODO — MUST HARDEN BEFORE PUBLIC LAUNCH ⚠️
// This endpoint grants a full bootstrap-admin session to ANY caller with no
// credential (unauthenticated privilege escalation). It is INTENTIONALLY left
// open during pre-launch development per an explicit product decision
// (David, 2026-07-07) — it is currently the primary way to reach the admin
// panel. Before the app is publicly live this route MUST be gated fail-closed.
//
// A complete hardening (env-gated single source of truth + never-in-production
// guard, session rotation instead of in-place mutation, removal of the
// CORS/origin exemption in app.ts, sanitized returnTo, gated client trigger,
// and a supertest regression) was implemented and then reverted to keep this
// convenience open for now. Re-apply it before launch:
//     git show b6eb5dc   # the full fix; `git revert` its revert to restore
// Tracked as the pre-launch item of the security-hardening pass (C1).
router.get("/auth/dev-admin-login", handleDevAdminLogin);
router.post("/auth/dev-admin-login", handleDevAdminLogin);

export default router;
