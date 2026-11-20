import { BRAND_ORANGE } from "@workspace/api-zod";
import { db, pool } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { stripeStorage } from "../lib/stripeStorage";
import { logger } from "../lib/logger";
import { sendEmail, buildEmailShell, ctaButton, divider } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { renderPersonalized } from "../lib/renderCanonical";
import { ADVISORY_LOCK_KEYS } from "../lib/advisoryLockKeys";
import { lastTaskCompletion, recordTaskCompleted } from "../lib/recurringTasks";

export function buildFactOfTheDayEmail(
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
<h1 style="margin:0 0 6px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Today's Fact.</h1>
<p style="margin:0 0 28px;font-size:13px;color:#888888;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',-apple-system,sans-serif;">Hand-picked from the database of greatness</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 32px;">
  <tr>
    <td style="border-left:4px solid ${BRAND_ORANGE};padding:16px 20px;background:#1f1f22;border-radius:10px;">
      <p style="margin:0;font-size:17px;color:#dddddd;line-height:1.75;font-style:italic;font-family:'Inter',-apple-system,sans-serif;">"${factText}"</p>
    </td>
  </tr>
</table>
${ctaButton(factUrl, "View the Full Fact")}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Keep&nbsp;submitting. Every legend needs&nbsp;material.</p>`;

  const footerNote = `You&#39;re receiving this because you&#39;re a Legendary member — good taste.&nbsp;
<a href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:none;">Manage&nbsp;subscription</a>`;

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
    // A failed run, not an empty one: nothing was sent, so the daily wrapper
    // tries again in minutes rather than recording the day as done.
    logger.error({ err }, "Failed to fetch legendary subscribers");
    throw err;
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

/** The send hour, UTC. */
export const FACT_OF_THE_DAY_HOUR_UTC = 9;

/** The most recent 09:00 UTC at or before `now`: the start of the send period `now` falls in. */
export function currentSendMark(now: Date): Date {
  const mark = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), FACT_OF_THE_DAY_HOUR_UTC));
  if (mark.getTime() > now.getTime()) mark.setUTCDate(mark.getUTCDate() - 1);
  return mark;
}

/** Milliseconds from `now` to the next 09:00 UTC. */
export function msUntilNextSend(now = new Date()): number {
  const next = currentSendMark(now);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export type DailySendOutcome = "sent" | "already-sent" | "another-instance-is-sending";

/**
 * A send whose emails went out but whose completion could not be recorded, by
 * send period: the retry then only records it, and never emails again.
 */
let sentButUnrecordedFor: number | null = null;

export interface DailySendDeps {
  now?: Date;
  /** Take the fleet-wide send lock; resolves a release function, or null when another instance holds it. */
  lock?: () => Promise<(() => Promise<void>) | null>;
  lastCompleted?: () => Promise<Date | null>;
  send?: () => Promise<{ sent: number; skipped: number }>;
  record?: () => Promise<boolean>;
}

async function takeSendLock(): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK_KEYS.factOfTheDay])).rows[0]?.ok;
    if (!got) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEYS.factOfTheDay]);
    } finally {
      client.release();
    }
  };
}

/**
 * Send Fact of the Day at most once per send period (09:00 UTC to the next),
 * whichever server instance gets there first and however often it is called
 * (Issue #1092). The period counts as sent once its completion is recorded,
 * so it is safe to call again after a failure, and at every start: a start
 * after 09:00 whose period has no completion sends at once, so a restart at
 * 09:00 no longer skips the day. Throws when it did not finish: nothing sent
 * (try again soon), or sent but not recorded (try again soon; the retry only
 * records).
 */
export async function runDailyFactOfTheDay(deps: DailySendDeps = {}): Promise<DailySendOutcome> {
  const mark = currentSendMark(deps.now ?? new Date()).getTime();
  const record = deps.record ?? (() => recordTaskCompleted("fact_of_the_day"));
  if (sentButUnrecordedFor === mark) {
    if (!(await record())) throw new Error("Fact of the Day was sent but its completion still cannot be recorded");
    sentButUnrecordedFor = null;
    return "sent";
  }
  const release = await (deps.lock ?? takeSendLock)();
  if (!release) return "another-instance-is-sending";
  try {
    const last = await (deps.lastCompleted ?? (() => lastTaskCompletion("fact_of_the_day")))();
    if (last && last.getTime() >= mark) return "already-sent";
    const result = await (deps.send ?? runFactOfTheDayJob)();
    logger.info(result, "Fact of the Day sent");
    if (!(await record())) {
      sentButUnrecordedFor = mark;
      throw new Error("Fact of the Day was sent but its completion could not be recorded");
    }
    return "sent";
  } finally {
    await release();
  }
}

/** Test seam. */
export function __resetDailySendForTest(): void {
  sentButUnrecordedFor = null;
}
