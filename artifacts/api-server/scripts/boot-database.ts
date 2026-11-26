/**
 * Runs the server's database boot steps — and only those — against the
 * application's connection (APP_DATABASE_URL where set, else DATABASE_URL;
 * @workspace/db/connection), in the order index.ts runs them: the ownership
 * report, the migration runner (with its failure diagnosis), ensureSchema()
 * (idempotent schema and config seeds), then the [audit-boundary] report. Engines live only in
 * code since migration 0138, so there is no catalogue to reconcile. Nothing else the server does at boot writes a
 * configuration table (tableClassification.ts names them).
 *
 * Launch Phase 3, increment 3 (#770; plan §3): the config diff boots a freshly
 * built database with this, and the admin-value preservation test boots a
 * scratch database with it twice. A child process, because the steps use the
 * process-wide pool bound to DATABASE_URL at import.
 *
 * Run: DATABASE_URL=… pnpm --filter @workspace/api-server exec tsx scripts/boot-database.ts
 */

import { appDatabaseUrl, pool, runMigrations } from "@workspace/db";

import { reportAuditBoundary, reportOwnershipBeforeMigrations, runMigrationsWithDiagnosis } from "../src/lib/auditBoundaryReport.js";
import { ensureSchema } from "../src/lib/seed.js";

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");

try {
  await reportOwnershipBeforeMigrations();
  await runMigrationsWithDiagnosis(runMigrations);
  await ensureSchema();
  const outcome = await reportAuditBoundary();
  // One machine-readable line for the tests that boot a split database (Launch Phase 15, 5b):
  // the login the boot used, and what it found. Never the URL itself.
  console.log(
    `[boot-database] audit-boundary ${JSON.stringify({
      user: decodeURIComponent(new URL(appDatabaseUrl()).username),
      boundaryEnforced: outcome.status?.boundaryEnforced ?? null,
      ownershipDrift: outcome.ownershipDrift,
    })}`,
  );
  console.log("[boot-database] booted");
} finally {
  await pool.end();
}
