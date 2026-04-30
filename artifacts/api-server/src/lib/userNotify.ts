/**
 * User-facing billing notifications.
 *
 * These emails inform a single user about a change to their own account
 * (e.g. losing Legendary access after a refund or chargeback). Unlike
 * adminNotify these are addressed to the affected user, so the copy
 * intentionally avoids exposing any internal Stripe identifiers, dispute
 * IDs, or amounts — the user already knows what they paid; we just need
 * to tell them what happened to their access and how to reach support.
 *
 * All exported functions are fire-and-forget — they never throw.
 */
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { sendEmail, buildEmailShell, divider } from "./email.js";
import { logger } from "./logger.js";

/** Mirrors REVOCATION_EVENTS in stripeStorage.ts and the in-app banner. */
export type AccessRevocationKind = "refund" | "dispute_opened" | "dispute_lost";

const SUPPORT_EMAIL = "overhypeme+support@gmail.com";

/**
 * Look up the user's email and send the access-revoked notice. Safe to call
 * without await — failures are logged and swallowed so that a transient mail
 * delivery error never aborts the surrounding webhook handler.
 *
 * Idempotency note: each Stripe webhook event ID is only processed once
 * (see stripe_processed_events in webhookHandlers.processWebhook), so each
 * qualifying refund/dispute event triggers this helper at most once.
 */
export async function notifyUserAccessRevoked(
  userId: string,
  kind: AccessRevocationKind,
): Promise<void> {
  try {
    const [user] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user || !user.email) {
      logger.info({ userId, kind }, "Access-revoked email skipped — user has no email on file");
      return;
    }

    const { subject, text, html } = buildAccessRevokedEmail(kind);
    await sendEmail({ to: user.email, subject, text, html });
    logger.info({ userId, kind }, "Access-revoked email sent");
  } catch (err) {
    logger.error({ err, userId, kind }, "Failed to send access-revoked email");
  }
}

/** Subject line per kind. Kept neutral — no Stripe identifiers or amounts. */
function subjectFor(kind: AccessRevocationKind): string {
  switch (kind) {
    case "refund":
      return "Your Overhype.me Legendary access has ended";
    case "dispute_opened":
      return "Your Overhype.me Legendary access is paused";
    case "dispute_lost":
      return "Your Overhype.me Legendary access has ended";
  }
}

/** Headline shown in the email body. */
function headlineFor(kind: AccessRevocationKind): string {
  switch (kind) {
    case "refund":
      return "Membership<br/>Refunded";
    case "dispute_opened":
      return "Membership<br/>Paused";
    case "dispute_lost":
      return "Membership<br/>Ended";
  }
}

/**
 * Plain-text describing what happened. Intentionally identical to the in-app
 * banner copy in components/AccessRevocationBanner.tsx so a user who sees both
 * gets the same message twice rather than two slightly different versions.
 */
function describeNoticePlain(kind: AccessRevocationKind): string {
  switch (kind) {
    case "refund":
      return "Your Legendary membership was refunded, so Legendary features are no longer available on this account.";
    case "dispute_opened":
      return "A payment dispute was opened on your Legendary purchase, so Legendary features are paused while the dispute is reviewed.";
    case "dispute_lost":
      return "A payment dispute on your Legendary purchase was finalized, so Legendary features are no longer available on this account.";
  }
}

/** HTML version of the notice — same words, with a single emphasis span. */
function describeNoticeHtml(kind: AccessRevocationKind): string {
  switch (kind) {
    case "refund":
      return 'Your <strong style="color:#ffffff;">Legendary membership was refunded</strong>, so Legendary features are no longer available on this account.';
    case "dispute_opened":
      return 'A <strong style="color:#ffffff;">payment dispute was opened</strong> on your Legendary purchase, so Legendary features are paused while the dispute is reviewed.';
    case "dispute_lost":
      return 'A <strong style="color:#ffffff;">payment dispute</strong> on your Legendary purchase was finalized, so Legendary features are no longer available on this account.';
  }
}

/**
 * Build the access-revoked email payload. Exported so it can be unit-tested
 * directly and so a future admin-trigger flow could re-use the same copy.
 */
export function buildAccessRevokedEmail(kind: AccessRevocationKind): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = subjectFor(kind);
  const headline = headlineFor(kind);
  const noticeText = describeNoticePlain(kind);
  const noticeHtml = describeNoticeHtml(kind);
  const supportMailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Membership access question")}`;

  const text = [
    "MEMBERSHIP UPDATE",
    "",
    noticeText,
    "",
    "Think this happened by mistake, or want to talk through your options?",
    `Reach the team at: ${SUPPORT_EMAIL}`,
    "",
    "You can keep using your free Overhype.me account. If you ever want",
    "Legendary access back, you can upgrade again any time.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 8px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">${headline}</h1>
<p style="margin:0 0 24px;font-size:13px;color:#FF3C00;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Membership update</p>
<p style="margin:0 0 28px;font-size:15px;color:#aaaaaa;line-height:1.75;">${noticeHtml}</p>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Think this happened by mistake, or want to talk through your options? We&#39;re here to&nbsp;help.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;"><a href="${supportMailto}" style="color:#FF3C00;text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a></p>
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You can keep using your free Overhype.me account. If you ever want Legendary access back, you can upgrade again any&nbsp;time.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because a refund or payment dispute changed your Overhype.me membership.",
  );

  return { subject, text, html };
}
