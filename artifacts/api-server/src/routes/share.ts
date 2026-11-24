import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { sendEmail, buildShareInviteEmail } from "../lib/email";
import { getSessionId, getSession } from "../lib/auth";
import { verifyCaptcha } from "../lib/captcha";
import { logger } from "../lib/logger";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { checkPersonalName } from "@workspace/api-zod";

const router: IRouter = Router();

const INVITE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 20;
const RECIPIENT_LIMIT_PER_WINDOW = 3;
const ORIGIN_LIMIT_PER_WINDOW = 10;
const MIN_REQUEST_AGE_MS = 1200;
const RECENT_FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;
// The pages a share invite may point at: the home page and a fact page. The
// link the email carries is rebuilt on our own address from these, never sent
// as the client wrote it (#374): the old allowlist named a placeholder host and
// a /share/ path no page has, so every real invite was refused.
const SHARE_PATH = /^\/(?:facts\/[1-9][0-9]{0,9})?$/;
const SHARE_PRONOUNS_MAX = 120;

type Bucket = { count: number; resetAt: number };
const routeRateLimiter = new Map<string, Bucket>();
const recipientLimiter = new Map<string, Bucket>();
const originLimiter = new Map<string, Bucket>();
const seenFingerprints = new Map<string, number>();

function checkBucket(limitMap: Map<string, Bucket>, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = limitMap.get(key);
  if (!entry || now > entry.resetAt) {
    limitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

function trimAndLower(v: string): string {
  return v.trim().toLowerCase();
}

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0]?.trim() ?? "unknown";
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * The link an invite email carries, rebuilt on the site's own address
 * (`getSiteBaseUrl`) from the page the client named, or null when that page is
 * not one a share may point at. Only the path and the two personalisation
 * fields survive: the client's host, port, other query parameters and fragment
 * are dropped, so the email can never carry someone else's link (#374). The
 * name is the validated recipient name, not whatever the URL held.
 */
export function canonicalShareUrl(value: string, recipientName: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
  if (!SHARE_PATH.test(path)) return null;
  const params = new URLSearchParams({ displayName: recipientName });
  const pronouns = parsed.searchParams.get("pronouns")?.trim();
  if (pronouns && pronouns.length <= SHARE_PRONOUNS_MAX) params.set("pronouns", pronouns);
  return `${getSiteBaseUrl()}${path}?${params.toString()}`;
}

function audit(event: Record<string, unknown>): void {
  logger.info({ eventType: "share_invite", ...event }, "share_invite");
}

export function __resetShareInviteGuardsForTests(): void {
  routeRateLimiter.clear();
  recipientLimiter.clear();
  originLimiter.clear();
  seenFingerprints.clear();
}

router.post("/share/invite", async (req: Request, res: Response) => {
  const { recipientEmail, recipientName, shareUrl, captchaToken, hpField, formStartedAt } = req.body as {
    recipientEmail?: string;
    recipientName?: string;
    shareUrl?: string;
    captchaToken?: string;
    hpField?: string;
    formStartedAt?: number;
  };

  const ip = getClientIp(req);
  const sid = getSessionId(req);
  const routeKey = `${ip}:${sid ?? "anon"}`;
  if (!checkBucket(routeRateLimiter, routeKey, RATE_LIMIT_PER_WINDOW, INVITE_WINDOW_MS)) {
    audit({ outcome: "rate_limited", ip, sid: !!sid });
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  if (!recipientEmail || typeof recipientEmail !== "string") {
    res.status(400).json({ error: "recipientEmail is required" });
    return;
  }
  if (!recipientName || typeof recipientName !== "string") {
    res.status(400).json({ error: "recipientName is required" });
    return;
  }
  // The recipient's name follows the shared name rule (identity-flow Phase 2):
  // it goes into the invite email and the link's personalisation.
  const recipientNameCheck = checkPersonalName(recipientName);
  if (!recipientNameCheck.ok) {
    res.status(400).json({ error: recipientNameCheck.error });
    return;
  }
  if (!shareUrl || typeof shareUrl !== "string") {
    res.status(400).json({ error: "shareUrl is required" });
    return;
  }

  if (typeof hpField === "string" && hpField.trim().length > 0) {
    audit({ outcome: "blocked_honeypot", ip, sid: !!sid });
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  if (typeof formStartedAt === "number" && Date.now() - formStartedAt < MIN_REQUEST_AGE_MS) {
    audit({ outcome: "blocked_min_age", ip, sid: !!sid });
    res.status(400).json({ error: "Form submission too fast" });
    return;
  }

  const recipientNormalized = trimAndLower(recipientEmail);
  const fingerprint = createHash("sha256")
    .update(`${ip}|${recipientNormalized}|${trimAndLower(recipientName)}|${trimAndLower(shareUrl)}`)
    .digest("hex");
  const prevSeenAt = seenFingerprints.get(fingerprint);
  if (prevSeenAt && Date.now() - prevSeenAt < RECENT_FINGERPRINT_WINDOW_MS) {
    audit({ outcome: "blocked_fingerprint", ip, sid: !!sid, recipientEmail: recipientNormalized });
    res.status(429).json({ error: "Duplicate invite detected" });
    return;
  }
  seenFingerprints.set(fingerprint, Date.now());

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientNormalized)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  const inviteUrl = canonicalShareUrl(shareUrl.trim(), recipientNameCheck.value);
  if (!inviteUrl) {
    res.status(400).json({ error: "shareUrl host/path not allowed" });
    return;
  }

  let sessionUserId: string | null = null;
  if (sid) {
    try {
      const session = await getSession(sid);
      if (session?.user?.id) sessionUserId = session.user.id;
    } catch {
      // treat invalid session lookup as anonymous
    }
  }

  const hasValidatedSession = !!sessionUserId;
  if (!hasValidatedSession) {
    if (!captchaToken || typeof captchaToken !== "string" || !(await verifyCaptcha(captchaToken))) {
      audit({ outcome: "blocked_captcha", ip, sid: false });
      res.status(403).json({ error: "CAPTCHA required" });
      return;
    }
  }

  if (!checkBucket(recipientLimiter, recipientNormalized, RECIPIENT_LIMIT_PER_WINDOW, INVITE_WINDOW_MS)) {
    audit({ outcome: "recipient_throttled", ip, sid: !!sid, recipientEmail: recipientNormalized });
    res.status(429).json({ error: "Recipient throttle exceeded" });
    return;
  }
  // Keyed on the page alone (its path), never on the name or pronouns the
  // sender typed, so changing either cannot buy a fresh allowance for the same
  // page (build report on PR #1150).
  const originKey = `${ip}:${new URL(inviteUrl).pathname}`;
  if (!checkBucket(originLimiter, originKey, ORIGIN_LIMIT_PER_WINDOW, INVITE_WINDOW_MS)) {
    audit({ outcome: "origin_throttled", ip, sid: !!sid, shareUrl });
    res.status(429).json({ error: "Origin throttle exceeded" });
    return;
  }

  let senderName: string | null = null;
  try {
    if (sessionUserId) {
      const [dbUser] = await db
        .select({ displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, sessionUserId));
      if (dbUser?.displayName) senderName = dbUser.displayName;
    }
  } catch {
    // best effort only
  }

  const payload = buildShareInviteEmail(recipientNameCheck.value, inviteUrl, senderName);

  try {
    await sendEmail({
      to: recipientNormalized,
      kind: "share_invite",
      ...payload,
    }, db);
  } catch {
    audit({ outcome: "provider_error", ip, sid: !!sid });
    res.status(502).json({ error: "Unable to process invite at this time" });
    return;
  }

  audit({ outcome: "success", ip, sid: !!sid, recipientEmail: recipientNormalized, shareUrl: inviteUrl });
  res.json({ success: true });
});

export default router;
