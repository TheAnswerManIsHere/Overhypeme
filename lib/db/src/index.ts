import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { applyMigrations } from "./migrate";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Detect whether the current process is the Node test runner.
 *
 * Two signals are needed to cover both ways the suite runs:
 *   • NODE_TEST_CONTEXT — set by Node in worker processes under the default
 *     (process) test isolation.
 *   • a bare `--test` flag — present when running with `--test-isolation=none`
 *     (the sharded runner), where tests execute in the launching process and
 *     NODE_TEST_CONTEXT is NOT set. The flag can arrive either on the Node
 *     command line (execArgv) or via the NODE_OPTIONS env var, so both are
 *     scanned. Matching is on the exact `--test` token, so sibling flags like
 *     `--test-concurrency` (which the dev server never sets anyway) don't
 *     produce a false positive.
 *
 * The dev server (`pnpm dev`) and production (`pnpm start`) match neither, so
 * they keep the normal long-lived idle-drain behavior.
 *
 * Exported for unit testing; not part of the public DB surface.
 */
export function detectNodeTestRunner(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
): boolean {
  if (env.NODE_TEST_CONTEXT != null) return true;
  if (execArgv.includes("--test")) return true;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  return nodeOptions.split(/\s+/).includes("--test");
}

const isNodeTestRunner = detectNodeTestRunner(process.env, process.execArgv);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Proactively recycle idle connections before Neon auto-suspend (~5 min) resets them.
  idleTimeoutMillis: 60_000,
  // Hard limit on connection lifetime to avoid stale TLS sessions.
  maxLifetimeSeconds: 3600,
  // Under the test runner, pg-pool unrefs idle timeout timers and client sockets
  // so Node exits cleanly the moment tests finish, instead of hanging up to
  // idleTimeoutMillis (60 s) waiting for idle connections to drain. This is
  // detected automatically (isNodeTestRunner) so it works no matter how a test
  // file is invoked — `pnpm test`, a single `node --test <file>`, or an IDE —
  // without depending on a hand-passed env var. TEST_DB_ALLOW_EXIT_ON_IDLE=1
  // remains as an explicit override for non-test scripts that want the same.
  allowExitOnIdle:
    isNodeTestRunner || process.env.TEST_DB_ALLOW_EXIT_ON_IDLE === "1",
});

// Without this handler, an ECONNRESET on an idle pool client (e.g. from Neon
// auto-suspend) becomes an uncaught exception and crashes the process.
// The pool automatically removes the errored client and opens a fresh one.
pool.on("error", (err) => {
  console.error("Idle db client error (pool will reconnect):", err.message);
});

export const db = drizzle(pool, { schema });

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    const { applied, skipped, total } = await applyMigrations(client);
    console.log(
      `[migrate] Done: ${applied} applied, ${skipped} already up-to-date (${total} total in journal).`,
    );
  } finally {
    client.release();
  }
}

/**
 * Drain and close the connection pool.
 *
 * Waits for all checked-out clients to be returned, then destroys every
 * connection and prevents the pool from creating new ones.  Useful for
 * scripts and integration-test suites that need an explicit, synchronous
 * shutdown signal (rather than relying on allowExitOnIdle).
 *
 * Note: pg's Pool.end() rejects any call after the first, so callers that
 * may invoke this more than once should guard with a flag.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}

export * from "./schema";
