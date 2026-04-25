/**
 * Admin notification helper.
 *
 * Sends branded email alerts to every admin who has opted in to notifications.
 * All functions are fire-and-forget — they never throw.
 */
import { eq, and } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { sendEmail, buildEmailShell, ctaButton, divider } from "./email.js";
import { getSiteBaseUrl } from "./siteUrl.js";

export type AdminNotifyType = "fact_review" | "comment" | "fact_grammar";

export interface AdminNotifyOpts {
  type: AdminNotifyType;
  submitterName: string;
  itemText: string;
  /** Deep-link into the admin panel where the item can be reviewed */
  reviewUrl: string;
}

/**
 * Discriminator for dispute lifecycle alerts.
 *  - "created":              charge.dispute.created — new dispute opened
 *  - "deadline_approaching": charge.dispute.updated with evidence due_by < 48h
 *  - "funds_withdrawn":      charge.dispute.funds_withdrawn — Stripe pulled funds
 *  - "funds_reinstated":     charge.dispute.funds_reinstated — Stripe returned funds
 */
export type AdminDisputeAlertKind =
  | "created"
  | "deadline_approaching"
  | "funds_withdrawn"
  | "funds_reinstated";

export interface AdminDisputeNotifyOpts {
  /** Which lifecycle event triggered this alert */
  kind: AdminDisputeAlertKind;
  /** Stripe dispute ID (e.g. dp_1Abc...) */
  disputeId: string;
  /** Amount disputed (or moved), in the smallest currency unit (e.g. cents) */
  amount: number;
  /** ISO currency code (e.g. "usd") */
  currency: string;
  /** Whether the dispute is from live mode (controls Stripe dashboard URL) */
  livemode: boolean;
  /** Whole hours remaining until evidence is due — required when kind === "deadline_approaching" */
  hoursUntilDue?: number;
}

/**
 * Sends a notification email to every admin who has `adminNotifications = true`.
 * Safe to call without await — errors are swallowed and logged.
 */
export async function notifyAdmins(opts: AdminNotifyOpts): Promise<void> {
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isAdmin, true),
          eq(usersTable.adminNotifications, true),
          eq(usersTable.isActive, true),
        ),
      );

    const emails = admins.map(a => a.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;

    const { subject, text, html } = buildNotificationEmail(opts);
    await Promise.all(emails.map(to => sendEmail({ to, subject, text, html })));
  } catch (err) {
    console.error("[notifyAdmins] Failed:", err);
  }
}

export function buildNotificationEmail(opts: AdminNotifyOpts) {
  const typeLabel =
    opts.type === "fact_review" ? "Fact Submission"
    : opts.type === "fact_grammar" ? "Fact Submission (Grammar Review)"
    : "Comment";

  const subject = `[Overhype.me] New ${typeLabel} Needs Review`;

  const text = [
    `NEW ${typeLabel.toUpperCase()} NEEDS YOUR APPROVAL`,
    "",
    `Submitted by: ${opts.submitterName}`,
    `Content: "${opts.itemText.slice(0, 200)}${opts.itemText.length > 200 ? "…" : ""}"`,
    "",
    `Review it here: ${opts.reviewUrl}`,
    "",
    "— Overhype.me Admin System",
  ].join("\n");

  const safeText = opts.itemText.slice(0, 300).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const truncated = opts.itemText.length > 300 ? "…" : "";
  const siteUrl = getSiteBaseUrl();

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:24px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">New ${typeLabel}<br/>Needs Your Review</h1>
<p style="margin:0 0 8px;font-size:13px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Submitted by</p>
<p style="margin:0 0 20px;font-size:15px;font-weight:600;color:#ffffff;">${opts.submitterName.replace(/</g, "&lt;")}</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #FF3C00;padding:12px 16px;background:#1c1c1e;">
      <p style="margin:0;font-size:14px;color:#dddddd;line-height:1.7;font-style:italic;">"${safeText}${truncated}"</p>
    </td>
  </tr>
</table>
${ctaButton(opts.reviewUrl, "Review Now")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because you have admin notifications enabled on Overhype.me. <a href="${siteUrl}/admin/users" target="_blank" style="color:#FF3C00;text-decoration:none;">Manage notification settings.</a></p>`;

  const html = buildEmailShell(body, "Admin notification — Overhype.me.");

  return { subject, text, html };
}

/**
 * Sends a high-priority dispute alert to every admin who has `disputeNotifications = true`.
 * Stripe gives us ~7 days to respond to disputes, so this alert is meant to be acted on
 * immediately. Safe to call without await — errors are swallowed and logged.
 */
export async function notifyAdminsOfDispute(opts: AdminDisputeNotifyOpts): Promise<void> {
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isAdmin, true),
          eq(usersTable.disputeNotifications, true),
          eq(usersTable.isActive, true),
        ),
      );

    const emails = admins.map(a => a.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;

    const { subject, text, html } = buildDisputeNotificationEmail(opts);
    await Promise.all(emails.map(to => sendEmail({ to, subject, text, html })));
  } catch (err) {
    console.error("[notifyAdminsOfDispute] Failed:", err);
  }
}

function formatAmount(amountMinor: number, currency: string): string {
  const upperCurrency = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: upperCurrency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${upperCurrency}`;
  }
}

/**
 * Per-kind copy for dispute alerts. Centralised so the subject line, headline,
 * urgency strapline, lead paragraph, plain-text intro and CTA stay aligned.
 */
function disputeCopy(opts: AdminDisputeNotifyOpts, formattedAmount: string) {
  switch (opts.kind) {
    case "created":
      return {
        subject: `[Overhype.me] URGENT: Stripe dispute opened (${formattedAmount}) — respond within 7 days`,
        textIntro: [
          "URGENT: A STRIPE DISPUTE HAS BEEN OPENED.",
          "",
          "The user's Legendary access has been revoked automatically.",
          "You have ~7 days to gather evidence and respond in Stripe.",
        ],
        headline: "Stripe Dispute<br/>Opened",
        strapline: "Respond within 7 days",
        urgent: true,
        leadHtml: "The user&#39;s Legendary access has been revoked automatically. Gather evidence and respond in the Stripe dashboard before the response window closes.",
        cta: "Open in Stripe",
        amountLabel: "Amount",
      };
    case "deadline_approaching": {
      const hours = Math.max(0, opts.hoursUntilDue ?? 0);
      const hoursLabel = hours === 1 ? "1 hour" : `${hours} hours`;
      return {
        subject: `[Overhype.me] URGENT: Stripe dispute deadline in ${hoursLabel} — evidence due soon`,
        textIntro: [
          `URGENT: STRIPE DISPUTE DEADLINE IN ${hoursLabel.toUpperCase()}.`,
          "",
          "Evidence is due soon. Submit your response in Stripe before the window closes —",
          "after the deadline the dispute is automatically lost.",
        ],
        headline: "Dispute Deadline<br/>Approaching",
        strapline: `Evidence due in ${hoursLabel}`,
        urgent: true,
        leadHtml: `Stripe will close this dispute against you if no evidence is submitted before the deadline. You have approximately <strong style="color:#ffffff;">${hoursLabel}</strong> remaining.`,
        cta: "Submit Evidence",
        amountLabel: "Disputed amount",
      };
    }
    case "funds_withdrawn":
      return {
        subject: `[Overhype.me] Stripe dispute funds withdrawn (${formattedAmount})`,
        textIntro: [
          "STRIPE HAS WITHDRAWN FUNDS FOR A DISPUTE.",
          "",
          "Stripe debited your balance for the disputed amount while the case is open.",
          "If the dispute is won, the funds will be reinstated.",
        ],
        headline: "Dispute Funds<br/>Withdrawn",
        strapline: "Funds debited from balance",
        urgent: false,
        leadHtml: "Stripe has debited your balance for the disputed amount while the case remains open. If the dispute is won, these funds will be reinstated automatically.",
        cta: "View in Stripe",
        amountLabel: "Amount withdrawn",
      };
    case "funds_reinstated":
      return {
        subject: `[Overhype.me] Stripe dispute funds reinstated (${formattedAmount})`,
        textIntro: [
          "STRIPE HAS REINSTATED FUNDS FOR A DISPUTE.",
          "",
          "The disputed amount has been credited back to your balance.",
        ],
        headline: "Dispute Funds<br/>Reinstated",
        strapline: "Funds credited back to balance",
        urgent: false,
        leadHtml: "Stripe has credited the disputed amount back to your balance — typically because the dispute was won or withdrawn.",
        cta: "View in Stripe",
        amountLabel: "Amount reinstated",
      };
  }
}

export function buildDisputeNotificationEmail(opts: AdminDisputeNotifyOpts) {
  const formattedAmount = formatAmount(opts.amount, opts.currency);
  const dashboardUrl = opts.livemode
    ? `https://dashboard.stripe.com/disputes/${opts.disputeId}`
    : `https://dashboard.stripe.com/test/disputes/${opts.disputeId}`;

  const copy = disputeCopy(opts, formattedAmount);

  const text = [
    ...copy.textIntro,
    "",
    `Dispute ID: ${opts.disputeId}`,
    `Amount:     ${formattedAmount}`,
    `Mode:       ${opts.livemode ? "LIVE" : "TEST"}`,
    "",
    `Open in Stripe: ${dashboardUrl}`,
    "",
    "— Overhype.me Admin System",
  ].join("\n");

  const siteUrl = getSiteBaseUrl();
  const safeDisputeId = opts.disputeId.replace(/</g, "&lt;");
  const modeBadge = opts.livemode
    ? `<span style="display:inline-block;padding:2px 8px;background:#FF3C00;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Live</span>`
    : `<span style="display:inline-block;padding:2px 8px;background:#444444;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Test</span>`;

  const strapColor = copy.urgent ? "#FF3C00" : "#cccccc";

  const body = `
<h1 style="margin:0 0 8px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:24px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">${copy.headline} ${modeBadge}</h1>
<p style="margin:0 0 24px;font-size:14px;color:${strapColor};line-height:1.6;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">${copy.strapline}</p>
<p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.75;">${copy.leadHtml}</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;background:#1c1c1e;">
  <tr>
    <td style="padding:14px 16px;border-left:4px solid #FF3C00;">
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">${copy.amountLabel}</p>
      <p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#ffffff;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">${formattedAmount}</p>
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Dispute ID</p>
      <p style="margin:0;font-size:13px;font-weight:600;color:#dddddd;font-family:'Courier New',monospace;word-break:break-all;">${safeDisputeId}</p>
    </td>
  </tr>
</table>
${ctaButton(dashboardUrl, copy.cta)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because you have Stripe dispute alerts enabled on Overhype.me. <a href="${siteUrl}/admin/users" target="_blank" style="color:#FF3C00;text-decoration:none;">Manage notification settings.</a></p>`;

  const html = buildEmailShell(body, "Stripe dispute alert — Overhype.me.");

  return { subject: copy.subject, text, html };
}

// ── Abandoned email admin alert ───────────────────────────────────────────────

export interface AdminAbandonedEmailNotifyOpts {
  /** The outbox row ID */
  outboxId: number;
  /** Recipient email address */
  to: string;
  /** Email subject line (i.e. what kind of email this was) */
  subject: string;
  /** Last error message returned by the delivery provider */
  lastError: string;
}

/**
 * Sends an alert to every admin who has `adminNotifications = true` when an
 * outbox email is permanently abandoned after exhausting all retry attempts.
 * Fire-and-forget — never throws.
 */
export async function notifyAdminsOfAbandonedEmail(
  opts: AdminAbandonedEmailNotifyOpts,
): Promise<void> {
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isAdmin, true),
          eq(usersTable.adminNotifications, true),
          eq(usersTable.isActive, true),
        ),
      );

    const emails = admins.map(a => a.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;

    const { subject, text, html } = buildAbandonedEmailNotification(opts);
    await Promise.all(emails.map(to => sendEmail({ to, subject, text, html, kind: "admin_abandoned_email_alert" })));
  } catch (err) {
    console.error("[notifyAdminsOfAbandonedEmail] Failed:", err);
  }
}

function buildAbandonedEmailNotification(opts: AdminAbandonedEmailNotifyOpts) {
  const siteUrl = getSiteBaseUrl();
  const emailQueueUrl = `${siteUrl}/admin/email-queue`;

  const subject = `[Overhype.me] Email delivery failed permanently — ${opts.to}`;

  const safeLastError = opts.lastError.slice(0, 500).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeRecipient = opts.to.replace(/</g, "&lt;");
  const safeSubject = opts.subject.slice(0, 200).replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const text = [
    "EMAIL PERMANENTLY ABANDONED AFTER MAX RETRIES.",
    "",
    "An outgoing email could not be delivered and all retry attempts have been",
    "exhausted. The recipient will NOT receive this email unless it is resent manually.",
    "",
    `Recipient:   ${opts.to}`,
    `Subject:     ${opts.subject.slice(0, 200)}`,
    `Outbox ID:   ${opts.outboxId}`,
    `Last error:  ${opts.lastError.slice(0, 500)}`,
    "",
    `View the email queue: ${emailQueueUrl}`,
    "",
    "— Overhype.me Admin System",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 8px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:24px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Email Delivery<br/>Failed Permanently</h1>
<p style="margin:0 0 24px;font-size:14px;color:#FF3C00;line-height:1.6;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">All retry attempts exhausted</p>
<p style="margin:0 0 20px;font-size:15px;color:#aaaaaa;line-height:1.75;">An outgoing email could not be delivered after all retry attempts. The recipient will <strong style="color:#ffffff;">not</strong> receive this message unless it is resent manually.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;background:#1c1c1e;">
  <tr>
    <td style="padding:14px 16px;border-left:4px solid #FF3C00;">
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Recipient</p>
      <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#dddddd;word-break:break-all;">${safeRecipient}</p>
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Email subject</p>
      <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#dddddd;">${safeSubject}</p>
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Outbox ID</p>
      <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#dddddd;font-family:'Courier New',monospace;">${opts.outboxId}</p>
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Last error</p>
      <p style="margin:0;font-size:13px;color:#dddddd;line-height:1.6;font-family:'Courier New',monospace;word-break:break-all;">${safeLastError}</p>
    </td>
  </tr>
</table>
${ctaButton(emailQueueUrl, "View Email Queue")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because you have admin notifications enabled on Overhype.me. <a href="${siteUrl}/admin/users" target="_blank" style="color:#FF3C00;text-decoration:none;">Manage notification settings.</a></p>`;

  const html = buildEmailShell(body, "Email delivery failure — Overhype.me.");

  return { subject, text, html };
}

// ── Early fraud warning admin alert (Task #230) ──────────────────────────────

export interface AdminFraudWarningNotifyOpts {
  /** Stripe early fraud warning ID (e.g. issfr_xxx) */
  warningId: string;
  /** Stripe charge ID being flagged (e.g. ch_xxx) */
  chargeId: string;
  /** Charge amount in the smallest currency unit (e.g. cents) */
  amount: number;
  /** ISO currency code (e.g. "usd") */
  currency: string;
  /** Whether the warning is from live mode (controls Stripe dashboard URL) */
  livemode: boolean;
  /** Stripe-supplied fraud type label (e.g. "fraudulent", "merchandise_not_received") */
  fraudType?: string | null;
  /** Whether Stripe says this charge is actionable (we can refund to dodge a chargeback) */
  actionable?: boolean | null;
}

/**
 * Sends an early fraud warning alert to every admin who has `disputeNotifications = true`.
 * Fired by `radar.early_fraud_warning.created` — admins must decide whether to proactively
 * refund within the 24–72 hour window before the cardholder files a formal chargeback.
 *
 * Reuses the dispute-notifications opt-in flag (per Task #230) — fraud warnings are the
 * pre-cursor to a dispute, so the same audience cares about both. Fire-and-forget.
 */
export async function notifyAdminsOfFraudWarning(opts: AdminFraudWarningNotifyOpts): Promise<void> {
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.isAdmin, true),
          eq(usersTable.disputeNotifications, true),
          eq(usersTable.isActive, true),
        ),
      );

    const emails = admins.map(a => a.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;

    const { subject, text, html } = buildFraudWarningEmail(opts);
    await Promise.all(emails.map(to => sendEmail({ to, subject, text, html })));
  } catch (err) {
    console.error("[notifyAdminsOfFraudWarning] Failed:", err);
  }
}

function buildFraudWarningEmail(opts: AdminFraudWarningNotifyOpts) {
  const formattedAmount = formatAmount(opts.amount, opts.currency);
  const dashboardUrl = opts.livemode
    ? `https://dashboard.stripe.com/radar/early-fraud-warnings/${opts.warningId}`
    : `https://dashboard.stripe.com/test/radar/early-fraud-warnings/${opts.warningId}`;

  const subject = `[Overhype.me] URGENT: Early fraud warning (${formattedAmount}) — refund within 24–72h to avoid chargeback`;

  const fraudTypeLine = opts.fraudType ? `Fraud type: ${opts.fraudType}` : "";
  const actionableLine =
    opts.actionable === true
      ? "Stripe marks this as actionable — proactively refunding now will likely prevent a chargeback."
      : opts.actionable === false
        ? "Stripe marks this as non-actionable — a refund will not prevent a chargeback."
        : "";

  const text = [
    "URGENT: STRIPE FLAGGED A CHARGE FOR EARLY FRAUD.",
    "",
    "Stripe's Radar issued an early fraud warning for one of your charges.",
    "You typically have 24–72 hours to proactively refund before the",
    "cardholder files a formal chargeback. Disputes cost more than refunds.",
    ...(actionableLine ? ["", actionableLine] : []),
    ...(fraudTypeLine ? ["", fraudTypeLine] : []),
    "",
    `Warning ID: ${opts.warningId}`,
    `Charge ID:  ${opts.chargeId}`,
    `Amount:     ${formattedAmount}`,
    `Mode:       ${opts.livemode ? "LIVE" : "TEST"}`,
    "",
    `Open in Stripe: ${dashboardUrl}`,
    "",
    "— Overhype.me Admin System",
  ].join("\n");

  const siteUrl = getSiteBaseUrl();
  const safeWarningId = opts.warningId.replace(/</g, "&lt;");
  const safeChargeId = opts.chargeId.replace(/</g, "&lt;");
  const modeBadge = opts.livemode
    ? `<span style="display:inline-block;padding:2px 8px;background:#FF3C00;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Live</span>`
    : `<span style="display:inline-block;padding:2px 8px;background:#444444;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Test</span>`;

  const fraudTypeHtml = opts.fraudType
    ? `<p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Fraud type</p>
<p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#dddddd;">${opts.fraudType.replace(/</g, "&lt;")}</p>`
    : "";

  const actionableHtml = actionableLine
    ? `<p style="margin:0 0 20px;font-size:14px;color:${opts.actionable ? "#FF3C00" : "#aaaaaa"};line-height:1.7;font-weight:${opts.actionable ? "600" : "400"};">${actionableLine}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 8px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:24px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Early Fraud<br/>Warning ${modeBadge}</h1>
<p style="margin:0 0 24px;font-size:14px;color:#FF3C00;line-height:1.6;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">Refund window: 24–72 hours</p>
<p style="margin:0 0 16px;font-size:15px;color:#aaaaaa;line-height:1.75;">Stripe&#39;s Radar flagged a charge as likely-fraudulent. Proactively refunding now usually prevents the cardholder from filing a formal chargeback later — and chargebacks cost more than the refund itself.</p>
${actionableHtml}
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;background:#1c1c1e;">
  <tr>
    <td style="padding:14px 16px;border-left:4px solid #FF3C00;">
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Amount</p>
      <p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#ffffff;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">${formattedAmount}</p>
      ${fraudTypeHtml}
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Warning ID</p>
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#dddddd;font-family:'Courier New',monospace;word-break:break-all;">${safeWarningId}</p>
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Charge ID</p>
      <p style="margin:0;font-size:13px;font-weight:600;color:#dddddd;font-family:'Courier New',monospace;word-break:break-all;">${safeChargeId}</p>
    </td>
  </tr>
</table>
${ctaButton(dashboardUrl, "Review in Stripe")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because you have Stripe dispute alerts enabled on Overhype.me. <a href="${siteUrl}/admin/users" target="_blank" style="color:#FF3C00;text-decoration:none;">Manage notification settings.</a></p>`;

  const html = buildEmailShell(body, "Stripe early fraud warning — Overhype.me.");

  return { subject, text, html };
}
