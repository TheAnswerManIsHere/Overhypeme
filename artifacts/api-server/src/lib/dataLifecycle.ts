import { db, usersTable, sessionsTable, emailVerificationTokensTable, passwordResetTokensTable } from "@workspace/db";
import { searchHistoryTable, subscriptionsTable, membershipHistoryTable, lifetimeEntitlementsTable } from "@workspace/db/schema";
import { and, eq, lt, or, sql } from "drizzle-orm";

export function anonymizedUserRef(userId: string): string {
  return `anon_${Buffer.from(userId).toString("base64url").slice(0, 16)}`;
}

export async function softDeleteUserLifecycle(userId: string) {
  const revoked = await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId)).returning({ sid: sessionsTable.sid });
  const [user] = await db.update(usersTable)
    .set({ isActive: false, email: null, pendingEmail: null, firstName: null, lastName: null, displayName: `Deleted User`, profileImageUrl: null, stripeCustomerId: null })
    .where(eq(usersTable.id, userId))
    .returning();
  return { user, sessionsRevoked: revoked.length };
}

export async function anonymizePaymentHistoryForUser(userId: string) {
  const ref = anonymizedUserRef(userId);
  await db.update(membershipHistoryTable)
    .set({ userId: ref, stripePaymentIntentId: sql`COALESCE(${membershipHistoryTable.stripePaymentIntentId}, '') || ${'_' + ref}` as unknown as string })
    .where(eq(membershipHistoryTable.userId, userId));

  await db.update(lifetimeEntitlementsTable)
    .set({ userId: ref, stripeCustomerId: `deleted_${ref}` })
    .where(eq(lifetimeEntitlementsTable.userId, userId));

  await db.update(subscriptionsTable)
    .set({ userId: ref, stripeCustomerId: `deleted_${ref}` })
    .where(eq(subscriptionsTable.userId, userId));

  return { anonymizedRef: ref };
}

export async function hardDeleteUserLifecycle(userId: string) {
  await db.delete(searchHistoryTable).where(eq(searchHistoryTable.userId, userId));
  await db.delete(emailVerificationTokensTable).where(eq(emailVerificationTokensTable.userId, userId));
  await db.delete(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, userId));
  const deleted = await db.delete(usersTable).where(eq(usersTable.id, userId)).returning({ id: usersTable.id });
  return { deleted: deleted.length > 0 };
}

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
