/**
 * @purpose The contact page's one request (launch Phase 16, increment 5; plan design E and amendment 3): a visitor or member, signed out or in any account state, and while read-only mode is on (Q7: 1), sends a request that is queued to the support inbox with their address as reply-to, kept as a row in `support_requests`, and acknowledged to them by email.
 * @subsystem operations
 */
import { Router, type IRouter, type Request, type Response } from "express";
import * as Sentry from "@sentry/node";
import { db } from "@workspace/db";
import { supportRequestsTable, SUPPORT_CATEGORIES, type SupportCategory } from "@workspace/db/schema";
import { verifyCaptcha } from "../lib/captcha";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { ipFromRequest } from "../lib/transientRenderLog";
import { sendEmail, SUPPORT_ADDRESS, buildSupportRequestEmail, buildSupportAcknowledgementEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export const SUPPORT_LIMITS = {
  perIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  perEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
} as const;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;
/** A form sent faster than a person can fill it in is a script. */
const MIN_FORM_AGE_MS = 3000;
/**
 * One "@" with something before it, and a domain with a dot that is neither
 * first nor last; no whitespace. Checked by position rather than a regex, so
 * its cost is linear in the address whatever the visitor sends (CodeQL,
 * polynomial regex on user input). Callers bound the length first.
 */
export function isEmailShape(email: string): boolean {
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

function isCategory(v: unknown): v is SupportCategory {
  return typeof v === "string" && (SUPPORT_CATEGORIES as readonly string[]).includes(v);
}

/** Runs one step of a request; a failure is reported to Sentry and answered as false. */
async function attempt(step: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    Sentry.captureException(err, { tags: { support: step } });
    return false;
  }
}

/** The answer when the request could not reach the inbox: say so, and give the address. */
function unavailable(res: Response): void {
  res.status(503).json({
    error: `We couldn't send your message just now. Please email us at ${SUPPORT_ADDRESS}.`,
    code: "SUPPORT_UNAVAILABLE",
    address: SUPPORT_ADDRESS,
  });
}

router.post("/support/contact", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ip = ipFromRequest(req);

  const perIp = await checkSharedRateLimit({ endpoint: "support.contact", ip }, SUPPORT_LIMITS.perIp);
  if (!perIp.allowed) {
    res.status(429).json({ error: "Too many messages from here. Please try again later.", code: "RATE_LIMITED" });
    return;
  }

  if (typeof body.hpField === "string" && body.hpField.trim().length > 0) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  if (typeof body.formStartedAt === "number" && Date.now() - body.formStartedAt < MIN_FORM_AGE_MS) {
    res.status(400).json({ error: "That was quicker than anyone can type. Please try again." });
    return;
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 320 || !isEmailShape(email)) {
    res.status(400).json({ error: "Enter the email address we should reply to.", field: "email" });
    return;
  }
  if (!isCategory(body.category)) {
    res.status(400).json({ error: "Choose what your message is about.", field: "category" });
    return;
  }
  const category = body.category;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    res.status(400).json({ error: `Your message needs between ${MESSAGE_MIN} and ${MESSAGE_MAX} characters.`, field: "message" });
    return;
  }

  const token = typeof body.captchaToken === "string" ? body.captchaToken : "";
  if (!token || !(await verifyCaptcha(token, ip === "unknown" ? undefined : ip))) {
    res.status(400).json({ error: "The challenge didn't pass. Try it again.", code: "CAPTCHA_FAILED" });
    return;
  }

  // Per address after the captcha, so a script cannot spend a real person's allowance.
  const perEmail = await checkSharedRateLimit({ endpoint: "support.contact", recipientEmail: email }, SUPPORT_LIMITS.perEmail);
  if (!perEmail.allowed) {
    res.status(429).json({ error: "We've had a few messages from this address already. We'll reply to those first.", code: "RATE_LIMITED" });
    return;
  }

  const userId = req.user?.id ?? null;
  const accountState = req.user ? (req.user.eligibility ?? "eligible") : null;

  // 1. The inbox, where the request is read and answered.
  const inboxQueued = await attempt("inbox", () => sendEmail({
    to: SUPPORT_ADDRESS,
    replyTo: email,
    kind: "support_request",
    ...buildSupportRequestEmail({ email, category, message, userId, accountState }),
  }, db));

  // 2. The permanent record (amendment 3): written whatever the inbox did.
  const recorded = await attempt("record", () => db.insert(supportRequestsTable).values({
    email, category, message, userId, accountState,
    inboxDelivery: inboxQueued ? "queued" : "failed",
  }));

  logger.info({ eventType: "support_request", category, inboxQueued, recorded, signedIn: !!userId }, "support_request");
  if (!inboxQueued) {
    unavailable(res);
    return;
  }

  // 3. The acknowledgement: its failure does not undo a request that arrived.
  const acknowledged = await attempt("acknowledgement", () =>
    sendEmail({ to: email, kind: "support_ack", ...buildSupportAcknowledgementEmail(category) }, db));

  res.json({ ok: true, acknowledged });
});

export default router;
