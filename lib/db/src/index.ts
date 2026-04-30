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

export * from "./schema";
