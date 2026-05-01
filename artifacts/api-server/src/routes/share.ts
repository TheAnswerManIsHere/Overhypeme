import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { sendEmail, buildShareInviteEmail } from "../lib/email";
import { getSessionId, getSession } from "../lib/auth";
import { verifyCaptcha } from "../lib/captcha";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const INVITE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 20;
const RECIPIENT_LIMIT_PER_WINDOW = 3;
const ORIGIN_LIMIT_PER_WINDOW = 10;
const MIN_REQUEST_AGE_MS = 1200;
const RECENT_FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;
const ALLOWED_SHARE_HOSTS = new Set(["example.com", "www.example.com"]);
const ALLOWED_SHARE_PATH = /^\/share\/[A-Za-z0-9_-]+$/;

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

function isAllowedShareUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && ALLOWED_SHARE_HOSTS.has(parsed.hostname.toLowerCase())
      && ALLOWED_SHARE_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

function audit(event: Record<string, unknown>): void {
  console.info(JSON.stringify({ eventType: "share_invite", at: new Date().toISOString(), ...event }));
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
  const originKey = `${ip}:${trimAndLower(shareUrl)}`;
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
  if (!isAllowedShareUrl(shareUrl.trim())) {
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

  const payload = buildShareInviteEmail(recipientName.trim(), shareUrl.trim(), senderName);

  try {
    await sendEmail({
      to: recipientNormalized,
      ...payload,
    });
  } catch {
    audit({ outcome: "provider_error", ip, sid: !!sid });
    res.status(502).json({ error: "Unable to process invite at this time" });
    return;
  }

  audit({ outcome: "success", ip, sid: !!sid, recipientEmail: recipientNormalized, shareUrl: shareUrl.trim() });
  res.json({ success: true });
});

export default router;
