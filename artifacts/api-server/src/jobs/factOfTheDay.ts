import { BRAND_ORANGE } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { stripeStorage } from "../lib/stripeStorage";
import { logger } from "../lib/logger";
import { sendEmail, buildEmailShell, ctaButton, divider } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { renderPersonalized } from "../lib/renderCanonical";
import { ADVISORY_LOCK_KEYS } from "../lib/advisoryLockKeys";
import { lastTaskCompletion, RETRY_AFTER_FAILURE_MS, writeTaskCompletion } from "../lib/recurringTasks";
import type { TaskStep } from "../lib/taskScheduler";

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

type Recipient = { id: string; email: string; displayName: string | null; pronouns: string | null };
type Fact = { id: number; text: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function pickFact(): Promise<Fact | null> {
  const rows = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.isActive, true))
    .orderBy(desc(factsTable.score))
    .limit(100);
  const shuffled = rows.sort(() => Math.random() - 0.5);
  return (shuffled[0] as Fact | undefined) ?? null;
}

/**
 * Queue one Fact of the Day email per recipient inside `tx`. Any insert that
 * fails throws, so the caller's transaction rolls back whole: a committed
 * batch is always complete, never missing a member who could then only be
 * reached by sending everyone again.
 */
async function queueFactOfTheDay(
  tx: Tx,
  fact: Fact,
  recipients: Recipient[],
  opts: { insertUnderTestKey?: boolean },
): Promise<{ sent: number; skipped: number }> {
  logger.info({ count: recipients.length, factId: fact.id }, "Queueing Fact of the Day");
  let sent = 0;
  let skipped = 0;
  const manageUrl = `${getSiteBaseUrl()}/profile#membership`;
  for (const user of recipients) {
    if (!user.email) { skipped++; continue; }
    const renderedText = user.displayName
      ? renderPersonalized(fact.text, user.displayName, user.pronouns ?? null)
      : fact.text;
    const { subject, text, html } = buildFactOfTheDayEmail(renderedText, fact.id, manageUrl);
    await sendEmail({ to: user.email, kind: "fact_of_the_day", subject, text, html }, tx, { insertUnderTestKey: opts.insertUnderTestKey ?? false });
    sent++;
  }
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

export type DailySendOutcome =
  | { outcome: "sent"; sent: number; skipped: number }
  | { outcome: "already-sent" }
  | { outcome: "another-instance-is-sending" };

export interface DailySendDeps {
  now?: Date;
  fact?: () => Promise<Fact | null>;
  recipients?: () => Promise<Recipient[]>;
  /** Tests only: write queue rows under the test key so they can be counted. */
  insertUnderTestKey?: boolean;
  /** Tests only: called inside the transaction after the emails are queued, before the mark. */
  beforeMark?: () => Promise<void>;
}

/**
 * Fact of the Day, at most once per send period (09:00 UTC to the next), for
 * every instance, every entry point and every retry (Issue #1092).
 *
 * One transaction holds the whole decision: a transaction-scoped advisory
 * lock (one sender at a time across the fleet), the period's mark read, every
 * email queued, and the mark written. Either all of it commits or none of it
 * does, so a period with any email queued can never read as unsent, and a
 * period that failed part-way has queued nothing and is safe to try again —
 * whether that is the scheduler's retry, the catch-up after a start, or the
 * jobs route. The mark is the task's completion row, written exactly (it
 * throws, and skips the recorder's throttle), so the health check sees the
 * send in the same commit.
 *
 * Throws when it did not finish; nothing was queued, and the caller tries
 * again soon. "another-instance-is-sending" is not done either: the caller
 * looks again shortly, until it reads the mark itself.
 */
export async function runDailyFactOfTheDay(deps: DailySendDeps = {}): Promise<DailySendOutcome> {
  const now = deps.now ?? new Date();
  const mark = currentSendMark(now).getTime();
  return db.transaction(async (tx) => {
    const got = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEYS.factOfTheDay}) AS ok`);
    if (!(got.rows[0] as { ok?: boolean } | undefined)?.ok) return { outcome: "another-instance-is-sending" } as const;
    const last = await lastTaskCompletion("fact_of_the_day", tx);
    if (last && last.getTime() >= mark) return { outcome: "already-sent" } as const;

    const fact = await (deps.fact ?? pickFact)();
    let result = { sent: 0, skipped: 0 };
    if (!fact) {
      logger.warn("No facts found for Fact of the Day");
    } else {
      let recipients: Recipient[];
      try {
        recipients = await (deps.recipients ?? (() => stripeStorage.getActiveLegendarySubscribers()))();
      } catch (err) {
        // A failed run, not an empty one: nothing is queued, and it is tried again soon.
        logger.error({ err }, "Failed to fetch legendary subscribers");
        throw err;
      }
      result = await queueFactOfTheDay(tx, fact, recipients, { insertUnderTestKey: deps.insertUnderTestKey });
    }
    await deps.beforeMark?.();
    await writeTaskCompletion("fact_of_the_day", now, tx);
    logger.info(result, "Fact of the Day queued");
    return { outcome: "sent", ...result } as const;
  });
}

/**
 * The scheduler's step (index.ts). It records nothing itself beyond what the
 * transaction does; a busy lock is not done, so it asks to look again shortly
 * until this instance reads the day's mark itself.
 */
export function factOfTheDayStep(deps: DailySendDeps = {}): TaskStep {
  return {
    id: "fact_of_the_day",
    recordsItself: true,
    run: async () => {
      const result = await runDailyFactOfTheDay(deps);
      if (result.outcome === "another-instance-is-sending") return { followUpMs: RETRY_AFTER_FAILURE_MS };
      if (result.outcome === "already-sent") logger.info(result, "Fact of the Day already sent this period");
      return undefined;
    },
    failureMessage: "Fact of the Day job failed",
  };
}
