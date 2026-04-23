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

function buildNotificationEmail(opts: AdminNotifyOpts) {
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
