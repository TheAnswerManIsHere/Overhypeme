/**
 * Email delivery via Resend.
 * Requires RESEND_API_KEY. RESEND_FROM_EMAIL overrides the default sender.
 * When the key is absent, emails are logged to stdout (development fallback).
 *
 * Brand: dark bg (#0d0d0e), danger orange (#FF3C00), Oswald + Inter typography.
 */
import { Resend } from "resend";

function getFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? "noreply@overhype.me";
}

/** Trailing slash stripped so callers can safely append paths. */
export function getSiteBaseUrl(): string {
  return (process.env.SITE_BASE_URL ?? "https://overhype.me").replace(/\/$/, "");
}

function isEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

let resend: Resend | null = null;
if (isEnabled()) {
  resend = new Resend(process.env.RESEND_API_KEY!);
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!isEnabled() || !resend) {
    console.log("[email] Resend not configured — would have sent:");
    console.log(`  To:      ${payload.to}`);
    console.log(`  Subject: ${payload.subject}`);
    console.log(`  Body:    ${payload.text}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({
      to: payload.to,
      from: getFromAddress(),
      subject: payload.subject,
      text: payload.text,
      html: payload.html ?? payload.text,
    });
    if (error) {
      console.error("[email] Resend delivery failed:", error);
    }
  } catch (err) {
    console.error("[email] Resend delivery error:", err);
  }
}

/**
 * Wraps email body content in the Overhype.me branded shell.
 *
 * Typography: Oswald (headers) + Inter (body) loaded via Google Fonts.
 * Outlook ignores web fonts and falls back to Impact / system sans-serif, which
 * still looks intentional at this weight.
 *
 * STUB LOGO: The header currently renders the brand name as styled text.
 * Once a hosted logo image is available, replace the stub block with:
 *   <img src="https://overhype.me/images/logo.png" width="48" height="48" alt="Overhype.me" style="display:block;" />
 */
export function buildEmailShell(bodyContent: string, footerNote: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!--[if !mso]><!-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@600;700&display=swap');
  </style>
  <!--<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0d0d0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0d0d0e">
    <tr>
      <td align="center" style="padding:48px 16px 40px;">

        <!-- ═══════════════════════════════════════════
             STUB LOGO
             Replace with a hosted <img> when ready.
             ═══════════════════════════════════════════ -->
        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
          <tr>
            <td bgcolor="#FF3C00" style="padding:8px 16px 10px;">
              <span style="font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ffffff;mso-font-alt:'Impact';">OVERHYPE</span><span style="font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#000000;mso-font-alt:'Impact';">.ME</span>
            </td>
          </tr>
        </table>

        <!-- ═══════════════════════════════════════════
             CARD
             ═══════════════════════════════════════════ -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;" bgcolor="#161618">
          <!-- Top accent bar -->
          <tr>
            <td height="4" bgcolor="#FF3C00" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 40px;border-left:1px solid #2a2a2a;border-right:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;">
              ${bodyContent}
            </td>
          </tr>
        </table>

        <!-- ═══════════════════════════════════════════
             FOOTER NOTE
             ═══════════════════════════════════════════ -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:20px 4px 0;" align="center">
              <p style="margin:0;font-size:11px;color:#444444;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">
                ${footerNote}
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Renders an orange CTA button compatible with most email clients. */
export function ctaButton(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
  <tr>
    <td align="center" bgcolor="#FF3C00">
      <a href="${href}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none;mso-font-alt:'Impact';">${label}</a>
    </td>
  </tr>
</table>`;
}

/** Renders the small "Or copy this link" fallback block. */
function linkFallback(url: string): string {
  return `<p style="margin:0 0 4px;font-size:11px;color:#555555;font-family:'Inter',-apple-system,sans-serif;">Or copy this link into your browser:</p>
<p style="margin:0 0 28px;font-size:11px;color:#555555;word-break:break-all;line-height:1.6;font-family:'Inter',-apple-system,sans-serif;">${url}</p>`;
}

/** Renders a hairline divider. */
export function divider(): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td height="1" bgcolor="#222222" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin notification helper
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Email builders
// ─────────────────────────────────────────────────────────────────────────────

export function buildEmailVerificationEmail(verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Verify your email — Overhype.me";

  const text = [
    "YOUR LEGEND BEGINS HERE.",
    "",
    "Before we add you to the database of greatness, we need to verify that",
    "you're actually you. (Or a reasonable facsimile. We're not picky.)",
    "",
    "Verify your email here — link valid for 24 hours:",
    verifyUrl,
    "",
    "Didn't sign up? Ignore this and carry on.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Your Legend<br/>Begins Here.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">Before we add you to the database of greatness, we need to verify that you're actually you. (Or a reasonable facsimile. We're&nbsp;not&nbsp;picky.)</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hit the button. This link expires in <strong style="color:#ffffff;">24&nbsp;hours</strong>&nbsp;— unlike your legend, which is&nbsp;forever.</p>
${ctaButton(verifyUrl, "Verify My Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't sign up? Someone may be trying to use your email address. Just ignore this and carry&nbsp;on.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because someone created an account with this email address on Overhype.me.",
  );

  return { subject, text, html };
}

export function buildEmailChangeVerificationEmail(pendingEmail: string, verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Confirm your new email address — Overhype.me";

  const text = [
    "CONFIRM YOUR NEW EMAIL.",
    "",
    `You requested to change your Overhype.me email address to: ${pendingEmail}`,
    "",
    "Confirm the change here — link valid for 24 hours:",
    verifyUrl,
    "",
    "Didn't request this? Ignore it. Your current email stays put.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Confirm Your<br/>New Email.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">You requested to change your Overhype.me email address&nbsp;to:</p>
<p style="margin:0 0 28px;font-size:16px;font-weight:600;color:#ffffff;word-break:break-all;">${pendingEmail}</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to lock it in. This link is valid for <strong style="color:#ffffff;">24&nbsp;hours</strong>.</p>
${ctaButton(verifyUrl, "Confirm New Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request this change? Ignore it — your current email address will remain&nbsp;unchanged.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because an email change was requested on your Overhype.me account.",
  );

  return { subject, text, html };
}

export function buildPasswordResetEmail(resetUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Reset your password — Overhype.me";

  const text = [
    "FORGOT YOUR PASSWORD? IT HAPPENS TO THE BEST OF US.",
    "",
    "Click the link below to set a new password. This link is valid for 1 hour.",
    resetUrl,
    "",
    "Didn't request this? Ignore it. Your password won't change.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Forgot Your<br/>Password?</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">It happens to the best of us. Even legends have off&nbsp;days.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to set a new password. This link expires in <strong style="color:#ffffff;">1&nbsp;hour</strong>, so don't sit on&nbsp;it.</p>
${ctaButton(resetUrl, "Reset My Password")}
${linkFallback(resetUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request a password reset? Ignore this — your password will not&nbsp;change.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because a password reset was requested for your Overhype.me account.",
  );

  return { subject, text, html };
}

export function buildReviewApprovedEmail(opts: {
  username: string;
  submittedText: string;
  factId: number;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const factUrl = `${getSiteBaseUrl()}/facts/${opts.factId}`;
  const subject = "Your Overhype.me fact has been approved!";

  const text = [
    `IT'S OFFICIAL, ${opts.username.toUpperCase()}.`,
    "",
    "Your submitted fact has been reviewed and approved. The database grows stronger.",
    "",
    `"${opts.submittedText}"`,
    ...(opts.adminNote ? ["", `Admin note: ${opts.adminNote}`] : []),
    "",
    `View it here: ${factUrl}`,
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const adminNoteHtml = opts.adminNote
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #2a2a2a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">It&#39;s Official,<br/>${opts.username}.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your submitted fact has been reviewed and approved. The database grows stronger.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #FF3C00;padding:12px 16px;background:#1c1c1e;">
      <p style="margin:0;font-size:15px;color:#dddddd;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${adminNoteHtml}
${ctaButton(factUrl, "View Your Fact")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Keep submitting. Every legend needs&nbsp;material.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you submitted a fact on Overhype.me.",
  );

  return { subject, text, html };
}

export function buildReviewRejectedEmail(opts: {
  username: string;
  submittedText: string;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Update on your submitted Overhype.me fact";

  const text = [
    `HEY ${opts.username.toUpperCase()}, NOT EVERY LEGEND MAKES THE CUT.`,
    "",
    "After review, we weren't able to add this one to the database.",
    "",
    `"${opts.submittedText}"`,
    ...(opts.adminNote ? ["", `Admin note: ${opts.adminNote}`] : []),
    "",
    "Don't sweat it. Keep submitting — greatness takes practice.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const adminNoteHtml = opts.adminNote
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #2a2a2a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Not Every Legend<br/>Makes the Cut.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hey <strong style="color:#ffffff;">${opts.username}</strong> — after review, we weren&#39;t able to add this one to the&nbsp;database.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #555555;padding:12px 16px;background:#1c1c1e;">
      <p style="margin:0;font-size:15px;color:#888888;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${adminNoteHtml}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Don&#39;t sweat it. Greatness takes practice. Keep&nbsp;submitting.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you submitted a fact on Overhype.me.",
  );

  return { subject, text, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// Share / invite email
// ─────────────────────────────────────────────────────────────────────────────

export function buildShareInviteEmail(
  recipientName: string,
  shareUrl: string,
  senderName: string | null,
): Pick<EmailPayload, "subject" | "text" | "html"> {
  const fromPhrase = senderName ? `${senderName} thinks` : "Someone thinks";
  const subject = `${fromPhrase} you deserve to be hyped`;

  const text = [
    `${fromPhrase.toUpperCase()} YOU'RE LEGENDARY.`,
    "",
    `They've set up a personalized experience just for you at Overhype.me —`,
    `a community-driven database of epic facts about real people.`,
    "",
    `Your personalised link (${recipientName}'s edition):`,
    shareUrl,
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const siteUrl = getSiteBaseUrl();

  const safeFrom = fromPhrase.replace(/'/g, "&#39;");
  const safeName = recipientName.replace(/</g, "&lt;");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">${safeFrom} You&#39;re<br/>Legendary.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">They&#39;ve set up a personalised Overhype.me experience just for <strong style="color:#ffffff;">${safeName}</strong> — a community-driven database of epic facts about real people.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your link is already loaded with your name and pronouns. When you open it, you&#39;ll see the world through&nbsp;your&nbsp;lens.</p>
${ctaButton(shareUrl, "See My Facts")}
${linkFallback(shareUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Not sure what Overhype.me is? <a href="${siteUrl}" target="_blank" style="color:#FF3C00;text-decoration:none;">Find out here.</a> If you didn&#39;t expect this, you can safely ignore&nbsp;it.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because someone shared Overhype.me with you.",
  );

  return { subject, text, html };
}
