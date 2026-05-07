/**
 * NCMEC CyberTipline submission stub.
 *
 * Real ESP registration with NCMEC is an out-of-band operator task. Until
 * that is wired up, this module persists the report payload to
 * `ncmec_reports` and emails the admin notification address. The stable
 * function signature lets a future submission worker drop in without
 * touching call sites.
 *
 * Statutory context (US 18 USC § 2258A): once an ESP has actual knowledge
 * of apparent CSAM, the report and the supporting bytes must be preserved
 * for at least 90 days. We capture both at insertion time:
 *   - The report row defaults `evidence_retention_until = now() + 90 days`.
 *   - The bytes live in the restricted prefix; `objectStorage.deleteObject`
 *     refuses to delete them unless `force: true` is passed.
 */

import { db, usersTable } from "@workspace/db";
import { ncmecReportsTable, type NcmecMatchSource } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger";
import { sendEmail } from "../email";

export interface NcmecReportInput {
  matchSource: NcmecMatchSource;
  /** Object-storage path inside the restricted prefix. */
  evidenceUri: string;
  userId?: string | null;
  /** Anything else worth preserving (request headers, fact id, classifier raw). */
  requestMetadata?: Record<string, unknown>;
}

export async function submitNcmecReport(input: NcmecReportInput): Promise<{ id: number }> {
  const [row] = await db
    .insert(ncmecReportsTable)
    .values({
      matchSource: input.matchSource,
      evidenceUri: input.evidenceUri,
      userId: input.userId ?? null,
      requestMetadata: input.requestMetadata ?? null,
      submissionStatus: "pending",
    })
    .returning({ id: ncmecReportsTable.id });

  // Best-effort admin notification. Never fail the surrounding pipeline if
  // the email fails — the DB row is the source of truth.
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.isAdmin, true), eq(usersTable.adminNotifications, true), eq(usersTable.isActive, true)));
    const text =
      `A moderation hit needs CyberTipline submission.\n\n` +
      `Report row id: ${row?.id}\n` +
      `Match source: ${input.matchSource}\n` +
      `Evidence URI: ${input.evidenceUri}\n` +
      `User id: ${input.userId ?? "(anonymous)"}\n`;
    await Promise.all(
      admins
        .map((a) => a.email)
        .filter((e): e is string => !!e)
        .map((to) => sendEmail({ to, subject: `[NCMEC pending] ${input.matchSource} match`, text, html: `<pre>${text}</pre>` })),
    );
  } catch (err) {
    logger.warn({ err, reportId: row?.id }, "[ncmec] admin notification failed");
  }

  logger.warn(
    { reportId: row?.id, matchSource: input.matchSource, userId: input.userId ?? null },
    "[ncmec] report queued (real CyberTipline submission is out-of-band)",
  );
  return { id: row?.id ?? 0 };
}
