/**
 * Hash-based migration runner for drizzle migrations.
 *
 * ROOT CAUSE: drizzle-orm's built-in migrate() uses:
 *   SELECT ... ORDER BY created_at DESC LIMIT 1
 * and only applies a migration when:
 *   lastApplied.created_at < migration.folderMillis (journal `when`)
 *
 * Journal entries 0027–0029 were assigned `when` timestamps earlier than
 * 0026 (the last DDL migration), so drizzle-orm's ordering check silently
 * skips them every run. DML-only files also lack snapshot files that
 * drizzle-kit requires, causing drizzle-kit to skip them too.
 *
 * FIX: Track migrations by SHA-256 hash of the SQL file content (the same
 * value drizzle stores in the hash column). Look up all existing hashes,
 * apply any journal entry whose hash is absent, and record it — regardless
 * of `when` ordering.
 *
 * IDEMPOTENCY: DDL statements that fail because the object already exists
 * (PostgreSQL error classes 42P07/42701/42710/42P16/42P12) are treated as
 * pre-applied and skipped via SAVEPOINT recovery. This handles environments
 * where schema changes were applied manually outside of migration tracking
 * (e.g., post-deploy scripts, partial dev setups).
 *
 * CONCURRENCY: pg_advisory_lock(MIGRATION_LOCK_KEY) is held for the entire
 * duration of migration execution. If two server instances start simultaneously
 * (e.g. during a rolling deploy), the second blocks at the lock, then re-reads
 * applied hashes after acquiring it and finds nothing left to do.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

// Only suppress DDL "already exists" errors — these are safe to skip because
// the object is already in place. Data errors (e.g. 23505 unique_violation)
// are intentionally excluded so real DML bugs surface rather than being masked.
const DDL_ALREADY_EXISTS_CODES = new Set([
  "42P07", // duplicate_table
  "42701", // duplicate_column
  "42710", // duplicate_object (triggers, rules, etc.)
  "42P16", // invalid_table_definition (existing constraints)
  "42P12", // duplicate_index (via CREATE INDEX)
]);

// Fixed advisory lock key for the migration runner. Any 32-bit integer works;
// this value was chosen to be recognizable in pg_locks output.
// SELECT pid, granted FROM pg_locks WHERE classid = 7654 AND objid = 321;
const MIGRATION_LOCK_KEY = 76_543_21;

export function getMigrationsFolder(): string {
  if (process.env.DRIZZLE_MIGRATIONS_FOLDER) {
    return process.env.DRIZZLE_MIGRATIONS_FOLDER;
  }
  const candidateDistMigrations = path.join(__dirname, "migrations");
  if (fs.existsSync(candidateDistMigrations)) {
    return candidateDistMigrations;
  }
  return path.join(__dirname, "../migrations");
}

export async function applyMigrations(client: pg.PoolClient): Promise<{ applied: number; skipped: number; total: number }> {
  const migrationsFolder = getMigrationsFolder();
  const journalPath = path.join(migrationsFolder, "meta/_journal.json");

  if (!fs.existsSync(journalPath)) {
    throw new Error(`Cannot find journal at ${journalPath}`);
  }

  const journal: Journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = journal.entries;

  // Acquire the session-level advisory lock before touching any migration state.
  // pg_advisory_lock blocks (does not throw) if another session holds the lock,
  // so concurrent server instances serialise naturally. The lock is released
  // in the finally block below via pg_advisory_unlock, ensuring it is freed
  // even if the migration fails — the connection is reused by the pool and the
  // lock must not linger on it.
  console.log(`[migrate] Acquiring advisory lock (key=${MIGRATION_LOCK_KEY})...`);
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  console.log("[migrate] Advisory lock acquired.");

  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    // Re-read applied hashes *after* acquiring the lock. If another instance
    // was ahead of us and already applied migrations while we were waiting,
    // we will see their work here and skip cleanly.
    const { rows: applied } = await client.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations",
    );
    const appliedHashes = new Set(applied.map((r) => r.hash));

    let appliedCount = 0;
    let skippedCount = 0;

    for (const entry of entries) {
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        throw new Error(`Missing migration file: ${sqlPath}`);
      }

      const sql = fs.readFileSync(sqlPath, "utf8");
      const hash = crypto.createHash("sha256").update(sql).digest("hex");

      if (appliedHashes.has(hash)) {
        skippedCount++;
        continue;
      }

      console.log(`[migrate] Applying ${entry.tag}`);

      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await client.query("BEGIN");
      try {
        for (const stmt of statements) {
          await client.query("SAVEPOINT migration_stmt");
          try {
            await client.query(stmt);
            await client.query("RELEASE SAVEPOINT migration_stmt");
          } catch (stmtErr) {
            const code = (stmtErr as { code?: string }).code;
            if (code && DDL_ALREADY_EXISTS_CODES.has(code)) {
              await client.query("ROLLBACK TO SAVEPOINT migration_stmt");
              await client.query("RELEASE SAVEPOINT migration_stmt");
              console.warn(
                `[migrate] ${entry.tag}: statement skipped (already applied, code ${code}): ${stmt.slice(0, 80).replace(/\s+/g, " ")}…`,
              );
            } else {
              await client.query("ROLLBACK TO SAVEPOINT migration_stmt");
              await client.query("RELEASE SAVEPOINT migration_stmt");
              throw stmtErr;
            }
          }
        }
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [hash, entry.when],
        );
        await client.query("COMMIT");
        appliedHashes.add(hash);
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Failed to apply migration ${entry.tag}: ${err}`);
      }
    }

    // Verification: the count of journal-entry hashes recorded in
    // drizzle.__drizzle_migrations must equal the number of journal entries.
    // Extra rows (e.g. from legacy seeding) are acceptable, but every journal
    // entry must have exactly one matching row. If counts diverge the runner
    // exits non-zero with a clear message identifying the missing entries.
    const journalHashes = entries.map((entry) => {
      const sql = fs.readFileSync(
        path.join(migrationsFolder, `${entry.tag}.sql`),
        "utf8",
      );
      return { tag: entry.tag, hash: crypto.createHash("sha256").update(sql).digest("hex") };
    });

    const { rows: matchRows } = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])",
      [journalHashes.map((j) => j.hash)],
    );
    const matchedCount = Number(matchRows[0].count);
    const journalCount = entries.length;

    if (matchedCount !== journalCount) {
      const { rows: finalRows } = await client.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__drizzle_migrations",
      );
      const finalHashes = new Set(finalRows.map((r) => r.hash));
      const missingTags = journalHashes
        .filter((j) => !finalHashes.has(j.hash))
        .map((j) => j.tag);
      throw new Error(
        `Migration verification failed: expected ${journalCount} journal entries recorded in drizzle.__drizzle_migrations, found ${matchedCount}.\n` +
          `Missing: ${missingTags.join(", ")}\n` +
          `Run \`pnpm --filter @workspace/db run migrate\` again or check for SQL errors above.`,
      );
    }

    return { applied: appliedCount, skipped: skippedCount, total: entries.length };
  } finally {
    // Always release the advisory lock, even if migration failed. Failing to
    // release would hold the lock until this connection is closed (it is a
    // session-level lock), which would block future migration runs on pooled
    // connections.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      console.log("[migrate] Advisory lock released.");
    } catch (unlockErr) {
      console.warn(`[migrate] Warning: failed to release advisory lock: ${unlockErr}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
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
}
