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

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Proactively recycle idle connections before Neon auto-suspend (~5 min) resets them.
  idleTimeoutMillis: 60_000,
  // Hard limit on connection lifetime to avoid stale TLS sessions.
  maxLifetimeSeconds: 3600,
  // When TEST_DB_ALLOW_EXIT_ON_IDLE=1 (set by the test runner), pg-pool unrefs idle
  // timeout timers and client sockets so Node can exit cleanly once the test process
  // finishes without waiting up to idleTimeoutMillis (60 s) for connections to drain.
  allowExitOnIdle: process.env.TEST_DB_ALLOW_EXIT_ON_IDLE === "1",
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
