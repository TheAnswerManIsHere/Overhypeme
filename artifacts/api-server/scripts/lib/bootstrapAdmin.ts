/**
 * Find or create the bootstrap admin row — the account `dev-admin-login`
 * mints a session for, and the grantor of the seeded paid E2E account. Shared
 * by `seed-dev-admin.ts` and `seed-e2e-test-accounts.ts` so the two seeds
 * cannot disagree about its shape. Uses the canonical BOOTSTRAP_ADMIN_EMAIL.
 */
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { BOOTSTRAP_ADMIN_EMAIL } from "../../src/lib/auth";

export async function ensureBootstrapAdmin(): Promise<{ id: string; label: string; created: boolean }> {
  const [existing] = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.email, BOOTSTRAP_ADMIN_EMAIL))
    .limit(1);
  if (existing) return { id: existing.id, label: existing.displayName ?? BOOTSTRAP_ADMIN_EMAIL, created: false };
  const [created] = await db
    .insert(usersTable)
    .values({ email: BOOTSTRAP_ADMIN_EMAIL, isAdmin: true, isActive: true, displayName: "Dev Admin" })
    .returning({ id: usersTable.id });
  return { id: created.id, label: "Dev Admin", created: true };
}
