import { db, usersTable, sessionsTable, emailVerificationTokensTable, passwordResetTokensTable } from "@workspace/db";
import { searchHistoryTable, membershipHistoryTable } from "@workspace/db/schema";
import { eq, lt, sql } from "drizzle-orm";

export async function exportUserData(userId: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [sessions, searchHistory, memberships] = await Promise.all([
    db.select().from(sessionsTable).where(eq(sessionsTable.userId, userId)),
    db.select().from(searchHistoryTable).where(eq(searchHistoryTable.userId, userId)),
    db.select().from(membershipHistoryTable).where(eq(membershipHistoryTable.userId, userId)),
  ]);
  return { user, sessions, searchHistory, memberships };
}

export async function runRetentionWindowJobs(now = new Date()) {
  const inviteCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const tokenCutoff = now;
  const searchCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const staleInvites = await db.execute(sql`DELETE FROM organization_invites WHERE created_at < ${inviteCutoff}`);
  const expiredEmailTokens = await db.delete(emailVerificationTokensTable).where(lt(emailVerificationTokensTable.expiresAt, tokenCutoff)).returning({ id: emailVerificationTokensTable.id });
  const expiredPasswordTokens = await db.delete(passwordResetTokensTable).where(lt(passwordResetTokensTable.expiresAt, tokenCutoff)).returning({ id: passwordResetTokensTable.id });
  const oldSearchHistory = await db.delete(searchHistoryTable).where(lt(searchHistoryTable.createdAt, searchCutoff)).returning({ id: searchHistoryTable.id });

  return {
    staleInvitesDeleted: Number((staleInvites as { rowCount?: number }).rowCount ?? 0),
    expiredEmailTokensDeleted: expiredEmailTokens.length,
    expiredPasswordTokensDeleted: expiredPasswordTokens.length,
    oldSearchHistoryDeleted: oldSearchHistory.length,
  };
}
