/**
 * Seed the two ordinary E2E accounts — one free, one paid — for browser and
 * API tests (Launch Phase 2, increment 2; #631).
 *
 * - Both are ordinary local accounts with a verified email and a password,
 *   signed in through the real `/api/auth/local-login` entry point, never
 *   through the dev-admin backdoor.
 * - The paid account is paid the way a real comp is: an admin grant written by
 *   `applyAdminGrant` (entitlement row + history + derived-tier recompute),
 *   granted by the bootstrap admin. The tier is never set directly.
 * - The account definitions live in `e2e-test-accounts.json`, which the
 *   Playwright helper reads too, so the two cannot drift.
 *
 * Refuses every protected database (the shared rule in
 * src/testing/productionModeGuard.ts) and any production or deployment
 * environment: these accounts carry a password published in this repository.
 *
 * Idempotent: an existing account keeps its row and has its password and
 * verification restored; a duplicate grant is a no-op.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/seed-e2e-test-accounts.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectedDatabaseRefusals } from "../src/testing/productionModeGuard";

const refusals = [
  ...protectedDatabaseRefusals(process.env.DATABASE_URL),
  ...((process.env.NODE_ENV ?? "").toLowerCase() === "production" ? ["NODE_ENV is production"] : []),
  ...(process.env.REPLIT_DEPLOYMENT === "1" ? ["REPLIT_DEPLOYMENT=1 marks a real deployment"] : []),
];
if (refusals.length > 0) {
  console.error(`[seed-e2e-test-accounts] refusing to seed:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(1);
}

interface AccountDefinition {
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  pronouns: string;
}

const definitions = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e-test-accounts.json"), "utf8"),
) as { password: string; free: AccountDefinition; paid: AccountDefinition };

// Only after the refusals: these imports reach the database.
const bcrypt = (await import("bcryptjs")).default;
const { db, usersTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { BOOTSTRAP_ADMIN_EMAIL } = await import("../src/lib/auth");
const { authorizeAdminGrant } = await import("../src/lib/entitlementVerification");
const { applyAdminGrant } = await import("../src/lib/membershipSources");

const passwordHash = await bcrypt.hash(definitions.password, Number(process.env.BCRYPT_SALT_ROUNDS ?? 10));

async function upsertAccount(def: AccountDefinition): Promise<string> {
  const email = def.email.toLowerCase();
  const values = {
    passwordHash,
    displayName: def.displayName,
    firstName: def.firstName,
    lastName: def.lastName,
    pronouns: def.pronouns,
    emailVerifiedAt: new Date(),
    isActive: true,
  };
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) {
    await db.update(usersTable).set(values).where(eq(usersTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(usersTable)
    .values({ ...values, email, captchaVerified: false })
    .returning({ id: usersTable.id });
  return created.id;
}

async function bootstrapAdmin(): Promise<{ id: string; label: string }> {
  const [existing] = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.email, BOOTSTRAP_ADMIN_EMAIL))
    .limit(1);
  if (existing) return { id: existing.id, label: existing.displayName ?? BOOTSTRAP_ADMIN_EMAIL };
  const [created] = await db
    .insert(usersTable)
    .values({ email: BOOTSTRAP_ADMIN_EMAIL, isAdmin: true, isActive: true, displayName: "Dev Admin" })
    .returning({ id: usersTable.id });
  return { id: created.id, label: "Dev Admin" };
}

const freeId = await upsertAccount(definitions.free);
const paidId = await upsertAccount(definitions.paid);
const admin = await bootstrapAdmin();

const { created } = await applyAdminGrant(
  authorizeAdminGrant({
    userId: paidId,
    grantedByAdminId: admin.id,
    grantedByAdminLabel: admin.label,
    grantReason: "E2E paid test account (seeded by scripts/seed-e2e-test-accounts.ts)",
  }),
);

const tiers = await db
  .select({ email: usersTable.email, tier: usersTable.membershipTier })
  .from(usersTable)
  .where(eq(usersTable.id, freeId))
  .union(db.select({ email: usersTable.email, tier: usersTable.membershipTier }).from(usersTable).where(eq(usersTable.id, paidId)));

console.log(`seeded E2E accounts (paid grant ${created ? "written" : "already active"}):`);
for (const row of tiers) console.log(`  ${row.email} → ${row.tier}`);

process.exit(0);
