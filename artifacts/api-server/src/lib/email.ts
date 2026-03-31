/**
 * Email delivery via SendGrid.
 * Requires SENDGRID_API_KEY and SENDGRID_FROM_EMAIL environment variables.
 * When the key is absent, emails are logged to stdout (development fallback).
 */
import sgMail from "@sendgrid/mail";

function getFromAddress(): string {
  return process.env.SENDGRID_FROM_EMAIL ?? "noreply@chucknorrisfacts.com";
}

function isEnabled(): boolean {
  return !!process.env.SENDGRID_API_KEY;
}

if (isEnabled()) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!isEnabled()) {
    console.log("[email] SendGrid not configured — would have sent:");
    console.log(`  To:      ${payload.to}`);
    console.log(`  Subject: ${payload.subject}`);
    console.log(`  Body:    ${payload.text}`);
    return;
  }
  try {
    await sgMail.send({
      to: payload.to,
      from: getFromAddress(),
      subject: payload.subject,
      text: payload.text,
      html: payload.html ?? payload.text,
    });
  } catch (err) {
    console.error("[email] SendGrid delivery failed:", err);
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
