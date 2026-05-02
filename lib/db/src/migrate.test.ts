/**
 * Concurrency tests for the migration runner.
 *
 * The pg_advisory_lock path in applyMigrations() serialises concurrent
 * server startups (e.g. during a rolling deploy). Without the lock, two
 * instances starting at the same time would both observe the same set of
 * applied hashes, both apply the missing migrations, and end up writing
 * duplicate rows into drizzle.__drizzle_migrations — and, worse, applying
 * DDL twice. These tests guard that path.
 *
 * Approach:
 *   1. Build a temporary migrations folder containing two synthetic
 *      DDL migrations, and point applyMigrations() at it via the
 *      DRIZZLE_MIGRATIONS_FOLDER env var (already supported by the
 *      runner for exactly this kind of override).
 *   2. Run two applyMigrations() calls concurrently against the real
 *      Postgres test database, each on its own pool client.
 *   3. Assert: the synthetic migration hashes appear exactly once in
 *      drizzle.__drizzle_migrations, the synthetic tables exist exactly
 *      once, the totals match (one runner applied 2, the other 0), and
 *      neither call threw.
 *
 * The test deliberately uses the real drizzle.__drizzle_migrations
 * table (the runner hard-codes that name), but only inserts/queries
 * rows for the synthetic hashes, and cleans them up afterwards. The
 * real journal entries are untouched because they are not present in
 * the temporary journal we hand the runner.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

import { applyMigrations } from "./migrate.js";

const RUN_ID = crypto.randomBytes(4).toString("hex");
const TAG_A = `9001_concurrent_a_${RUN_ID}`;
const TAG_B = `9002_concurrent_b_${RUN_ID}`;
const TABLE_A = `migrate_test_a_${RUN_ID}`;
const TABLE_B = `migrate_test_b_${RUN_ID}`;
const SQL_A = `CREATE TABLE "${TABLE_A}" (id integer PRIMARY KEY);`;
const SQL_B = `CREATE TABLE "${TABLE_B}" (id integer PRIMARY KEY);`;
const HASH_A = crypto.createHash("sha256").update(SQL_A).digest("hex");
const HASH_B = crypto.createHash("sha256").update(SQL_B).digest("hex");

let tempDir: string;
let pool: pg.Pool;
let prevMigrationsFolder: string | undefined;

describe("applyMigrations() concurrency", () => {
  before(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL must be set to run lib/db migrate tests against a real Postgres.",
      );
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-concurrent-"));
    fs.mkdirSync(path.join(tempDir, "meta"));

    fs.writeFileSync(path.join(tempDir, `${TAG_A}.sql`), SQL_A);
    fs.writeFileSync(path.join(tempDir, `${TAG_B}.sql`), SQL_B);

    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1900000000000, tag: TAG_A, breakpoints: true },
        { idx: 1, version: "7", when: 1900000001000, tag: TAG_B, breakpoints: true },
      ],
    };
    fs.writeFileSync(
      path.join(tempDir, "meta/_journal.json"),
      JSON.stringify(journal, null, 2),
    );

    prevMigrationsFolder = process.env.DRIZZLE_MIGRATIONS_FOLDER;
    process.env.DRIZZLE_MIGRATIONS_FOLDER = tempDir;

    // Pool size must be >= 2 so both concurrent runners can hold a client
    // simultaneously. pg's default max is 10, but we set explicitly for
    // clarity and to insulate against future env-driven changes.
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
    });

    // Pre-clean any leftovers from a previous interrupted run that shared
    // the same RUN_ID (extremely unlikely with random hex, but cheap).
    const cleanup = await pool.connect();
    try {
      await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_A}"`);
      await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_B}"`);
      await cleanup.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
        [[HASH_A, HASH_B]],
      );
    } catch {
      // Table drizzle.__drizzle_migrations may not exist yet on a fresh
      // DB; the runner will create it. Ignore.
    } finally {
      cleanup.release();
    }
  });

  after(async () => {
    try {
      const cleanup = await pool.connect();
      try {
        await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_A}"`);
        await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_B}"`);
        await cleanup.query(
          `DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
          [[HASH_A, HASH_B]],
        );
      } finally {
        cleanup.release();
      }
    } finally {
      await pool.end();
      if (prevMigrationsFolder === undefined) {
        delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
      } else {
        process.env.DRIZZLE_MIGRATIONS_FOLDER = prevMigrationsFolder;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies each migration exactly once when two callers race at startup", async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();

    let r1: Awaited<ReturnType<typeof applyMigrations>>;
    let r2: Awaited<ReturnType<typeof applyMigrations>>;
    try {
      // Promise.all surfaces the first rejection — if either runner
      // throws, the test fails with that error.
      [r1, r2] = await Promise.all([applyMigrations(c1), applyMigrations(c2)]);
    } finally {
      c1.release();
      c2.release();
    }

    // Both runners should report total=2 (the size of our synthetic journal).
    assert.equal(r1.total, 2, "runner 1 should see 2 journal entries");
    assert.equal(r2.total, 2, "runner 2 should see 2 journal entries");

    // Exactly two migrations were applied across both runners — never four.
    const totalApplied = r1.applied + r2.applied;
    assert.equal(
      totalApplied,
      2,
      `expected 2 total migrations applied across both runners, got ${totalApplied} (r1=${r1.applied}, r2=${r2.applied})`,
    );

    // The second caller (whichever it was) must have exited cleanly with
    // 0 applied and 2 skipped — proving it acquired the lock, re-read the
    // applied hashes, and saw the work was already done.
    const looser = r1.applied === 0 ? r1 : r2;
    const winner = r1.applied === 0 ? r2 : r1;
    assert.equal(looser.applied, 0, "second caller should have applied 0 migrations");
    assert.equal(looser.skipped, 2, "second caller should have skipped both migrations");
    assert.equal(winner.applied, 2, "first caller should have applied both migrations");
    assert.equal(winner.skipped, 0, "first caller should have skipped 0 migrations");

    // Verify the persisted state: each synthetic hash appears exactly
    // once in drizzle.__drizzle_migrations.
    const probe = await pool.connect();
    try {
      const { rows } = await probe.query<{ hash: string; count: string }>(
        `SELECT hash, COUNT(*)::text AS count
         FROM drizzle.__drizzle_migrations
         WHERE hash = ANY($1::text[])
         GROUP BY hash`,
        [[HASH_A, HASH_B]],
      );

      const byHash = new Map(rows.map((r) => [r.hash, Number(r.count)]));
      assert.equal(
        byHash.get(HASH_A),
        1,
        `migration ${TAG_A} should be recorded exactly once (got ${byHash.get(HASH_A) ?? 0})`,
      );
      assert.equal(
        byHash.get(HASH_B),
        1,
        `migration ${TAG_B} should be recorded exactly once (got ${byHash.get(HASH_B) ?? 0})`,
      );

      // And the DDL itself ran exactly once: the synthetic tables exist
      // (a second run would have failed with duplicate_table 42P07 if the
      // lock had not serialised the runners).
      const { rows: tableRows } = await probe.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables
         WHERE tablename = ANY($1::text[])`,
        [[TABLE_A, TABLE_B]],
      );
      const tableNames = new Set(tableRows.map((t) => t.name));
      assert.ok(tableNames.has(TABLE_A), `expected table ${TABLE_A} to exist`);
      assert.ok(tableNames.has(TABLE_B), `expected table ${TABLE_B} to exist`);
    } finally {
      probe.release();
    }
  });

  it("throws a verification error naming any journal tag whose hash is missing from drizzle.__drizzle_migrations", async () => {
    // Regression guard for the verification block at the end of
    // applyMigrations(). That block is the runner's last line of defence
    // against the silent-skip failure mode that prompted the hash-based
    // runner: if a journal entry's hash never makes it into
    // drizzle.__drizzle_migrations, the deploy must fail loudly with the
    // missing tag named in the error so an operator can act on it.
    //
    // Simulating the divergence: we wrap the PoolClient so the INSERT into
    // drizzle.__drizzle_migrations for one specific hash is silently
    // dropped while every other query (including the surrounding BEGIN /
    // SAVEPOINT / COMMIT and the DDL itself) passes through to the real
    // client. After the apply loop completes, the journal references both
    // hashes but only one row is in the table — exactly the divergence the
    // verification block is designed to catch.
    const VERIFY_RUN_ID = crypto.randomBytes(4).toString("hex");
    const TAG_C = `9101_verify_c_${VERIFY_RUN_ID}`;
    const TAG_D = `9102_verify_d_${VERIFY_RUN_ID}`;
    const TABLE_C = `migrate_test_c_${VERIFY_RUN_ID}`;
    const TABLE_D = `migrate_test_d_${VERIFY_RUN_ID}`;
    const SQL_C = `CREATE TABLE "${TABLE_C}" (id integer PRIMARY KEY);`;
    const SQL_D = `CREATE TABLE "${TABLE_D}" (id integer PRIMARY KEY);`;
    const HASH_C = crypto.createHash("sha256").update(SQL_C).digest("hex");
    const HASH_D = crypto.createHash("sha256").update(SQL_D).digest("hex");

    const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-verify-"));
    fs.mkdirSync(path.join(verifyDir, "meta"));
    fs.writeFileSync(path.join(verifyDir, `${TAG_C}.sql`), SQL_C);
    fs.writeFileSync(path.join(verifyDir, `${TAG_D}.sql`), SQL_D);
    fs.writeFileSync(
      path.join(verifyDir, "meta/_journal.json"),
      JSON.stringify(
        {
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: 1900000100000, tag: TAG_C, breakpoints: true },
            { idx: 1, version: "7", when: 1900000101000, tag: TAG_D, breakpoints: true },
          ],
        },
        null,
        2,
      ),
    );

    const previousFolder = process.env.DRIZZLE_MIGRATIONS_FOLDER;
    process.env.DRIZZLE_MIGRATIONS_FOLDER = verifyDir;

    // Pre-clean any leftovers (extremely unlikely with random hex but cheap).
    const pre = await pool.connect();
    try {
      await pre.query(`DROP TABLE IF EXISTS "${TABLE_C}"`);
      await pre.query(`DROP TABLE IF EXISTS "${TABLE_D}"`);
      await pre.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
        [[HASH_C, HASH_D]],
      );
    } finally {
      pre.release();
    }

    const real = await pool.connect();

    // Proxy the PoolClient so calls to .query() pass through verbatim
    // EXCEPT the INSERT INTO drizzle.__drizzle_migrations for HASH_D, which
    // we silently swallow to simulate the silent-skip bug. Every other
    // method (release, on, etc.) is forwarded so the runner is unaware it
    // is talking to a wrapper.
    // Typed forwarder: pg.PoolClient.query is overloaded, but we only need
    // to forward the call verbatim, so a permissive callable signature
    // (no `any`) is sufficient and keeps the lint policy clean.
    type ForwardQuery = (...forwardedArgs: unknown[]) => unknown;
    const forwardQuery = (real.query as unknown as ForwardQuery).bind(real);

    const wrapped = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const [textOrConfig, params] = args;
            const text =
              typeof textOrConfig === "string"
                ? textOrConfig
                : (textOrConfig as { text?: string } | undefined)?.text;
            if (
              typeof text === "string" &&
              text.includes("INSERT INTO drizzle.__drizzle_migrations") &&
              Array.isArray(params) &&
              params[0] === HASH_D
            ) {
              return Promise.resolve({
                rows: [],
                rowCount: 0,
                command: "INSERT",
                oid: 0,
                fields: [],
              });
            }
            return forwardQuery(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as pg.PoolClient;

    try {
      await assert.rejects(
        applyMigrations(wrapped),
        (err: Error) => {
          // The error must clearly identify the verification stage so an
          // operator triaging a failed deploy knows what went wrong.
          assert.match(
            err.message,
            /Migration verification failed/,
            `expected verification-failure message, got: ${err.message}`,
          );
          // The missing tag must appear by name on the "Missing:" line so
          // the operator can act on it without spelunking the journal.
          assert.match(
            err.message,
            new RegExp(`Missing:[^\\n]*${TAG_D}`),
            `expected missing tag ${TAG_D} to be named in error, got: ${err.message}`,
          );
          // The non-missing tag must NOT be named — otherwise the message
          // would mislead the operator into chasing the wrong migration.
          assert.ok(
            !new RegExp(`Missing:[^\\n]*${TAG_C}`).test(err.message),
            `tag ${TAG_C} should not appear in Missing list, got: ${err.message}`,
          );
          return true;
        },
        "applyMigrations should throw a verification error naming the missing tag",
      );

      // Confirm the simulated divergence is real: HASH_C is persisted (its
      // INSERT was let through) but HASH_D is not (its INSERT was dropped).
      // Without this, the test could pass even if the verifier was throwing
      // for the wrong reason.
      const probe = await pool.connect();
      try {
        const { rows } = await probe.query<{ hash: string }>(
          `SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
          [[HASH_C, HASH_D]],
        );
        const hashes = new Set(rows.map((r) => r.hash));
        assert.ok(hashes.has(HASH_C), "HASH_C should have been recorded by the runner");
        assert.ok(
          !hashes.has(HASH_D),
          "HASH_D should be missing — the dropped INSERT is what the verifier must catch",
        );
      } finally {
        probe.release();
      }
    } finally {
      real.release();

      // Cleanup: drop synthetic tables and rows, restore env var, remove tempdir.
      const cleanup = await pool.connect();
      try {
        await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_C}"`);
        await cleanup.query(`DROP TABLE IF EXISTS "${TABLE_D}"`);
        await cleanup.query(
          `DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
          [[HASH_C, HASH_D]],
        );
      } finally {
        cleanup.release();
      }

      if (previousFolder === undefined) {
        delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
      } else {
        process.env.DRIZZLE_MIGRATIONS_FOLDER = previousFolder;
      }
      // Restore the test-suite-wide override so subsequent tests in this
      // describe block still see the synthetic A/B journal.
      process.env.DRIZZLE_MIGRATIONS_FOLDER = tempDir;

      fs.rmSync(verifyDir, { recursive: true, force: true });
    }
  });

  it("a third caller after the race sees 0 applied and reports both migrations skipped", async () => {
    // Re-running after the race must be a clean no-op — this is the same
    // code path a freshly-started instance hits when migrations are already
    // up to date. Catches regressions where the runner forgets to release
    // the lock or mis-counts skipped entries on the happy path.
    const c = await pool.connect();
    try {
      const result = await applyMigrations(c);
      assert.equal(result.applied, 0, "no migrations should be applied on a clean re-run");
      assert.equal(result.skipped, 2, "both migrations should be skipped on a clean re-run");
      assert.equal(result.total, 2);
    } finally {
      c.release();
    }
  });
});
