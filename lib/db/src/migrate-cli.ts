/**
 * Command-line entry for the migration runner: `pnpm --filter @workspace/db run migrate`.
 *
 * This lives apart from migrate.ts on purpose (#486). migrate.ts is bundled
 * into the api-server, where an "am I the entry point?" guard is true for
 * the bundle itself, so a CLI block there ran the migrations during module
 * evaluation on every production boot. This file is never imported, only
 * run, so it needs no guard. The server migrates through `runMigrations()`
 * in index.ts's startup sequence.
 */

import pg from "pg";

import { guardPool } from "./connectionErrors.js";
import { applyMigrations } from "./migrate.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
// A dropped connection mid-migration must fail the migration, not crash the
// process with an uncaught error event (#826).
guardPool(pool, "migration pool");
const client = await pool.connect();
// NOTE: the notice listener lives in applyMigrations(), not here — see the
// comment there. Registering it here too would double-print every notice for
// CLI runs and leave the deployment path uncovered.
try {
  const { applied, skipped, total } = await applyMigrations(client);
  console.log(
    `[migrate] Done: ${applied} applied, ${skipped} already up-to-date (${total} total in journal).`,
  );
} catch (err) {
  console.error(`[migrate] ERROR: ${err}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
