import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { stripeStorage } from "../lib/stripeStorage";
import { logger } from "../lib/logger";
import { sendEmail, buildEmailShell, ctaButton, divider, getSiteBaseUrl } from "../lib/email";
import { renderPersonalized } from "../lib/renderCanonical";

function buildFactOfTheDayEmail(
  factText: string,
  factId: number,
  manageUrl: string,
): { subject: string; text: string; html: string } {
  const factUrl = `${getSiteBaseUrl()}/facts/${factId}`;

  const subject = "⚡ Your Daily Overhype.me Fact";

  const text = [
    "TODAY'S FACT.",
    "",
    `"${factText}"`,
    "",
    `Read it here: ${factUrl}`,
    "",
    "— The Overhype.me Team",
    "",
    `Manage your Legendary subscription: ${manageUrl}`,
  ].join("\n");

  const body = `
<h1 style="margin:0 0 6px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Today's Fact.</h1>
<p style="margin:0 0 28px;font-size:13px;color:#555555;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',-apple-system,sans-serif;">Hand-picked from the database of greatness</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 32px;">
  <tr>
    <td style="border-left:4px solid #FF3C00;padding:16px 20px;background:#1c1c1e;">
      <p style="margin:0;font-size:17px;color:#dddddd;line-height:1.75;font-style:italic;font-family:'Inter',-apple-system,sans-serif;">"${factText}"</p>
    </td>
  </tr>
</table>
${ctaButton(factUrl, "View the Full Fact")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Keep&nbsp;submitting. Every legend needs&nbsp;material.</p>`;

  const footerNote = `You&#39;re receiving this because you&#39;re a Legendary member — good taste.&nbsp;
<a href="${manageUrl}" style="color:#FF3C00;text-decoration:none;">Manage&nbsp;subscription</a>`;

  const html = buildEmailShell(body, footerNote);

  return { subject, text, html };
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

  let legendaryUsers: Array<{ id: string; email: string; displayName: string | null; pronouns: string | null }> = [];
  try {
    legendaryUsers = await stripeStorage.getActiveLegendarySubscribers();
  } catch (err) {
    logger.error({ err }, "Failed to fetch legendary subscribers — Stripe schema may not be ready");
    return { sent: 0, skipped: 0 };
  }

  logger.info({ count: legendaryUsers.length, factId: topFact.id }, "Sending Fact of the Day");

  let sent = 0;
  let skipped = 0;

  for (const user of legendaryUsers) {
    if (!user.email) { skipped++; continue; }

    const manageUrl = `${getSiteBaseUrl()}/profile#membership`;
    const renderedText = user.displayName
      ? renderPersonalized(topFact.text, user.displayName, user.pronouns ?? null)
      : topFact.text;
    const { subject, text, html } = buildFactOfTheDayEmail(renderedText, topFact.id, manageUrl);
    try {
      await sendEmail({ to: user.email, subject, text, html });
      sent++;
    } catch {
      skipped++;
    }

    await new Promise(r => setTimeout(r, 50));
  }

  logger.info({ sent, skipped }, "Fact of the Day job complete");
  return { sent, skipped };
}
