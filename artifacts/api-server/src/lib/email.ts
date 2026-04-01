/**
 * Email delivery via Resend.
 * Requires RESEND_API_KEY. RESEND_FROM_EMAIL overrides the default sender.
 * When the key is absent, emails are logged to stdout (development fallback).
 */
import { Resend } from "resend";

function getFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? "noreply@overhype.me";
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

export function buildEmailVerificationEmail(verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Verify your email — Overhype.me";
  const text = `Welcome to Overhype.me!\n\nPlease verify your email address by clicking the link below. This link is valid for 24 hours.\n\n${verifyUrl}\n\nIf you did not create this account, you can safely ignore this email.\n\n— The Overhype.me Team`;
  const html = `
    <h2>Welcome to Overhype.me!</h2>
    <p>Please verify your email address to complete your registration.</p>
    <p style="margin:24px 0;">
      <a href="${verifyUrl}" style="background:#f59e0b;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">
        Verify My Email
      </a>
    </p>
    <p style="font-size:0.85em;color:#666;">Or copy this link into your browser:<br>${verifyUrl}</p>
    <p style="font-size:0.85em;color:#666;">This link is valid for <strong>24 hours</strong>.</p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
    <p style="font-size:0.85em;color:#888;">If you did not create an Overhype.me account, you can safely ignore this email.</p>
    <p>— The Overhype.me Team</p>
  `;
  return { subject, text, html };
}

export function buildEmailChangeVerificationEmail(pendingEmail: string, verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Confirm your new email address — Overhype.me";
  const text = `You requested to change your Overhype.me email address to: ${pendingEmail}\n\nPlease confirm this change by clicking the link below. This link is valid for 24 hours.\n\n${verifyUrl}\n\nIf you did not request this change, you can safely ignore this email — your email address will remain unchanged.\n\n— The Overhype.me Team`;
  const html = `
    <h2>Confirm your new email address</h2>
    <p>You requested to change your Overhype.me email address to: <strong>${pendingEmail}</strong></p>
    <p>Please confirm this change by clicking the button below. This link is valid for <strong>24 hours</strong>.</p>
    <p style="margin:24px 0;">
      <a href="${verifyUrl}" style="background:#f59e0b;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">
        Confirm New Email
      </a>
    </p>
    <p style="font-size:0.85em;color:#666;">Or copy this link into your browser:<br>${verifyUrl}</p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
    <p style="font-size:0.85em;color:#888;">If you did not request this change, you can safely ignore this email — your email address will remain unchanged.</p>
    <p>— The Overhype.me Team</p>
  `;
  return { subject, text, html };
}

export function buildReviewApprovedEmail(opts: {
  username: string;
  submittedText: string;
  factId: number;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const note = opts.adminNote ? `\n\nAdmin note: ${opts.adminNote}` : "";
  const subject = "Your Overhype.me fact has been approved!";
  const text = `Hi ${opts.username},\n\nGreat news! Your submitted fact has been reviewed and approved.\n\n"${opts.submittedText}"${note}\n\nYou can view it here: /facts/${opts.factId}\n\n— The Overhype.me Team`;
  const html = `
    <h2>Your fact has been approved!</h2>
    <p>Hi <strong>${opts.username}</strong>,</p>
    <p>Great news! Your submitted fact has been reviewed and approved.</p>
    <blockquote style="border-left:4px solid #f59e0b;padding-left:1rem;font-style:italic;">${opts.submittedText}</blockquote>
    ${opts.adminNote ? `<p><strong>Admin note:</strong> ${opts.adminNote}</p>` : ""}
    <p><a href="/facts/${opts.factId}">View the approved fact →</a></p>
    <p>— The Overhype.me Team</p>
  `;
  return { subject, text, html };
}

export function buildPasswordResetEmail(resetUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Reset your password — Overhype.me";
  const text = `You requested a password reset for your Overhype.me account.\n\nClick the link below to set a new password. This link is valid for 1 hour.\n\n${resetUrl}\n\nIf you did not request this reset, you can safely ignore this email — your password will not change.\n\n— The Overhype.me Team`;
  const html = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset for your Overhype.me account.</p>
    <p>Click the button below to set a new password. This link is valid for <strong>1 hour</strong>.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}" style="background:#f59e0b;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">
        Reset My Password
      </a>
    </p>
    <p style="font-size:0.85em;color:#666;">Or copy this link into your browser:<br>${resetUrl}</p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
    <p style="font-size:0.85em;color:#888;">If you did not request this reset, you can safely ignore this email — your password will not change.</p>
    <p>— The Overhype.me Team</p>
  `;
  return { subject, text, html };
}

export function buildReviewRejectedEmail(opts: {
  username: string;
  submittedText: string;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const note = opts.adminNote ? `\n\nAdmin note: ${opts.adminNote}` : "";
  const subject = "Update on your submitted Overhype.me fact";
  const text = `Hi ${opts.username},\n\nAfter review, we were unable to add your submitted fact to the database.\n\n"${opts.submittedText}"${note}\n\nFeel free to submit other facts!\n\n— The Overhype.me Team`;
  const html = `
    <h2>Update on your submitted fact</h2>
    <p>Hi <strong>${opts.username}</strong>,</p>
    <p>After review, we were unable to add your submitted fact to the database.</p>
    <blockquote style="border-left:4px solid #ef4444;padding-left:1rem;font-style:italic;">${opts.submittedText}</blockquote>
    ${opts.adminNote ? `<p><strong>Admin note:</strong> ${opts.adminNote}</p>` : ""}
    <p>Feel free to submit other facts!</p>
    <p>— The Overhype.me Team</p>
  `;
  return { subject, text, html };
}
