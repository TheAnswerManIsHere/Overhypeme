/**
 * Runs the server's database boot steps — and only those — against
 * DATABASE_URL, in the order index.ts runs them: the migration runner,
 * ensureSchema() (idempotent schema and config seeds), then the engine
 * catalogue reconcile. Nothing else the server does at boot writes a
 * configuration table (tableClassification.ts names them).
 *
 * Launch Phase 3, increment 3 (#770; plan §3): the config diff boots a freshly
 * built database with this, and the admin-value preservation test boots a
 * scratch database with it twice. A child process, because the steps use the
 * process-wide pool bound to DATABASE_URL at import.
 *
 * Run: DATABASE_URL=… pnpm --filter @workspace/api-server exec tsx scripts/boot-database.ts
 */

import { pool, runMigrations } from "@workspace/db";

import { ensureSchema } from "../src/lib/seed.js";
import { reconcileEngines } from "../src/lib/engines/index.js";

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");

try {
  await runMigrations();
  await ensureSchema();
  const engines = await reconcileEngines();
  console.log(`[boot-database] booted: ${engines.totalCodeEngines} engine(s) reconciled`);
} finally {
  await pool.end();
}
