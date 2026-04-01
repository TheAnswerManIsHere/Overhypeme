/**
 * Email delivery via Resend.
 * Requires RESEND_API_KEY and SENDGRID_FROM_EMAIL environment variables.
 * When the key is absent, emails are logged to stdout (development fallback).
 */
import { Resend } from "resend";

function getFromAddress(): string {
  return process.env.SENDGRID_FROM_EMAIL ?? "noreply@thecndb.com";
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

export function buildReviewApprovedEmail(opts: {
  username: string;
  submittedText: string;
  factId: number;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const note = opts.adminNote ? `\n\nAdmin note: ${opts.adminNote}` : "";
  const subject = "Your Chuck Norris fact has been approved!";
  const text = `Hi ${opts.username},\n\nGreat news! Your submitted fact has been reviewed and approved.\n\n"${opts.submittedText}"${note}\n\nYou can view it here: /facts/${opts.factId}\n\n— The Chuck Norris Facts Team`;
  const html = `
    <h2>Your fact has been approved!</h2>
    <p>Hi <strong>${opts.username}</strong>,</p>
    <p>Great news! Your submitted fact has been reviewed and approved.</p>
    <blockquote style="border-left:4px solid #f59e0b;padding-left:1rem;font-style:italic;">${opts.submittedText}</blockquote>
    ${opts.adminNote ? `<p><strong>Admin note:</strong> ${opts.adminNote}</p>` : ""}
    <p><a href="/facts/${opts.factId}">View the approved fact →</a></p>
    <p>— The Chuck Norris Facts Team</p>
  `;
  return { subject, text, html };
}

export function buildPasswordResetEmail(resetUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Reset your password — Chuck Norris Facts";
  const text = `You requested a password reset for your Chuck Norris Facts account.\n\nClick the link below to set a new password. This link is valid for 1 hour.\n\n${resetUrl}\n\nIf you did not request this reset, you can safely ignore this email — your password will not change.\n\n— The Chuck Norris Facts Team`;
  const html = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset for your Chuck Norris Facts account.</p>
    <p>Click the button below to set a new password. This link is valid for <strong>1 hour</strong>.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}" style="background:#f59e0b;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">
        Reset My Password
      </a>
    </p>
    <p style="font-size:0.85em;color:#666;">Or copy this link into your browser:<br>${resetUrl}</p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
    <p style="font-size:0.85em;color:#888;">If you did not request this reset, you can safely ignore this email — your password will not change.</p>
    <p>— The Chuck Norris Facts Team</p>
  `;
  return { subject, text, html };
}

export function buildReviewRejectedEmail(opts: {
  username: string;
  submittedText: string;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const note = opts.adminNote ? `\n\nAdmin note: ${opts.adminNote}` : "";
  const subject = "Update on your submitted Chuck Norris fact";
  const text = `Hi ${opts.username},\n\nAfter review, we were unable to add your submitted fact to the database.\n\n"${opts.submittedText}"${note}\n\nFeel free to submit other facts!\n\n— The Chuck Norris Facts Team`;
  const html = `
    <h2>Update on your submitted fact</h2>
    <p>Hi <strong>${opts.username}</strong>,</p>
    <p>After review, we were unable to add your submitted fact to the database.</p>
    <blockquote style="border-left:4px solid #ef4444;padding-left:1rem;font-style:italic;">${opts.submittedText}</blockquote>
    ${opts.adminNote ? `<p><strong>Admin note:</strong> ${opts.adminNote}</p>` : ""}
    <p>Feel free to submit other facts!</p>
    <p>— The Chuck Norris Facts Team</p>
  `;
  return { subject, text, html };
}
