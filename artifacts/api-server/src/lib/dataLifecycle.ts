/**
 * @purpose exportUserData returns one user's row, sessions, search history and membership history; runRetentionWindowJobs deletes expired email-verification and password-reset tokens, search history over 90 days old, what pictures cost after 13 months and Stripe webhook audit rows after 90 days, and is run hourly while the process is up (index.ts) and daily by the maintenance call (lib/maintenance.ts).
 * @subsystem accounts-auth
 */
import { db, usersTable, sessionsTable, emailVerificationTokensTable, passwordResetTokensTable } from "@workspace/db";
import { searchHistoryTable, membershipHistoryTable, userGenerationCostsTable, stripeWebhookAuditTable } from "@workspace/db/schema";
import { eq, lt } from "drizzle-orm";

export async function exportUserData(userId: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [sessions, searchHistory, memberships] = await Promise.all([
    db.select().from(sessionsTable).where(eq(sessionsTable.userId, userId)),
    db.select().from(searchHistoryTable).where(eq(searchHistoryTable.userId, userId)),
    db.select().from(membershipHistoryTable).where(eq(membershipHistoryTable.userId, userId)),
  ]);
  return { user, sessions, searchHistory, memberships };
}

export interface RetentionWindowResult {
  expiredEmailTokensDeleted: number;
  expiredPasswordTokensDeleted: number;
  oldSearchHistoryDeleted: number;
  oldGenerationCostsDeleted: number;
  oldWebhookAuditDeleted: number;
}

/**
 * The search-history window, in days. The retention schedule
 * (`@workspace/db/retention-schedule`) states it, and a test holds the two equal.
 */
export const SEARCH_HISTORY_RETENTION_DAYS = 90;

/**
 * What a member's pictures cost, in months (David, Q15, 2026-11-18). The
 * spend limits read the current month or the last 30 days only. Stated in the
 * retention schedule too, and a test holds the two equal.
 */
export const GENERATION_COST_RETENTION_MONTHS = 13;

/** Stripe webhook deliveries' audit rows, in days (David, Q15, 2026-11-18). Stated in the retention schedule too. */
export const WEBHOOK_AUDIT_RETENTION_DAYS = 90;

export async function runRetentionWindowJobs(now = new Date()): Promise<RetentionWindowResult> {
  // It also deleted from `organization_invites` until launch Phase 14: no
  // migration ever created that table, so that first statement threw and the
  // whole job had never deleted anything.
  const tokenCutoff = now;
  const searchCutoff = new Date(now.getTime() - SEARCH_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const expiredEmailTokens = await db.delete(emailVerificationTokensTable).where(lt(emailVerificationTokensTable.expiresAt, tokenCutoff)).returning({ id: emailVerificationTokensTable.id });
  const expiredPasswordTokens = await db.delete(passwordResetTokensTable).where(lt(passwordResetTokensTable.expiresAt, tokenCutoff)).returning({ id: passwordResetTokensTable.id });
  const oldSearchHistory = await db.delete(searchHistoryTable).where(lt(searchHistoryTable.createdAt, searchCutoff)).returning({ id: searchHistoryTable.id });
  const costCutoff = new Date(now.getTime());
  costCutoff.setUTCMonth(costCutoff.getUTCMonth() - GENERATION_COST_RETENTION_MONTHS);
  const oldCosts = await db.delete(userGenerationCostsTable).where(lt(userGenerationCostsTable.createdAt, costCutoff)).returning({ id: userGenerationCostsTable.id });
  const auditCutoff = new Date(now.getTime() - WEBHOOK_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const oldAudit = await db.delete(stripeWebhookAuditTable).where(lt(stripeWebhookAuditTable.createdAt, auditCutoff)).returning({ id: stripeWebhookAuditTable.id });

  return {
    expiredEmailTokensDeleted: expiredEmailTokens.length,
    expiredPasswordTokensDeleted: expiredPasswordTokens.length,
    oldSearchHistoryDeleted: oldSearchHistory.length,
    oldGenerationCostsDeleted: oldCosts.length,
    oldWebhookAuditDeleted: oldAudit.length,
  };
}
