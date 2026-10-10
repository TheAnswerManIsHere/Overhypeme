/**
 * Seed the bootstrap admin user for non-Replit environments (the CI e2e-smoke
 * job, a bare local dev stack). POST /api/auth/dev-admin-login
 * (routes/localAuth.ts) mints a session for exactly this account, so the row
 * must exist before the Playwright smoke suite can authenticate.
 *
 * Imports the canonical BOOTSTRAP_ADMIN_EMAIL (src/lib/auth.ts) rather than
 * repeating the address, so the seeded row can never drift from the email the
 * login route looks up.
 *
 * Idempotent: no-op when the user already exists.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/seed-dev-admin.ts
 */

import { BOOTSTRAP_ADMIN_EMAIL } from "../src/lib/auth";
import { ensureBootstrapAdmin } from "./lib/bootstrapAdmin";

const { created } = await ensureBootstrapAdmin();
console.log(created ? `seeded admin user ${BOOTSTRAP_ADMIN_EMAIL}` : `admin user already present (${BOOTSTRAP_ADMIN_EMAIL})`);

process.exit(0);
