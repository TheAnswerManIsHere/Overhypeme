import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { stripeStorage } from "../lib/stripeStorage";
import { logger } from "../lib/logger";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_DOMAIN = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost";
const FROM_EMAIL = process.env.FACT_OF_DAY_FROM ?? "noreply@chucknorrisfacts.app";

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.warn("RESEND_API_KEY not set — skipping email send");
    return false;
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, body: text }, "Resend error");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "Email send failed");
    return false;
  }
}

function buildEmailHtml(factText: string, factId: number, unsubUrl: string): string {
  const siteUrl = `https://${SITE_DOMAIN}/chuck-norris-facts`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border:2px solid #f97316;border-radius:4px;overflow:hidden;max-width:600px;">
        <tr>
          <td style="background:#f97316;padding:24px 32px;">
            <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:2px;text-transform:uppercase;">⚡ Fact of the Day</h1>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;text-transform:uppercase;letter-spacing:1px;">Chuck Norris Facts — Daily Intel</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 32px;">
            <p style="margin:0 0 24px;color:#f97316;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Top-Rated Fact #${factId}</p>
            <blockquote style="margin:0 0 32px;padding:20px 24px;background:#111;border-left:4px solid #f97316;border-radius:2px;">
              <p style="margin:0;color:#fff;font-size:18px;line-height:1.7;">"${factText}"</p>
            </blockquote>
            <a href="${siteUrl}/facts/${factId}" style="display:inline-block;background:#f97316;color:#fff;padding:12px 28px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;border-radius:2px;">VIEW FULL FACT</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #333;">
            <p style="margin:0;color:#666;font-size:11px;">
              You're receiving this because you have a premium Chuck Norris Facts membership.
              <a href="${unsubUrl}" style="color:#f97316;">Manage or cancel subscription</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function runFactOfTheDayJob(): Promise<{ sent: number; skipped: number }> {
  const [topFact] = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.isActive, true))
    .orderBy(desc(factsTable.score))
    .limit(100)
    .then(rows => {
      const shuffled = rows.sort(() => Math.random() - 0.5);
      return shuffled.slice(0, 1);
    });

  if (!topFact) {
    logger.warn("No facts found for Fact of the Day");
    return { sent: 0, skipped: 0 };
  }

  let premiumUsers: Array<{ id: string; email: string }> = [];
  try {
    premiumUsers = await stripeStorage.getActivePremiumUsers();
  } catch (err) {
    logger.error({ err }, "Failed to fetch premium users — Stripe schema may not be ready");
    return { sent: 0, skipped: 0 };
  }

  logger.info({ count: premiumUsers.length, factId: topFact.id }, "Sending Fact of the Day");

  let sent = 0;
  let skipped = 0;

  for (const user of premiumUsers) {
    if (!user.email) { skipped++; continue; }

    const portalUrl = `https://${SITE_DOMAIN}/chuck-norris-facts/profile#membership`;
    const html = buildEmailHtml(topFact.text, topFact.id, portalUrl);
    const ok = await sendEmail(user.email, "⚡ Your Daily Chuck Norris Fact", html);
    if (ok) sent++; else skipped++;

    await new Promise(r => setTimeout(r, 50));
  }

  logger.info({ sent, skipped }, "Fact of the Day job complete");
  return { sent, skipped };
}
