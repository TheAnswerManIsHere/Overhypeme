/**
 * Migration 0097 — NCMEC CyberTipline submission, phase 1.
 *
 * This file pins the properties that a later phase would otherwise be free to
 * break silently. Three of them are about the DATABASE rather than about code,
 * which is the point: the append-only guarantee on `ncmec_safety_audit_log`
 * used to be "the module exports no delete helper", and a convention like that
 * can pass its own test while the property it claims is false.
 *
 * What is asserted here:
 *   1. Statics — journal entry, snapshot exemption, and lockstep between the
 *      SQL CHECK constraints / seed list and the TypeScript constants.
 *   2. Schema — every added column and index exists, and the widened
 *      submission_status CHECK accepts exactly the six statuses.
 *   3. Append-only — a direct UPDATE, DELETE **and** TRUNCATE all raise for a
 *      role that is not a member of `overhype_audit_maintenance`, and each
 *      succeeds for one that is. Run under an explicitly non-superuser role,
 *      because a superuser is an implicit member of every role and would make
 *      all six of these assertions vacuous.
 *   4. Backfill — quarantine_id is linked from server-written metadata,
 *      metadata-less rows stay NULL rather than being guessed at, malformed and
 *      dangling values are classified instead of aborting on a cast, and a
 *      conflicting pair aborts rather than being auto-picked.
 *   5. Re-runnability — applying the whole migration a second time succeeds.
 *
 * Every DB test runs inside a transaction that is rolled back, including the
 * CREATE ROLE / GRANT statements (role DDL is transactional in PostgreSQL), so
 * the suite leaves no residue.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

import {
  CONTENT_ORIGINS,
  NCMEC_SUBMISSION_STATUSES,
  NCMEC_FINAL_STATUSES,
  NCMEC_NONFINAL_STATUSES,
  NCMEC_AUDIT_ACTIONS,
} from "@workspace/db/schema";

import {
  NCMEC_RESERVED_CONFIG_KEYS,
  NCMEC_SEEDED_CONFIG_KEYS,
  isNcmecReservedConfigKey,
} from "../lib/moderation/ncmecConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DB = path.resolve(__dirname, "../../../../lib/db");
const MIGRATION_PATH = path.join(REPO_DB, "migrations/0097_ncmec_submission.sql");
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, "utf-8");

const BACKFILL_START = "-- >>> ncmec-0097 backfill block (start)";
const BACKFILL_END = "-- <<< ncmec-0097 backfill block (end)";

/** Every column 0097 adds. Also the teardown list for the 0094-state fixture. */
const NCMEC_REPORT_COLUMNS_0097 = [
  "finished_at", "finish_started_at", "attempt_count", "last_error", "last_error_code",
  "submission_environment", "uploaded_files", "retracted_at", "submission_lease_owner",
  "submission_lease_until", "manually_filed_at", "test_submitted_at",
  "test_submission_started_at", "test_report_id", "quarantine_id", "failed_at",
  "last_attempt_failed_at", "alert_notified_at", "content_origin", "reporter_snapshot",
  "backlog_audited_at", "backlog_audit_note", "identity_omission_approved_at",
  "manual_report_id",
];

const QUARANTINE_COLUMNS_0097 = [
  "content_origin", "report_intent", "reporter_snapshot", "request_metadata",
];

/** The migration text with drizzle's statement separators removed, ready to execute. */
function executableMigration(): string {
  return MIGRATION_SQL.split("--> statement-breakpoint").join("\n");
}

const GUARD_START = "-- >>> ncmec-0097 audit guard block (start)";
const GUARD_END = "-- <<< ncmec-0097 audit guard block (end)";

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = MIGRATION_SQL.indexOf(startMarker);
  const end = MIGRATION_SQL.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `sentinels ${startMarker} / ${endMarker} missing from 0097`);
  return MIGRATION_SQL.slice(start + startMarker.length, end);
}

/** Just the classify-then-link DO block, for replaying against fixtures. */
function backfillBlock(): string {
  return sliceBetween(BACKFILL_START, BACKFILL_END);
}

/** Just the ownership-aware audit-guard DO block. */
function auditGuardBlock(): string {
  return sliceBetween(GUARD_START, GUARD_END);
}

/**
 * The `fn_body` literal 0097 declares (a dollar-quoted string bounded by a repeated
 * `$body_src$` tag) — extracted so its exact text can be compared against
 * `NCMEC_AUDIT_LOG_GUARD_FN_BODY` in lib/db/src/index.ts, the copy `ncmecAuditBoundaryStatus()`
 * compares against `pg_proc.prosrc`. The two are hand-kept identical rather than shared
 * (a SQL migration and a TypeScript module can't literally import from each other); this is
 * what makes drift between them a test failure instead of a silent, weaker runtime check.
 */
function guardFnBodyLiteral(): string {
  const tag = "$body_src$";
  const start = MIGRATION_SQL.indexOf(tag);
  assert.ok(start >= 0, "fn_body's $body_src$ opening tag missing from 0097");
  const end = MIGRATION_SQL.indexOf(tag, start + tag.length);
  assert.ok(end > start, "fn_body's $body_src$ closing tag missing from 0097");
  return MIGRATION_SQL.slice(start + tag.length, end);
}

const OWNERSHIP_START = "-- >>> ncmec-0097 ownership hardening block (start)";
const OWNERSHIP_END = "-- <<< ncmec-0097 ownership hardening block (end)";

/** Just the DBA-provisioned-ownership-transfer DO block. */
function ownershipHardeningBlock(): string {
  return sliceBetween(OWNERSHIP_START, OWNERSHIP_END);
}

const ACTION_CHECK_START = "-- >>> ncmec-0097 action check block (start)";
const ACTION_CHECK_END = "-- <<< ncmec-0097 action check block (end)";

/** Just the inspect-then-reconcile block for the audit log's action vocabulary. */
function actionCheckBlock(): string {
  return sliceBetween(ACTION_CHECK_START, ACTION_CHECK_END);
}

describe("migration 0097 — static contract", () => {
  it("is registered in the journal and exempted from snapshot checking", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO_DB, "migrations/meta/_journal.json"), "utf-8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    const entry = journal.entries.find((e) => e.tag === "0097_ncmec_submission");
    assert.ok(entry, "journal does not include 0097_ncmec_submission");
    assert.equal(entry.idx, 97, "0097 must sit at journal idx 97");

    // 0094 is PR #288's worker_lane_heartbeats. If this ever fails, someone
    // renumbered a migration into a slot that is already taken.
    const at94 = journal.entries.find((e) => e.idx === 94);
    assert.equal(at94?.tag, "0094_worker_lane_heartbeats");

    const checkScript = fs.readFileSync(
      path.join(REPO_DB, "scripts/check-migration-snapshots.ts"),
      "utf-8",
    );
    assert.match(checkScript, /"0097_ncmec_submission"/);
  });

  it("submission_status CHECK is in lockstep with NCMEC_SUBMISSION_STATUSES", () => {
    const match = MIGRATION_SQL.match(
      /ADD CONSTRAINT "ncmec_reports_submission_status_check"\s*\n\s*CHECK \("submission_status" IN \(([^)]*)\)\)/,
    );
    assert.ok(match?.[1], "could not find the submission_status CHECK in 0097");
    const inSql = match[1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .sort();
    assert.deepEqual(
      inSql,
      [...NCMEC_SUBMISSION_STATUSES].sort(),
      "the SQL CHECK and NCMEC_SUBMISSION_STATUSES have drifted",
    );
  });

  it("ncmec_safety_audit_log's action CHECK is in lockstep with NCMEC_AUDIT_ACTIONS", () => {
    const match = MIGRATION_SQL.match(
      /ADD CONSTRAINT "ncmec_safety_audit_log_action_check"\s*\n\s*CHECK \("action" IN \(([^)]*)\)\)/,
    );
    assert.ok(match?.[1], "could not find the action CHECK in 0097");
    const inSql = match[1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .sort();
    assert.deepEqual(
      inSql,
      [...NCMEC_AUDIT_ACTIONS].sort(),
      "the SQL CHECK and NCMEC_AUDIT_ACTIONS have drifted",
    );
  });

  it("content_origin CHECKs are in lockstep with CONTENT_ORIGINS, on both tables", () => {
    const matches = [
      ...MIGRATION_SQL.matchAll(
        /CHECK \("content_origin" IS NULL OR "content_origin" IN \(([^)]*)\)\)/g,
      ),
    ];
    assert.equal(matches.length, 2, "expected a content_origin CHECK on both tables");
    for (const m of matches) {
      const inSql = (m[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .sort();
      assert.deepEqual(inSql, [...CONTENT_ORIGINS].sort());
    }
  });

  it("final and non-final statuses partition the vocabulary exactly", () => {
    assert.deepEqual(
      [...NCMEC_FINAL_STATUSES, ...NCMEC_NONFINAL_STATUSES].sort(),
      [...NCMEC_SUBMISSION_STATUSES].sort(),
      "every status must be exactly one of final or non-final",
    );
    for (const s of NCMEC_FINAL_STATUSES) {
      assert.ok(
        !(NCMEC_NONFINAL_STATUSES as readonly string[]).includes(s),
        `${s} is listed as both final and non-final`,
      );
    }
  });

  it("seeds exactly the keys ncmecConfig declares, and reserves exactly five", () => {
    const seedSection = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('INSERT INTO "admin_config"'));
    const seeded = [...seedSection.matchAll(/^\s*\('([a-z0-9_]+)',/gm)].map((m) => m[1]);
    assert.deepEqual(
      [...seeded].sort(),
      [...NCMEC_SEEDED_CONFIG_KEYS].sort(),
      "0097's seed list and NCMEC_SEEDED_CONFIG_KEYS have drifted",
    );

    // The count is asserted on purpose. An earlier revision of this policy said
    // "four", written before the backlog-audit key was split into a scope
    // boundary and a completion marker — a reserved list that is one short is a
    // list with a hole in exactly the key that was added last.
    assert.equal(NCMEC_RESERVED_CONFIG_KEYS.length, 5);
    for (const key of NCMEC_RESERVED_CONFIG_KEYS) {
      assert.ok(
        (NCMEC_SEEDED_CONFIG_KEYS as readonly string[]).includes(key),
        `${key} is reserved but never seeded — the generic route would 404 before it refused`,
      );
      assert.ok(isNcmecReservedConfigKey(key));
    }
    // The alert recipient is deliberately NOT reserved: it cannot cause a
    // filing, and reserving it would make a routine operational edit need a
    // bespoke endpoint. It is guarded by the activation gate instead.
    assert.equal(isNcmecReservedConfigKey("ncmec_safety_alert_email"), false);
  });

  it("the unique quarantine index is created after the backfill, not before", () => {
    const backfillAt = MIGRATION_SQL.indexOf(BACKFILL_START);
    const indexAt = MIGRATION_SQL.indexOf('UQ_ncmec_reports_quarantine');
    assert.ok(backfillAt >= 0 && indexAt >= 0);
    assert.ok(
      backfillAt < indexAt,
      "the backfill must run first, or a pre-existing duplicate is silently skipped instead of surfacing",
    );
  });

  it("every index and CHECK 0097 creates is also declared in the Drizzle schema", () => {
    // `drizzle-kit push --force` reconciles the database to the Drizzle snapshot and
    // auto-approves data-loss statements, so an object that lives only in a numbered
    // migration can be dropped by a push — and the hash-based migrator will not recreate it,
    // because 0097 is already recorded as applied. For UQ_ncmec_reports_quarantine, which is
    // a correctness constraint rather than a performance one, that silently becomes two
    // reports per hit.
    const schema = fs.readFileSync(path.join(REPO_DB, "src/schema/moderation.ts"), "utf-8");
    const declared = [
      "IDX_ncmec_nonfinal",
      "IDX_ncmec_failed_unalerted",
      "UQ_ncmec_reports_quarantine",
      "ncmec_reports_submission_status_check",
      "ncmec_reports_content_origin_check",
      "quarantined_memes_content_origin_check",
      // The audit log's closed action vocabulary. Its stakes are the same as
      // UQ_ncmec_reports_quarantine's rather than an index's: the ledger is database-enforced
      // append-only, so a row written with an unknown action after a forced push silently
      // dropped this constraint could never be corrected through ordinary application access.
      "ncmec_safety_audit_log_action_check",
    ];
    for (const name of declared) {
      assert.match(MIGRATION_SQL, new RegExp(`"${name}"`), `${name} is not created by 0097`);
      assert.match(schema, new RegExp(`"${name}"`), `${name} exists only in raw SQL — a push would drop it`);
    }
  });

  it("the append-only triggers gate on an EFFECTIVE grant, never on a settable GUC", () => {
    // 'usage', not 'member'. On PostgreSQL 16 `CREATE ROLE` auto-grants the new
    // role to a CREATEROLE creator, so 'member' would be true for the very
    // application role the gate exists to stop — verified directly against this
    // repository's PostgreSQL 16 target.
    assert.match(MIGRATION_SQL, /pg_has_role\(current_user, 'overhype_audit_maintenance', 'usage'\)/);
    assert.doesNotMatch(MIGRATION_SQL, /pg_has_role\(current_user, 'overhype_audit_maintenance', 'member'\)/);
    // And the automatic grant is revoked rather than merely documented.
    assert.match(MIGRATION_SQL, /REVOKE overhype_audit_maintenance FROM %I/);
    // A session variable is not a privilege boundary: SET LOCAL is available to
    // the very role whose raw writes the trigger exists to block.
    assert.doesNotMatch(MIGRATION_SQL, /current_setting\s*\(/i);
    // BEFORE row triggers cancel the operation on a NULL return, so the
    // maintenance path must return OLD/NEW or the escape hatch silently
    // swallows the correction it exists to permit.
    //
    // Scoped to the guard function's own body, not the whole migration. The property under
    // test belongs exclusively to a BEFORE ROW trigger function — it says nothing about
    // ordinary PL/pgSQL elsewhere in the file, where returning NULL is just a return value.
    // As a whole-file grep this also failed against `pg_temp.ncmec_assume_path`, which
    // returns NULL to mean "no path to this role exists" and is not a trigger at all.
    assert.match(guardFnBodyLiteral(), /IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;/);
    assert.doesNotMatch(guardFnBodyLiteral(), /THEN RETURN NULL/);
    // A row trigger does not fire on TRUNCATE.
    assert.match(MIGRATION_SQL, /BEFORE TRUNCATE ON "ncmec_safety_audit_log"\s*\n\s*FOR EACH STATEMENT/);
  });
});

describe("migration 0097 — database behaviour (skipped when DATABASE_URL is unset)", () => {
  // Structural, rather than `import type { PoolClient } from "pg"`: `pg` is a dependency of
  // `@workspace/db`, not of this package, and adding it here to type four calls would be a
  // dependency edge bought for a test. Naming exactly the surface used also documents it.
  interface QueryResult<R> {
    rows: R[];
    rowCount: number | null;
  }
  interface PoolClient {
    query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }
  interface Pool {
    connect(): Promise<PoolClient>;
    query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<R>>;
  }

  let pool: Pool | null = null;
  let ncmecAuditBoundaryStatus:
    | typeof import("@workspace/db")["ncmecAuditBoundaryStatus"]
    | null = null;
  let NCMEC_AUDIT_LOG_GUARD_FN_BODY: string | null = null;

  before(async () => {
    // Only an ABSENT database is a reason to skip. Swallowing an import failure here would
    // turn a broken workspace artifact into `pool = null`, after which every assertion below
    // reports the misleading skip reason "DATABASE_URL not set" — and the whole migration
    // and privilege-boundary suite goes green without executing a single statement.
    if (!process.env.DATABASE_URL) return;
    const mod = await import("@workspace/db");
    // `pg`'s Pool carries callback overloads the structural type above deliberately omits.
    pool = mod.pool as unknown as Pool;
    ncmecAuditBoundaryStatus = mod.ncmecAuditBoundaryStatus;
    NCMEC_AUDIT_LOG_GUARD_FN_BODY = mod.NCMEC_AUDIT_LOG_GUARD_FN_BODY;
  });

  after(async () => {
    // The shared pool is closed by the suite's own teardown; nothing to do.
  });

  /** Run `fn` on a dedicated client inside a transaction that always rolls back. */
  async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    assert.ok(pool, "pool unavailable");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** Assert that `sql` raises, without poisoning the surrounding transaction. */
  async function expectRaises(client: PoolClient, sql: string, messageLike: RegExp): Promise<void> {
    const sp = `sp_${randomUUID().replace(/-/g, "")}`;
    await client.query(`SAVEPOINT ${sp}`);
    let raised: unknown;
    try {
      await client.query(sql);
    } catch (err) {
      raised = err;
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    assert.ok(raised, `expected ${sql} to raise, but it succeeded`);
    assert.match(String((raised as Error).message), messageLike);
  }

  /**
   * Run `sql` as a genuinely separate, authenticated, non-superuser connection.
   *
   * `SET ROLE` cannot be tested by nesting it inside `SET ROLE` on the shared
   * pool connection, the way every other role-scoped assertion in this file
   * does it. Verified directly: `SET ROLE target` is authorized against
   * **`session_user`**, not `current_user` — so once a session has
   * authenticated as a superuser, every subsequent `SET ROLE`, no matter how
   * many deep, succeeds regardless of the currently-assumed role's real
   * grants, because the superuser `session_user` never stops being the one
   * `SET ROLE` actually checks. `pg_has_role()` has no such quirk (it is a
   * plain catalog query keyed on whatever role name is passed to it), which
   * is why every other test in this file can safely use `SET ROLE` on the
   * shared connection — they gate on `pg_has_role`, not on `SET ROLE` itself
   * succeeding or failing. The migration's new ownership-assumption guard
   * gates on `SET ROLE` succeeding or failing, so testing it honestly
   * requires a connection whose `session_user` really is the restricted role
   * — a fresh `psql` process authenticating with that role's own password.
   */
  function execSqlAsLoginRole(login: string, password: string, sql: string): { ok: boolean; output: string } {
    assert.ok(pool, "pool unavailable");
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.username = login;
    dbUrl.password = password;
    try {
      const output = execFileSync("psql", [dbUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      return { ok: false, output: `${String(e.stdout ?? "")}${String(e.stderr ?? "")}` };
    }
  }

    /**
     * psql with the server's diagnostic stream folded in. `execSqlAsLoginRole` returns stdout
     * alone on a successful run, which is empty for a block whose entire output is
     * `RAISE WARNING`/`RAISE NOTICE` — those go to stderr. Any assertion about the DBA guidance
     * a SUCCESSFUL run printed has to read both streams; the failure-path assertions elsewhere
     * in this file already see stderr because the catch branch concatenates it.
     *
     * `login` null runs as the pool's own role.
     */
    function execSqlCapturingDiagnostics(
      login: string | null,
      password: string | null,
      sql: string,
    ): { ok: boolean; output: string } {
      assert.ok(pool, "pool unavailable");
      const dbUrl = new URL(process.env.DATABASE_URL!);
      if (login) {
        dbUrl.username = login;
        dbUrl.password = password!;
      }
      const r = spawnSync("psql", [dbUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
        encoding: "utf-8",
      });
      return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    }

  it("adds every ncmec_reports column the later phases write", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = NCMEC_REPORT_COLUMNS_0097;
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ncmec_reports' AND column_name = ANY($1)`,
      [expected],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...expected].sort());
  });

  it("adds the four quarantined_memes provenance columns", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = QUARANTINE_COLUMNS_0097;
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'quarantined_memes' AND column_name = ANY($1)`,
      [expected],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...expected].sort());
  });

  it("creates the three timer-query indexes, with their predicates intact", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'ncmec_reports'
          AND indexname IN ('IDX_ncmec_nonfinal','IDX_ncmec_failed_unalerted','UQ_ncmec_reports_quarantine')`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    assert.equal(byName.size, 3, `missing indexes: ${JSON.stringify([...byName.keys()])}`);

    // The alert_notified_at term is what keeps pass 3's result set small — in
    // steady state, empty. Partial on `failed` alone the index would grow with
    // the whole failure history and force every sweep to scan all of it.
    assert.match(byName.get("IDX_ncmec_failed_unalerted") ?? "", /alert_notified_at IS NULL/);
    assert.match(byName.get("IDX_ncmec_nonfinal") ?? "", /pending.*in_progress|in_progress.*pending/s);
    assert.match(byName.get("UQ_ncmec_reports_quarantine") ?? "", /UNIQUE/);
    assert.match(byName.get("UQ_ncmec_reports_quarantine") ?? "", /quarantine_id IS NOT NULL/);
  });

  it("accepts all six statuses and rejects one outside the vocabulary", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    await inRolledBackTx(async (client) => {
      for (const status of NCMEC_SUBMISSION_STATUSES) {
        await client.query(
          `INSERT INTO ncmec_reports (match_source, evidence_uri, submission_status)
           VALUES ('arachnid', 'restricted/quarantine/t.jpg', $1)`,
          [status],
        );
      }
      // `retracted` is deliberately NOT a status: retraction is a step within an
      // attempt, and a status would create a non-final state a crash could
      // strand a row in, outside every reconciler repair.
      await expectRaises(
        client,
        `INSERT INTO ncmec_reports (match_source, evidence_uri, submission_status)
         VALUES ('arachnid', 'restricted/quarantine/t.jpg', 'retracted')`,
        /submission_status_check/,
      );
    });
  });

  it("seeds the eight config keys with their documented defaults", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // Self-contained rather than reading ambient state: the sharded test runner
    // (run-tests-sharded.sh) clones each worker database from a template built by
    // `pg_dump --schema-only` — SCHEMA only, no data — so a migration's seed
    // INSERTs from the shared "pretest" migrate run are never present in a
    // worker's admin_config. Re-applying the migration inside the rolled-back
    // transaction guarantees the seeds exist for this assertion regardless of
    // which database state it runs against, the same self-contained pattern the
    // 0094->0097 transition test already uses.
    await inRolledBackTx(async (client) => {
      await client.query(executableMigration());
      const { rows } = await client.query<{ key: string; value: string }>(
        `SELECT key, value FROM admin_config WHERE key = ANY($1)`,
        [[...NCMEC_SEEDED_CONFIG_KEYS]],
      );
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      assert.equal(byKey.size, NCMEC_SEEDED_CONFIG_KEYS.length);
      assert.equal(byKey.get("ncmec_submission_enabled"), "false");
      assert.equal(byKey.get("ncmec_ispws_environment"), "test");
      assert.equal(byKey.get("ncmec_report_classifier_hits"), "false");
      // Load-bearing, not tidy: without these seeds production keeps the queue
      // defaults (5 attempts, 8h) and exhausts at ~10.5 hours while the design
      // assumes ~98.6. A test that injects the config would pass against a
      // production that never had it — so this reads what the migration itself
      // wrote, freshly, rather than trusting a row that might already be there.
      assert.equal(byKey.get("async_job_ncmec_submit_max_attempts"), "8");
      assert.equal(byKey.get("async_job_ncmec_submit_retry_delay_4_ms"), "86400000");
    });
  });

  it("gives the retry keys bounds, so a typo cannot silently destroy the horizon", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // Same self-containment reason as above.
    await inRolledBackTx(async (client) => {
      await client.query(executableMigration());
      const { rows } = await client.query<{ key: string; min_value: number | null; max_value: number | null }>(
        `SELECT key, min_value, max_value FROM admin_config
          WHERE key IN ('async_job_ncmec_submit_max_attempts','async_job_ncmec_submit_retry_delay_4_ms')`,
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.ok(row.min_value !== null, `${row.key} has no min_value`);
        assert.ok(row.max_value !== null, `${row.key} has no max_value`);
      }
    });
  });

  describe("ncmec_safety_audit_log is append-only in the database", () => {
    /**
     * Set up a non-superuser role holding exactly the privileges the
     * application has, and return its name. Running these assertions as the
     * suite's own role would make all of them vacuous: the sandbox role is a
     * SUPERUSER, and a superuser is an implicit member of every role — so
     * `pg_has_role(...)` returns true and the trigger lets everything through.
     */
    async function makeAppRole(client: PoolClient): Promise<string> {
      const role = `ncmec_t_${randomUUID().slice(0, 8)}`;
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ncmec_safety_audit_log TO ${role}`,
      );
      await client.query(
        `GRANT USAGE, SELECT ON SEQUENCE ncmec_safety_audit_log_id_seq TO ${role}`,
      );
      return role;
    }

    it("refuses an action value outside the closed vocabulary", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        // The persistent test DB was migrated once at session start, before this CHECK
        // constraint existed in the migration file — re-applying the (idempotent) migration
        // here picks it up within this rolled-back transaction, the same pattern other
        // constraint tests in this file already use.
        await client.query(executableMigration());
        await expectRaises(
          client,
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','not_a_real_action')`,
          /ncmec_safety_audit_log_action_check/,
        );
      });
    });

    it("refuses UPDATE, DELETE and TRUNCATE from a non-member role", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        const role = await makeAppRole(client);
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        for (const stmt of [
          `SET ROLE ${role}; UPDATE ncmec_safety_audit_log SET reason = 'rewritten'`,
          `SET ROLE ${role}; DELETE FROM ncmec_safety_audit_log`,
          `SET ROLE ${role}; TRUNCATE ncmec_safety_audit_log`,
        ]) {
          await expectRaises(client, stmt, /append-only/);
        }
      });
    });

    it("appending is still permitted from that same role", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        const role = await makeAppRole(client);
        await client.query(`SET ROLE ${role}`);
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','retry')`,
        );
        await client.query("RESET ROLE");
      });
    });

    it("permits each operation for a session holding overhype_audit_maintenance", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        const role = await makeAppRole(client);
        await client.query(`GRANT overhype_audit_maintenance TO ${role}`);
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        await client.query(`SET ROLE ${role}`);
        // These must actually take effect. A BEFORE row trigger that returned
        // NULL on the maintenance path would report success here while
        // cancelling the operation — failing closed while appearing to work,
        // which is worse than failing loudly.
        const upd = await client.query(`UPDATE ncmec_safety_audit_log SET reason = 'corrected'`);
        assert.ok(upd.rowCount && upd.rowCount > 0, "maintenance UPDATE affected no rows");
        const del = await client.query(`DELETE FROM ncmec_safety_audit_log`);
        assert.ok(del.rowCount && del.rowCount > 0, "maintenance DELETE affected no rows");
        await client.query(`TRUNCATE ncmec_safety_audit_log`);
        await client.query("RESET ROLE");
      });
    });

    it("leaves no automatic creator membership of the maintenance role behind", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // On PostgreSQL 16, `CREATE ROLE x` run by a CREATEROLE role auto-grants x to the
      // creator WITH ADMIN OPTION. Without the migration's explicit revoke, the application
      // role would be a member of the very role the append-only gate checks — "granted to
      // nobody" false from the instant the migration succeeded, and no DBA ownership step
      // would have fixed it, because that step transfers ownership rather than revoking a
      // membership nobody knew existed.
      const { rows } = await pool.query<{ member: string }>(
        `SELECT pg_get_userbyid(m.member) AS member
           FROM pg_auth_members m
          WHERE pg_get_userbyid(m.roleid) = 'overhype_audit_maintenance'`,
      );
      assert.deepEqual(rows.map((r) => r.member), [], "overhype_audit_maintenance must be granted to nobody");
    });

    it("closes the search_path shadowing bypass — pg_roles/pg_has_role resolve to the real catalog regardless of search_path", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The guard function has no SECURITY DEFINER and no SET search_path of its own, so it
      // runs under whatever search_path the CALLING session set. A role with CREATE on any
      // schema it can reach (here, one it owns outright) can set
      // search_path = <owned schema>, pg_catalog — naming pg_catalog explicitly defeats
      // Postgres's implicit-first search of it — and create pg_roles/pg_has_role shadow
      // objects that an UNQUALIFIED reference in the guard function would resolve to instead
      // of the real system catalog, letting the permissive shadow answer the privilege check.
      // Verified directly against this repository's PostgreSQL 16 target before the fix:
      // exactly this setup let the UPDATE below succeed. The fix schema-qualifies both
      // references as pg_catalog.pg_roles/pg_catalog.pg_has_role, which always resolve within
      // that namespace regardless of search_path — this test proves the UPDATE is still
      // refused even with the shadow objects and the hostile search_path in place.
      await inRolledBackTx(async (client) => {
        const role = await makeAppRole(client);
        // Resolved with the connection's ordinary, un-hijacked search_path — this is what
        // lets the UPDATE below still find the table by its unqualified name once
        // search_path is overridden to lead with the shadow schema; the shadow attack
        // targets pg_roles/pg_has_role resolution, not the table's own.
        const { rows: schemaRows } = await client.query<{ nspname: string }>(
          `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.oid = to_regclass('ncmec_safety_audit_log')`,
        );
        const ledgerSchema = schemaRows[0]?.nspname;
        assert.ok(ledgerSchema, "could not resolve ncmec_safety_audit_log's schema");
        const shadowSchema = `ncmec_shadow_${randomUUID().slice(0, 8)}`;
        await client.query(`CREATE SCHEMA ${shadowSchema} AUTHORIZATION ${role}`);
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        await client.query(`SET ROLE ${role}`);
        // shadowSchema leads (so an unqualified pg_roles/pg_has_role would hit the shadow
        // objects first under the OLD, vulnerable code), pg_catalog is named explicitly
        // (defeating Postgres's implicit-first search of it), and ledgerSchema trails so the
        // UPDATE below can still resolve the table itself by its unqualified name.
        await client.query(`SET search_path = ${shadowSchema}, pg_catalog, ${ledgerSchema}`);
        await client.query(
          `CREATE VIEW ${shadowSchema}.pg_roles AS SELECT 'overhype_audit_maintenance'::name AS rolname`,
        );
        await client.query(
          `CREATE FUNCTION ${shadowSchema}.pg_has_role(name, text, text) RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql`,
        );
        await expectRaises(
          client,
          `UPDATE ncmec_safety_audit_log SET reason = 'shadowed bypass'`,
          /append-only/,
        );
        await client.query("RESET ROLE");
      });
    });

    /**
     * Both of these tests mutate real, COMMITTED state (a fresh LOGIN role must be
     * committed for a separate `psql` process to authenticate as it — see
     * `execSqlAsLoginRole`), unlike every other test in this file. Ownership is always
     * restored and the roles always dropped in `finally`, run against the shared `pool`
     * directly rather than through `inRolledBackTx`.
     */
    async function withOwnershipTransferredToRestrictedRole(
      mutate: (owner: string, app: string, appPassword: string) => Promise<void>,
      run: (app: string, appPassword: string) => Promise<void>,
    ): Promise<void> {
      assert.ok(pool, "pool unavailable");
      const owner = `ncmec_own_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE ROLE ${owner} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await mutate(owner, app, appPassword);
        await run(app, appPassword);
      } finally {
        // Ownership must move back to the pool's own role before either temp role can be
        // dropped, and before the shared table/function are usable by later tests again.
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        // The "guards are missing" test drops a trigger and never gets far enough (by
        // design) to have it recreated. Re-running the guard block now, as the pool's own
        // role which owns everything again, cleanly recreates or verifies both — restoring
        // full protection for every test that runs after this one.
        await pool.query(auditGuardBlock());
        // DROP ROLE refuses a role that still holds any GRANT, not only ownership — the
        // SELECT/INSERT grants above must go too, or the drop fails with "role cannot be
        // dropped because some objects depend on it".
        await pool.query(`DROP OWNED BY ${owner}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${owner}`);
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
      }
    }

    it("re-runs cleanly when the ledger is owned by a role this session cannot touch", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The recovery case: schema survived, migration tracking did not. After the DBA
      // hardening step an unguarded `CREATE OR REPLACE FUNCTION` fails with "must be owner
      // of function", so the guard must verify-and-continue instead.
      await withOwnershipTransferredToRestrictedRole(
        async (owner, app) => {
          await pool!.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${owner}`);
          await pool!.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${owner}`);
          await pool!.query(`GRANT SELECT, INSERT ON ncmec_safety_audit_log TO ${app}`);
        },
        async (app, appPassword) => {
          // A role that is a member of neither the owner nor the maintenance role — the
          // whole point, and now genuinely tested: this is `session_user`, not a nested
          // `SET ROLE` on a superuser connection.
          const result = execSqlAsLoginRole(app, appPassword, auditGuardBlock());
          assert.ok(result.ok, `expected the guard block to succeed cleanly; got: ${result.output}`);
        },
      );
    });

    it("refuses to continue when the guard function's own body no longer implements the check", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // `CREATE OR REPLACE FUNCTION` preserves the function's oid, so a hardened recovery
      // database where the body was swapped for something permissive BEFORE ownership moved
      // to the restricted role would still satisfy a tgfoid match — the trigger genuinely
      // calls "the function named ncmec_safety_audit_log_append_only", it just no longer does
      // what that name promises. Verifying only wiring (trigger name/enabled/tgfoid/tgtype)
      // cannot catch this; the function's own source has to be inspected too.
      await withOwnershipTransferredToRestrictedRole(
        async (owner, app) => {
          await pool!.query(`
            CREATE OR REPLACE FUNCTION ncmec_safety_audit_log_append_only() RETURNS trigger AS $body$
            BEGIN
              -- Permissive: lets every operation through unconditionally. Same signature,
              -- same name, same trigger wiring — only the body changed.
              IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
              RETURN NEW;
            END; $body$ LANGUAGE plpgsql;
          `);
          await pool!.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${owner}`);
          await pool!.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${owner}`);
          await pool!.query(`GRANT SELECT, INSERT ON ncmec_safety_audit_log TO ${app}`);
        },
        async (app, appPassword) => {
          const result = execSqlAsLoginRole(app, appPassword, auditGuardBlock());
          assert.equal(result.ok, false, "expected the guard block to refuse a tampered function body");
          assert.match(result.output, /refusing to leave the ledger unguarded/);
        },
      );
    });

    it("refuses to continue when the ledger is unreachable AND its guards are missing", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // Verify-and-continue is only correct while the guards are actually there. With them
      // gone and no way to recreate them, finishing quietly would leave the ledger
      // unguarded — which is worse than a failed migration.
      await withOwnershipTransferredToRestrictedRole(
        async (owner, app) => {
          await pool!.query(`DROP TRIGGER ncmec_safety_audit_log_no_mutate ON ncmec_safety_audit_log`);
          await pool!.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${owner}`);
          await pool!.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${owner}`);
          await pool!.query(`GRANT SELECT ON ncmec_safety_audit_log TO ${app}`);
        },
        async (app, appPassword) => {
          const result = execSqlAsLoginRole(app, appPassword, auditGuardBlock());
          assert.equal(result.ok, false, "expected the guard block to fail");
          assert.match(result.output, /refusing to leave the ledger unguarded/);
        },
      );
    });

    it("transfers ownership when the app role can SET ROLE to overhype_audit_owner but does not inherit it", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // pg_has_role(..., 'usage') answers whether overhype_audit_owner's privileges are
      // INHERITED, not whether ALTER TABLE ... OWNER TO can succeed — verified directly
      // against this repository's PostgreSQL 16 target: that statement requires the ability
      // to SET ROLE to the new owner specifically ("must be able to SET ROLE ..."), and an
      // INHERIT FALSE, SET TRUE grant reports usage=false while the ALTER TABLE still
      // succeeds. The old `usage`-gated check would have wrongly skipped a transfer this
      // role can actually perform.
      assert.ok(pool, "pool unavailable");
      const app = `ncmec_dba_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) {
        await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      }
      // Required on PostgreSQL 15+, which no longer grants CREATE on the public schema to
      // every role by default — without this, ALTER TABLE ... OWNER TO fails with
      // "permission denied for schema public" (the NEW owner needs CREATE, not the executing
      // role). Matches the corrected DBA instructions this test is verifying. Issued
      // unconditionally rather than only when this test creates the role: roles are
      // cluster-wide, but this GRANT is per-database — a sharded test run's per-database
      // isolation means `overhype_audit_owner` existing elsewhere in the cluster says nothing
      // about whether it already holds CREATE on THIS database's public schema. GRANT is
      // idempotent, so re-issuing it when the role already existed (and already has it) is a
      // harmless no-op.
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        await pool.query(`GRANT overhype_audit_owner TO ${app} WITH INHERIT FALSE, SET TRUE`);

        const result = execSqlAsLoginRole(app, appPassword, ownershipHardeningBlock());
        assert.ok(result.ok, `expected the ownership transfer to succeed; got: ${result.output}`);

        const { rows } = await pool.query<{ owner: string }>(
          `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'ncmec_safety_audit_log'`,
        );
        assert.equal(rows[0]?.owner, "overhype_audit_owner");

        // This is the "normal", first-time hardening path: app_role owned both objects
        // outright right up until this block ran, so has_table_privilege(app_role, ...)
        // reported true via implicit OWNERSHIP before the transfer — a stale true that a
        // grants_done check reading has_table_privilege at that point would wrongly treat as
        // "already granted" and skip the GRANT statements entirely. Since this grant is
        // INHERIT FALSE, app_role's post-transfer privileges reflect only an explicit ACL
        // entry, not ownership (gone) or inherited membership (disabled) — so this check
        // fails exactly when that GRANT was wrongly skipped.
        const { rows: grantRows } = await pool.query<{ has_select: boolean; has_insert: boolean }>(
          `SELECT has_table_privilege($1, 'ncmec_safety_audit_log', 'SELECT') AS has_select,
                  has_table_privilege($1, 'ncmec_safety_audit_log', 'INSERT') AS has_insert`,
          [app],
        );
        assert.equal(grantRows[0]?.has_select, true, "the app role must end up with a durable SELECT grant");
        assert.equal(grantRows[0]?.has_insert, true, "the app role must end up with a durable INSERT grant");
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("preserves the role it was invoked under across its SET-ROLE probes", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // RESET ROLE returns to `session_user`, NOT to whichever role was current when the probe
      // started — verified directly against this repository's PostgreSQL 16 target. The block
      // probes `SET ROLE` against the ledger's schema owner on every run, so under the old
      // RESET ROLE the very first probe silently switched the session to session_user, and
      // every ownership, schema and grant check afterwards answered for the wrong role. A DBA
      // replaying the migration as the application role (`SET ROLE <app>; \i 0097.sql`) is the
      // realistic way in.
      assert.ok(pool, "pool unavailable");
      const mid = `ncmec_mid_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_probe_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE ROLE ${mid} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      await pool.query(`GRANT ${mid} TO ${app} WITH INHERIT TRUE, SET TRUE`);
      try {
        const result = execSqlCapturingDiagnostics(
          app,
          appPassword,
          `SET ROLE ${mid}; ${ownershipHardeningBlock()} ; SELECT current_user AS role_after;`,
        );
        assert.ok(result.ok, `expected the block to run cleanly; got: ${result.output}`);
        assert.match(
          result.output,
          new RegExp(mid),
          "the block must leave the session as the role it was entered under",
        );
        assert.doesNotMatch(
          result.output,
          new RegExp(`role_after[\\s-]*\\n\\s*${app}`),
          "RESET ROLE dropped the session back to session_user",
        );
      } finally {
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${mid}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        await pool.query(`DROP ROLE IF EXISTS ${mid}`);
      }
    });

    it("does not abort when the app can only INHERIT overhype_audit_owner and cannot SET ROLE to it", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The transfer branch runs `ALTER TABLE ... OWNER TO` and `SET LOCAL ROLE`, both of which
      // require SET access — verified directly against this repository's PostgreSQL 16 target
      // that an `INHERIT TRUE, SET FALSE` grant reports pg_has_role(...,'usage') = true while
      // both statements fail with "must be able to SET ROLE". Gating that branch on the broad
      // effective-access check therefore aborted the whole migration on exactly the grant shape
      // that check was widened to detect. It must fall through to the DBA guidance instead.
      assert.ok(pool, "pool unavailable");
      const app = `ncmec_inh_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) {
        await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      }
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        await pool.query(`GRANT overhype_audit_owner TO ${app} WITH INHERIT TRUE, SET FALSE`);

        const result = execSqlCapturingDiagnostics(app, appPassword, ownershipHardeningBlock());
        assert.ok(result.ok, `the block must not abort on an INHERIT-only grant; got: ${result.output}`);
        assert.match(result.output, /ALTER TABLE .* OWNER TO overhype_audit_owner/);
        // And it must not have silently claimed the transfer happened.
        const { rows } = await pool.query<{ owner: string }>(
          `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'ncmec_safety_audit_log'`,
        );
        assert.equal(rows[0]?.owner, app, "ownership must be left for the DBA, not half-moved");
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("names the indirect grant to revoke when the path to overhype_audit_owner runs through ADMIN OPTION", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The application holds no direct membership in overhype_audit_owner — it holds `helper`,
      // which carries ADMIN OPTION and can therefore grant itself membership at will. The old
      // instruction, `REVOKE overhype_audit_owner FROM <app>`, removes a membership that was
      // never there: it succeeds, changes nothing, and the next rerun prints the same text
      // again. A DBA following it literally can loop forever with the bypass wide open.
      assert.ok(pool, "pool unavailable");
      const helper = `ncmec_helper_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_adm_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) {
        await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      }
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${helper} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        // helper can administer overhype_audit_owner; app can become helper; app holds
        // overhype_audit_owner neither directly nor by inheritance.
        await pool.query(`GRANT overhype_audit_owner TO ${helper} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
        await pool.query(`GRANT ${helper} TO ${app} WITH INHERIT TRUE, SET TRUE`);

        const result = execSqlCapturingDiagnostics(app, appPassword, ownershipHardeningBlock());
        assert.ok(result.ok, `the block must not abort; got: ${result.output}`);
        assert.match(
          result.output,
          new RegExp(`REVOKE ${helper} FROM ${app}`),
          "the recovery text must name the link the application actually holds",
        );
        assert.match(result.output, /does NOT hold overhype_audit_owner directly/);
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${helper}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        await pool.query(`DROP ROLE IF EXISTS ${helper}`);
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("prints a second GRANT CREATE when the guard function lives in its own schema", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // PostgreSQL requires the NEW owner to hold CREATE on the schema containing the object
      // being reassigned. The ALTER FUNCTION line already targets the function's own schema, so
      // granting CREATE only on the table's schema leaves a DBA who follows these instructions
      // in order failing at the function transfer, having already completed the table's.
      //
      // Run as a dedicated non-superuser that owns both objects, which is what puts the block
      // in its DBA-guidance branch: a superuser is an implicit member of every role, so it
      // would take the transfer branch instead and print no guidance at all. The moved schema
      // is added to search_path because the block resolves the function through
      // to_regprocedure() — a function moved somewhere unreachable is a different scenario
      // from one moved to another schema the deployment actually uses.
      assert.ok(pool, "pool unavailable");
      const fnSchema = `ncmec_fn_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_fns_app_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE SCHEMA ${fnSchema}`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`GRANT USAGE, CREATE ON SCHEMA ${fnSchema} TO ${app}`);
        await pool.query(`GRANT CREATE ON SCHEMA public TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() SET SCHEMA ${fnSchema}`);
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ${fnSchema}.ncmec_safety_audit_log_append_only() OWNER TO ${app}`);

        const { output: result } = execSqlCapturingDiagnostics(
          app,
          appPassword,
          `SET search_path TO public, ${fnSchema}; ${ownershipHardeningBlock()}`,
        );
        assert.match(
          result,
          new RegExp(`GRANT CREATE ON SCHEMA ${fnSchema} TO overhype_audit_owner`),
          `the function's own schema needs its own GRANT CREATE; got: ${result}`,
        );
        assert.match(
          result,
          new RegExp(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`),
          "and the table's schema still needs its own",
        );
        assert.match(
          result,
          new RegExp(`ALTER FUNCTION ${fnSchema}\\.ncmec_safety_audit_log_append_only`),
          "and the ALTER FUNCTION must target that same schema",
        );
      } finally {
        await pool
          .query(`ALTER FUNCTION ${fnSchema}.ncmec_safety_audit_log_append_only() SET SCHEMA public`)
          .catch(() => {});
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`).catch(() => {});
        await pool
          .query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`)
          .catch(() => {});
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        await pool.query(`DROP SCHEMA IF EXISTS ${fnSchema} CASCADE`);
        await pool.query(auditGuardBlock());
      }
    });

    it("replays the action CHECK against a hardened ledger it no longer owns", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The hash-based migrator replays 0097 whenever migration tracking is lost or the file's
      // hash changes — including after a DBA has transferred the ledger. An unconditional
      // `ALTER TABLE ... DROP CONSTRAINT` there fails with "must be owner of table" and aborts
      // the migration before the ownership block, which is built to survive exactly this state,
      // ever runs. An already-correct constraint must be accepted untouched.
      await withOwnershipTransferredToRestrictedRole(
        async (owner, app) => {
          await pool!.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${owner}`);
          await pool!.query(`GRANT SELECT, INSERT ON ncmec_safety_audit_log TO ${app}`);
        },
        async (app, appPassword) => {
          const result = execSqlCapturingDiagnostics(app, appPassword, actionCheckBlock());
          assert.ok(result.ok, `expected the action CHECK block to replay cleanly; got: ${result.output}`);
          assert.match(result.output, /already present and correct/);
        },
      );
    });

    it("refuses, with owner-run commands, when the action CHECK has drifted on a ledger it cannot alter", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The other half of the previous test: accepting an already-correct constraint must not
      // become silently accepting a WRONG one. This ledger is database-enforced append-only, so
      // a row admitted under a drifted vocabulary could never be corrected afterwards.
      await withOwnershipTransferredToRestrictedRole(
        async (owner, app) => {
          await pool!.query(
            `ALTER TABLE ncmec_safety_audit_log DROP CONSTRAINT ncmec_safety_audit_log_action_check`,
          );
          await pool!.query(
            `ALTER TABLE ncmec_safety_audit_log ADD CONSTRAINT ncmec_safety_audit_log_action_check CHECK ("action" IN ('retry'))`,
          );
          await pool!.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${owner}`);
          await pool!.query(`GRANT SELECT, INSERT ON ncmec_safety_audit_log TO ${app}`);
        },
        async (app, appPassword) => {
          const result = execSqlAsLoginRole(app, appPassword, actionCheckBlock());
          assert.equal(result.ok, false, "a drifted constraint it cannot repair must be fatal");
          // The message reports the constraint's actual rendered definition, which is what a
          // DBA needs in order to see HOW it drifted — not just which literals it mentions.
          assert.match(result.output, /has drifted \(found: CHECK .*'retry'/);
          // Identifiers must survive intact: RAISE understands only bare `%`, so building this
          // message with RAISE's own directives emitted `publicI` and mangled every command.
          assert.doesNotMatch(result.output, /publicI|_logI/);
          assert.match(result.output, /A DBA must run, as the table's owner/);
        },
      );
      // Ownership is back with the pool's role by now, so the block can repair its own damage —
      // which also exercises the repair path the test above deliberately never reaches.
      await pool.query(actionCheckBlock());
      const { rows } = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'ncmec_safety_audit_log_action_check'`,
      );
      assert.match(rows[0]!.def, /config_write/, "the full vocabulary must be restored");
    });

    it("rejects an action CHECK that permits an EXTRA value beyond the vocabulary", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // `... OR action = 'legacy_action'` accepts all nine expected values and rejects every
      // probe the block tests, so a sampled check declares it correct while an undeclared
      // action stays writable. Reproduced exactly that before the fix. No enlargement of the
      // probe set closes this — a finite sample cannot establish a closed vocabulary — which
      // is why the block now also requires the canonical single-comparison structure, under
      // which the literals ARE the vocabulary.
      assert.ok(pool, "pool unavailable");
      await pool.query(`ALTER TABLE ncmec_safety_audit_log DROP CONSTRAINT ncmec_safety_audit_log_action_check`);
      await pool.query(
        `ALTER TABLE ncmec_safety_audit_log ADD CONSTRAINT ncmec_safety_audit_log_action_check
           CHECK ("action" IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write')
                  OR "action" = 'legacy_action')`,
      );
      try {
        const { output } = execSqlCapturingDiagnostics(null, null, actionCheckBlock());
        assert.doesNotMatch(
          output,
          /already present and correct/,
          "a constraint permitting an undeclared action must not be accepted",
        );
        const { rows } = await pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'ncmec_safety_audit_log_action_check'`,
        );
        assert.doesNotMatch(rows[0]!.def, /legacy_action/, "the extra value must have been removed");
        await assert.rejects(
          () => pool!.query(
            `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t@e.com', 'legacy_action')`,
          ),
          /violates check constraint/,
        );
      } finally {
        await pool.query(actionCheckBlock());
      }
    });

    it("keeps the target-side null recheck that fences the backfill against concurrent linkage", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The CTE rewrite moved the `quarantine_id IS NULL` filter to the source side, where it
      // is evaluated at snapshot time and fences nothing. PostgreSQL re-evaluates the TARGET
      // predicate after a concurrent writer commits, so it has to be there — otherwise a
      // replay running alongside the reconciler can clobber an authoritative linkage with the
      // legacy JSON value, contradicting the trigger's explicit-value-wins rule. Simulated
      // here by pre-setting a different linkage, which is the state the race produces.
      assert.ok(pool, "pool unavailable");
      const { rows: q } = await pool.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source) VALUES ('restricted/q/a', 'arachnid') RETURNING id`,
      );
      const { rows: q2 } = await pool.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source) VALUES ('restricted/q/b', 'arachnid') RETURNING id`,
      );
      const legacy = q[0]!.id;
      const authoritative = q2[0]!.id;
      const { rows: rep } = await pool.query<{ id: string }>(
        `INSERT INTO ncmec_reports (match_source, evidence_uri, submission_status, request_metadata, quarantine_id)
         VALUES ('arachnid', 'restricted/q/race', 'pending', $1::jsonb, $2) RETURNING id`,
        [JSON.stringify({ quarantineId: legacy }), authoritative],
      );
      try {
        await pool.query(backfillBlock());
        const { rows } = await pool.query<{ qid: string }>(
          `SELECT quarantine_id AS qid FROM ncmec_reports WHERE id = $1`,
          [rep[0]!.id],
        );
        assert.equal(
          String(rows[0]!.qid),
          String(authoritative),
          "an already-set linkage must survive the backfill",
        );
        // The assertion above passes with or without the fix, because the source-side filter
        // already excludes an already-linked row — a genuine race needs two sessions
        // interleaved around a row lock, which this harness cannot stage. So the property is
        // pinned structurally as well: PostgreSQL re-evaluates the TARGET predicate after a
        // concurrent writer commits, and that predicate is what was lost in the CTE rewrite.
        assert.match(
          MIGRATION_SQL,
          /FROM linkable l\s*\n\s*WHERE r\.id = l\.report_id[\s\S]{0,800}?AND r\.quarantine_id IS NULL/,
          "the UPDATE must recheck quarantine_id IS NULL on the target row",
        );
      } finally {
        await pool.query(`DELETE FROM ncmec_reports WHERE id = $1`, [rep[0]!.id]).catch(() => {});
        await pool.query(`DELETE FROM quarantined_memes WHERE id = ANY($1)`, [[legacy, authoritative]]).catch(() => {});
      }
    });

    it("reports the backfill's outcome counts rather than computing them silently", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The migration-review rule: a backfill that reports nothing cannot be told from one
      // that matched nothing. The CTE rewrite computed all four counts and then discarded
      // them, so an operator could not distinguish a clean no-op from a run that deliberately
      // left rows for the backlog audit.
      assert.ok(pool, "pool unavailable");
      const { output } = execSqlCapturingDiagnostics(null, null, backfillBlock());
      assert.match(output, /quarantine_id backfill: linked=\d+, missing=\d+/);
      assert.match(output, /malformed=\d+, dangling=\d+/);
    });

    it("schema-qualifies the referenced table in the owner-run foreign-key commands", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // Qualifying only the source table left `REFERENCES <reftable>(id)` to resolve through
      // whatever search_path the DBA has, so on a non-default schema the emitted command
      // either fails or binds the repaired key to a same-named table elsewhere — and the
      // replay never converges, which is the only reason the command is emitted.
      assert.ok(pool, "pool unavailable");
      // Scoped to the WARNING text a DBA copies out, not to every REFERENCES in the file: the
      // in-session repair a few lines above runs under the migration's own search_path and is
      // correctly unqualified. Both referential actions appear so each block is covered.
      const sql = MIGRATION_SQL;
      assert.match(sql, /REFERENCES %I\.%I\(%I\) ON DELETE set null ON UPDATE no action;/);
      assert.match(sql, /REFERENCES %I\.%I\(%I\) ON DELETE restrict ON UPDATE no action;/);
    });

    it("rejects an action CHECK disguised to render correctly while accepting everything", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // `= ANY (expected || ARRAY[action])` renders with the same outer shape as the real
      // constraint and mentions exactly the same literals, but the array it compares against
      // always contains the value being tested, so every action passes. Verified directly:
      // this predicate satisfied the previous anchored-shape-plus-literal-set check AND
      // accepted a made-up action. No rendering-based test can be sound against this class of
      // disguise, which is why verification now evaluates the predicate instead.
      assert.ok(pool, "pool unavailable");
      await pool.query(`ALTER TABLE ncmec_safety_audit_log DROP CONSTRAINT ncmec_safety_audit_log_action_check`);
      await pool.query(
        `ALTER TABLE ncmec_safety_audit_log ADD CONSTRAINT ncmec_safety_audit_log_action_check
           CHECK ("action" = ANY (ARRAY['retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write']::varchar[] || ARRAY["action"]::varchar[]))`,
      );
      try {
        const { output } = execSqlCapturingDiagnostics(null, null, actionCheckBlock());
        assert.doesNotMatch(
          output,
          /already present and correct/,
          "a constraint that accepts every action must never be accepted as correct",
        );
        // Repaired, since this role owns the table.
        const { rows } = await pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'ncmec_safety_audit_log_action_check'`,
        );
        assert.doesNotMatch(rows[0]!.def, /ARRAY\[\(action\)/, "the disguise must have been replaced");
        // And the repaired constraint must actually reject an unknown action.
        await assert.rejects(
          () => pool!.query(
            `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t@e.com', 'totally_made_up')`,
          ),
          /violates check constraint/,
        );
      } finally {
        await pool.query(actionCheckBlock());
      }
    });

    it("rejects an action CHECK with the right literals but different semantics", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // `CHECK (action IN (...) OR true)` mentions exactly the expected vocabulary and
      // references exactly the expected column while enforcing nothing at all. The previous
      // literal-set comparison accepted it as correct and returned without touching it —
      // announcing a boundary it had just declined to verify. `NOT IN` is the same trap
      // inverted. Comparing against a server-rendered reference catches both.
      assert.ok(pool, "pool unavailable");
      await pool.query(`ALTER TABLE ncmec_safety_audit_log DROP CONSTRAINT ncmec_safety_audit_log_action_check`);
      await pool.query(
        `ALTER TABLE ncmec_safety_audit_log ADD CONSTRAINT ncmec_safety_audit_log_action_check
           CHECK ("action" IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write') OR true)`,
      );
      try {
        const { output } = execSqlCapturingDiagnostics(null, null, actionCheckBlock());
        assert.doesNotMatch(
          output,
          /already present and correct/,
          "a constraint that enforces nothing must never be accepted as correct",
        );
        // Owned by this role, so the block repairs rather than raising.
        const { rows } = await pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'ncmec_safety_audit_log_action_check'`,
        );
        assert.doesNotMatch(rows[0]!.def, /OR true/, "the drifted predicate must have been replaced");
        assert.match(rows[0]!.def, /config_write/);
      } finally {
        await pool.query(actionCheckBlock());
      }
    });

    it("preserves the invoking role across the audit-guard block's probes too", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The round-11 fix covered the ownership-hardening helper but left four RESET ROLE calls
      // in the earlier audit-guard block. That block runs FIRST, so under a DBA replaying with
      // `SET ROLE <app>` it re-pointed the session before the ownership block ever ran — which
      // then reported on, and granted to, the DBA's own login role.
      assert.ok(pool, "pool unavailable");
      const mid = `ncmec_gmid_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_gapp_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE ROLE ${mid} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      await pool.query(`GRANT ${mid} TO ${app} WITH INHERIT TRUE, SET TRUE`);
      try {
        const result = execSqlCapturingDiagnostics(
          app,
          appPassword,
          `SET ROLE ${mid}; ${auditGuardBlock()} ; SELECT current_user AS role_after;`,
        );
        assert.ok(result.ok, `expected the guard block to run cleanly; got: ${result.output}`);
        assert.match(result.output, new RegExp(mid), "the block must not leak the invoking role");
      } finally {
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${mid}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        await pool.query(`DROP ROLE IF EXISTS ${mid}`);
        await pool.query(auditGuardBlock());
      }
    });

    it("names a real direct grant when the owner role is reached transitively", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The application is a member of `mid`, which is a member of `helper`, which holds ADMIN
      // OPTION on overhype_audit_owner. `pg_has_role(app, owner, 'usage')` is TRANSITIVE, so
      // the previous version returned ARRAY['overhype_audit_owner'] and emitted
      // `REVOKE overhype_audit_owner FROM <app>` — a grant that does not exist. The revocable
      // edge is `mid`, the only thing the application actually holds directly.
      assert.ok(pool, "pool unavailable");
      const helper = `ncmec_thelp_${randomUUID().slice(0, 8)}`;
      const mid = `ncmec_tmid_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_tapp_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${helper} NOLOGIN`);
      await pool.query(`CREATE ROLE ${mid} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        await pool.query(`GRANT overhype_audit_owner TO ${helper} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
        await pool.query(`GRANT ${helper} TO ${mid} WITH INHERIT TRUE, SET TRUE`);
        await pool.query(`GRANT ${mid} TO ${app} WITH INHERIT TRUE, SET TRUE`);

        const { output } = execSqlCapturingDiagnostics(app, appPassword, ownershipHardeningBlock());
        assert.match(
          output,
          new RegExp(`REVOKE ${mid} FROM ${app}`),
          `must name the application's own direct grant; got: ${output}`,
        );
        assert.doesNotMatch(
          output,
          new RegExp(`REVOKE overhype_audit_owner FROM ${app}`),
          "must not name a membership the application does not hold",
        );
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(auditGuardBlock());
        for (const r of [app, mid, helper]) {
          await pool.query(`DROP OWNED BY ${r}`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS ${r}`);
        }
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("reports maintenance-role reachability as a live bypass, not just owner reachability", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The append-only triggers admit any caller with an effective grant of
      // overhype_audit_maintenance, so reaching that role bypasses the ledger regardless of who
      // owns the table — and the maintenance block revokes only a DIRECT membership.
      // ncmecAuditBoundaryStatus() already reports this as applicationCanBypassTrigger; the
      // migration's own completion claims did not consider it at all, so the two implementations
      // of one question could disagree with the migration on the optimistic side.
      assert.ok(pool, "pool unavailable");
      const mid = `ncmec_mmid_${randomUUID().slice(0, 8)}`;
      const app = `ncmec_mapp_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE ROLE ${mid} NOLOGIN`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        // Reached indirectly, which is exactly what the direct-membership revoke misses.
        await pool.query(`GRANT overhype_audit_maintenance TO ${mid} WITH INHERIT TRUE, SET TRUE`);
        await pool.query(`GRANT ${mid} TO ${app} WITH INHERIT TRUE, SET TRUE`);

        const { output } = execSqlCapturingDiagnostics(app, appPassword, ownershipHardeningBlock());
        assert.match(
          output,
          /assume overhype_audit_maintenance/,
          `the maintenance bypass must be reported; got: ${output}`,
        );
        assert.match(output, new RegExp(`REVOKE ${mid} FROM ${app}`));
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(auditGuardBlock());
        for (const r of [app, mid]) {
          await pool.query(`DROP OWNED BY ${r}`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS ${r}`);
        }
      }
    });

    it("gives the owner-role creator SET access in the role-absent recovery sequence", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // Verified directly against this repository's PostgreSQL 16 target: a non-superuser
      // CREATEROLE role that creates another receives `admin_option = t, inherit_option = f,
      // set_option = f`. ALTER TABLE ... OWNER TO requires SET, so without a self-grant the
      // printed sequence failed on its own second command for every non-superuser DBA — the
      // audience it exists for. This test runs the block as such a role, with the owner role
      // genuinely absent, and then executes the printed commands to prove they work.
      assert.ok(pool, "pool unavailable");
      const dba = `ncmec_dba_${randomUUID().slice(0, 8)}`;
      const dbaPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      assert.equal(ownerRoleExisted, false, "this test requires overhype_audit_owner to be absent");
      await pool.query(`CREATE ROLE ${dba} LOGIN PASSWORD '${dbaPassword}' CREATEROLE`);
      try {
        // WITH GRANT OPTION because the printed sequence's first real command re-grants CREATE
        // to the new owner role; a real DBA holds that authority over the deployment's schema,
        // and without it here the test fails on the harness rather than on the property.
        await pool.query(`GRANT CREATE ON SCHEMA public TO ${dba} WITH GRANT OPTION`);
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${dba}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${dba}`);

        const { output } = execSqlCapturingDiagnostics(dba, dbaPassword, ownershipHardeningBlock());
        assert.match(output, /CREATE ROLE overhype_audit_owner NOLOGIN;/);
        assert.match(
          output,
          /GRANT overhype_audit_owner TO CURRENT_USER WITH SET TRUE;/,
          `the creator must self-grant SET before the transfer; got: ${output}`,
        );
        // Now actually run the sequence the block printed, as the DBA it was written for.
        // The WHOLE sequence, including the trailing REVOKEs — truncating before them is what
        // let a syntactically invalid `REVOKE ... FROM <the role that runs the CREATE ROLE
        // above>` ship: under fail-fast tooling that aborts after the transfers have already
        // succeeded, leaving the temporary membership this test is meant to prove is removed.
        const cmds = output.slice(output.indexOf("CREATE ROLE overhype_audit_owner"));
        // The ordering matters as much as the presence: the self-grant has to precede the
        // ALTER that needs it. Measured inside the command list, not the whole message, which
        // also contains prose mentioning ALTER TABLE.
        assert.ok(
          cmds.indexOf("WITH SET TRUE") < cmds.indexOf("ALTER TABLE"),
          "the SET grant must come before the ownership transfer",
        );
        assert.doesNotMatch(cmds, /<the role that runs/, "the sequence must be executable SQL, not prose");
        const applied = execSqlCapturingDiagnostics(dba, dbaPassword, cmds);
        assert.ok(applied.ok, `the printed recovery sequence must actually run; got: ${applied.output}`);
        const { rows } = await pool.query<{ owner: string }>(
          `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'ncmec_safety_audit_log'`,
        );
        assert.equal(rows[0]?.owner, "overhype_audit_owner", "the transfer must have succeeded");
        // And the temporary membership the sequence granted itself must be gone — the point of
        // the final REVOKE, and the thing the truncated run could never observe.
        const { rows: memberRows } = await pool.query<{ grantor: string }>(
          `SELECT grantor::regrole::text AS grantor FROM pg_auth_members
            WHERE roleid = 'overhype_audit_owner'::regrole AND member = $1::regrole`,
          [dba],
        );
        // The SELF-GRANTED row (the SET access the sequence gave itself) must be gone.
        // The automatic creator membership is NOT removable here — verified directly: its
        // grantor is the bootstrap superuser, and PostgreSQL permits only a role with that
        // grantor's privileges to revoke it, ADMIN OPTION notwithstanding. So the sequence
        // must SAY so rather than leave a DBA believing the boundary is closed.
        const selfGranted = memberRows.filter((r) => r.grantor === dba);
        assert.equal(selfGranted.length, 0, "the sequence's own SET grant must be revoked");
        assert.match(
          output,
          /only that superuser can revoke/,
          "the sequence must disclose the membership it cannot remove",
        );
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`).catch(() => {});
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${dba}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${dba}`);
        await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`).catch(() => {});
      }
    });

    it("repairs a foreign key that points at the right table with the wrong referential action", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // `confrelid` alone accepts a same-named FK on the right target table with the wrong
      // local column, referenced column, or ON DELETE/ON UPDATE action. For the audit log that
      // is not cosmetic: the old ON DELETE SET NULL is an UPDATE of an append-only ledger, so
      // a database still carrying it must be MIGRATED, not accepted.
      assert.ok(pool, "pool unavailable");
      await pool.query(`ALTER TABLE ncmec_safety_audit_log DROP CONSTRAINT ncmec_safety_audit_log_report_id_fk`);
      await pool.query(
        `ALTER TABLE ncmec_safety_audit_log ADD CONSTRAINT ncmec_safety_audit_log_report_id_fk
           FOREIGN KEY (report_id) REFERENCES ncmec_reports(id) ON DELETE SET NULL`,
      );
      const { output } = execSqlCapturingDiagnostics(null, null, executableMigration());
      assert.ok(output !== undefined);
      const { rows } = await pool.query<{ deltype: string }>(
        `SELECT confdeltype AS deltype FROM pg_constraint
          WHERE conname = 'ncmec_safety_audit_log_report_id_fk'`,
      );
      assert.equal(rows[0]?.deltype, "r", "the SET NULL action must have been reconciled to RESTRICT");
    });

    it("refuses to delete a report whose handling was logged, rather than rewriting the ledger", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // ON DELETE SET NULL would issue an UPDATE against the append-only ledger: either the
      // delete fails from a trigger nobody would connect to it, or — under the maintenance
      // role — it silently rewrites the history of a legal record. RESTRICT refuses the delete
      // outright, which is both compatible with append-only and correct on its own terms.
      assert.ok(pool, "pool unavailable");
      const { rows: rep } = await pool.query<{ id: string }>(
        `INSERT INTO ncmec_reports (match_source, evidence_uri, submission_status)
         VALUES ('arachnid', 'restricted/quarantine/fk-restrict-test', 'pending') RETURNING id`,
      );
      const reportId = rep[0]!.id;
      await pool.query(
        `INSERT INTO ncmec_safety_audit_log (report_id, actor_label, action)
         VALUES ($1, 'test@example.com', 'retry')`,
        [reportId],
      );
      try {
        await assert.rejects(
          () => pool!.query(`DELETE FROM ncmec_reports WHERE id = $1`, [reportId]),
          /violates foreign key constraint/,
          "deleting a report with audit history must be refused",
        );
        // And the ledger entry is untouched — not nulled, not removed.
        const { rows } = await pool.query<{ report_id: string }>(
          `SELECT report_id FROM ncmec_safety_audit_log WHERE report_id = $1`,
          [reportId],
        );
        assert.equal(rows.length, 1, "the audit entry must survive intact");
      } finally {
        await pool.query(`DELETE FROM ncmec_safety_audit_log WHERE report_id = $1`, [reportId]).catch(() => {});
        await pool.query(`DELETE FROM ncmec_reports WHERE id = $1`, [reportId]).catch(() => {});
      }
    });

    it("runs the backfill and action-check blocks as a role with no TEMP privilege", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The previous version of this test exercised only actionCheckBlock(), which proved that
      // slice while two earlier TEMP dependencies remained: the backfill built a TEMP table,
      // and the reachability helpers were `CREATE FUNCTION pg_temp...`. Both need TEMPORARY on
      // the database, so a locked-down role aborted long before reaching the action check and
      // the no-TEMP replay path this file advertises was unreachable in practice.
      //
      // All three blocks are exercised here rather than the whole file, because replaying the
      // whole file additionally requires OWNERSHIP of the tables it alters — a separate
      // requirement from TEMP, and not the one under test. These three are exactly the places
      // TEMP was ever needed.
      assert.ok(pool, "pool unavailable");
      const app = `ncmec_notemp_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const db = new URL(process.env["DATABASE_URL"]!).pathname.slice(1);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
        await pool.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${app}`);
        // TEMPORARY is granted to PUBLIC by default, so revoking it from the role alone would
        // prove nothing — it would still hold it through PUBLIC.
        await pool.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
        await pool.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM ${app}`);

        // The ownership-hardening block is deliberately NOT in this list: its reachability
        // helpers are still `CREATE FUNCTION pg_temp...`, which needs TEMPORARY. That is a
        // known remaining gap, recorded on the PR rather than papered over here — asserting
        // only what is actually true is the whole point of this test existing.
        for (const [name, sql] of [
          ["backfill", backfillBlock()],
          ["action check", actionCheckBlock()],
        ] as const) {
          const result = execSqlCapturingDiagnostics(app, appPassword, sql);
          assert.ok(result.ok, `${name} must run without TEMP privilege; got: ${result.output}`);
          assert.doesNotMatch(
            result.output,
            /permission denied to create temporary/,
            `${name} must not depend on TEMP`,
          );
        }
      } finally {
        await pool.query(`GRANT TEMPORARY ON DATABASE ${db} TO PUBLIC`).catch(() => {});
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
      }
    });

    it("verifies the action CHECK without TEMP privilege instead of aborting", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // Round 12 generated its reference constraint on a TEMP table, unguarded and before the
      // insufficient_privilege handler — so a locked-down role with TEMP revoked aborted on
      // `permission denied to create temporary tables` even when the constraint was already
      // correct, defeating the hardened-replay path the block exists for.
      assert.ok(pool, "pool unavailable");
      const app = `ncmec_notemp_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
        await pool.query(`GRANT SELECT ON ncmec_safety_audit_log TO ${app}`);
        // TEMP is granted to PUBLIC by default; revoking it there is what actually removes it.
        await pool.query(`REVOKE TEMPORARY ON DATABASE ${process.env["PGDATABASE"] ?? "overhype_test"} FROM PUBLIC`);
        const result = execSqlCapturingDiagnostics(app, appPassword, actionCheckBlock());
        assert.ok(result.ok, `must not abort without TEMP privilege; got: ${result.output}`);
        assert.match(result.output, /already present and correct/);
        // No degraded mode any more, and that is the point: verification is now done by
        // EVALUATING the constraint's predicate against the vocabulary and against values
        // outside it, which needs no DDL at all. The generated-reference approach that needed
        // TEMP was also defeatable by a predicate that rendered correctly while accepting
        // everything, so removing the dependency and closing that hole were the same change.
        assert.match(result.output, /canonical single-comparison structure/);
      } finally {
        await pool.query(`GRANT TEMPORARY ON DATABASE ${process.env["PGDATABASE"] ?? "overhype_test"} TO PUBLIC`).catch(() => {});
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
      }
    });

    it("reconciles a partially completed ownership transfer instead of reading table ownership as proof of everything", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // Simulates a DBA sequence interrupted after `ALTER TABLE ... OWNER TO` but before the
      // function transfer and the two GRANTs — the table alone was already owned by
      // overhype_audit_owner. A rerun that treats "table owner matches" as proof hardening
      // is complete would leave the function application-owned and the app role permanently
      // short of its SELECT/INSERT grants forever, with no further rerun ever fixing it.
      assert.ok(pool, "pool unavailable");
      const app = `ncmec_dba_app2_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) {
        await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      }
      // Unconditional — see the sibling test's comment above on why this must not be gated
      // on ownerRoleExisted (cluster-wide role vs. per-database grant).
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        // Table transferred already; function still owned by app; no grants issued yet —
        // the exact partial state the finding describes.
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO ${app}`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO ${app}`);
        await pool.query(`GRANT overhype_audit_owner TO ${app} WITH INHERIT FALSE, SET TRUE`);
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO overhype_audit_owner`);

        const result = execSqlAsLoginRole(app, appPassword, ownershipHardeningBlock());
        assert.ok(result.ok, `expected reconciliation to succeed; got: ${result.output}`);

        const { rows: fnRows } = await pool.query<{ owner: string }>(
          `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
            WHERE oid = to_regprocedure('ncmec_safety_audit_log_append_only()')`,
        );
        assert.equal(fnRows[0]?.owner, "overhype_audit_owner", "the function must be reconciled too, not just the table");

        const { rows: grantRows } = await pool.query<{ has_select: boolean; has_insert: boolean }>(
          `SELECT has_table_privilege($1, 'ncmec_safety_audit_log', 'SELECT') AS has_select,
                  has_table_privilege($1, 'ncmec_safety_audit_log', 'INSERT') AS has_insert`,
          [app],
        );
        assert.equal(grantRows[0]?.has_select, true, "the app role must end up with SELECT");
        assert.equal(grantRows[0]?.has_insert, true, "the app role must end up with INSERT");
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("fails a hardened rerun when the application was never granted its table/sequence privileges", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // The sharpest of the three end states this block can leave a database in: ownership
      // of both objects has already moved to overhype_audit_owner AND the application's
      // membership in it has already been revoked (hardening looks complete, and the
      // security boundary genuinely is) — but the SELECT/INSERT/USAGE grants were never
      // issued, so every audit-log write fails. Nothing else in this system detects a
      // missing grant (ncmecAuditBoundaryStatus() doesn't check grants either), so this
      // migration must refuse to be recorded as successful rather than let the deploy
      // proceed silently broken.
      const app = `ncmec_dba_app3_${randomUUID().slice(0, 8)}`;
      const appPassword = randomUUID();
      const ownerRoleExisted = (
        await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner'`)
      ).rowCount! > 0;
      if (!ownerRoleExisted) {
        await pool.query(`CREATE ROLE overhype_audit_owner NOLOGIN`);
      }
      await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      await pool.query(`CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}'`);
      try {
        await pool.query(`GRANT overhype_audit_owner TO ${app} WITH INHERIT FALSE, SET TRUE`);
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO overhype_audit_owner`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO overhype_audit_owner`);
        // Hardening complete, but no grants were ever issued — then membership is revoked,
        // matching the real DBA sequence's final (non-optional) step.
        await pool.query(`REVOKE overhype_audit_owner FROM ${app}`);

        const result = execSqlAsLoginRole(app, appPassword, ownershipHardeningBlock());
        assert.equal(result.ok, false, "expected the block to refuse a hardened-but-ungranted database");
        assert.match(result.output, /was never granted SELECT\/INSERT/);
      } finally {
        await pool.query(`ALTER TABLE ncmec_safety_audit_log OWNER TO CURRENT_USER`);
        await pool.query(`ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO CURRENT_USER`);
        await pool.query(auditGuardBlock());
        await pool.query(`DROP OWNED BY ${app}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${app}`);
        if (!ownerRoleExisted) {
          await pool.query(`DROP OWNED BY overhype_audit_owner`).catch(() => {});
          await pool.query(`DROP ROLE IF EXISTS overhype_audit_owner`);
        }
      }
    });

    it("does not count a replica-only trigger as an enforced boundary", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      // tgenabled 'R' means the trigger fires only under logical replication, so ordinary
      // application statements skip it entirely. Counting it as enabled would report an
      // enforced boundary over a ledger anyone holding UPDATE could still rewrite.
      await inRolledBackTx(async (client) => {
        await client.query(`ALTER TABLE ncmec_safety_audit_log ENABLE REPLICA TRIGGER ncmec_safety_audit_log_no_mutate`);
        const { rows } = await client.query<{ enforced: boolean }>(
          `SELECT (SELECT count(*) = 2
                     FROM pg_trigger t
                    WHERE t.tgrelid = 'ncmec_safety_audit_log'::regclass
                      AND t.tgname IN ('ncmec_safety_audit_log_no_mutate','ncmec_safety_audit_log_no_truncate')
                      AND t.tgenabled = 'A') AS enforced`,
        );
        assert.equal(rows[0]!.enforced, false, "a replica-only trigger must not read as enabled");

        // And it really is bypassed: the same UPDATE that raises with the trigger in its
        // normal ENABLE ALWAYS state now goes through.
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        const upd = await client.query(`UPDATE ncmec_safety_audit_log SET reason = 'silently rewritten'`);
        assert.ok(upd.rowCount && upd.rowCount > 0, "expected the replica-only trigger to be skipped");
      });
    });

    it("closes the session_replication_role bypass — ENABLE ALWAYS triggers fire in replica mode", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      // GRANT SET ON PARAMETER session_replication_role is a real, grantable PostgreSQL 15+
      // privilege, independent of table/function ownership — a role holding it can run
      // SET session_replication_role = replica in its own session, under which an
      // origin-only ('O') trigger simply does not fire. Verified directly against this
      // repository's PostgreSQL 16 target before this fix: the UPDATE below went through
      // uncaught with the default (pre-fix) trigger mode.
      //
      // Must run as a genuinely restricted role via SET ROLE, not this suite's own superuser
      // connection directly — caught the hard way while writing this test: on the superuser
      // connection the trigger DOES fire (tgenabled = 'A' either way), but the guard
      // function's OWN body then passes it through anyway, because
      // pg_has_role(<superuser>, 'overhype_audit_maintenance', 'usage') is unconditionally
      // true regardless of any actual grant — the exact superuser-pool blind spot this whole
      // file's makeAppRole() helper exists to avoid. SET ROLE here isolates what is actually
      // under test: whether the TRIGGER fires under session_replication_role = replica, not
      // whether the function's privilege check also happens to pass.
      await inRolledBackTx(async (client) => {
        const role = await makeAppRole(client);
        await client.query(`GRANT SET ON PARAMETER session_replication_role TO ${role}`);
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        await expectRaises(
          client,
          `SET ROLE ${role}; SET session_replication_role = replica; UPDATE ncmec_safety_audit_log SET reason = 'bypass attempt'`,
          /append-only/,
        );
      });
    });

    it("does not count an origin-only trigger as an enforced boundary", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      // Plain CREATE TRIGGER defaults to origin-only ('O'), not ALWAYS — the state a database
      // hardened by a pre-fix version of this migration would still be in. Committed, not
      // rolled back, for the same reason as the guard-function-tampering test:
      // ncmecAuditBoundaryStatus() queries through the shared pool, which an uncommitted
      // change on a dedicated client is invisible to.
      await pool.query(`DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_mutate ON ncmec_safety_audit_log`);
      await pool.query(`
        CREATE TRIGGER ncmec_safety_audit_log_no_mutate
          BEFORE UPDATE OR DELETE ON ncmec_safety_audit_log
          FOR EACH ROW EXECUTE FUNCTION ncmec_safety_audit_log_append_only()
      `);
      try {
        const status = await ncmecAuditBoundaryStatus!();
        assert.equal(
          status.triggersEnabled,
          false,
          "an origin-only trigger must not read as sufficient — session_replication_role=replica can skip it",
        );
        assert.equal(status.boundaryEnforced, false);
      } finally {
        // Restore the exact expected (ENABLE ALWAYS) trigger so every test that runs after
        // this one still has a working append-only gate.
        await pool.query(auditGuardBlock());
      }
    });

    it("does not count a trigger recreated with an extra event as an enforced boundary", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      // A recovered database that recreated no_mutate as BEFORE INSERT OR UPDATE OR DELETE
      // (an extra INSERT event on top of the intended UPDATE/DELETE) would satisfy a
      // subset check ("these bits are set") while gating every ORDINARY audit-log append
      // behind the maintenance role too — silently breaking normal appends while a
      // subset-only check keeps reporting the boundary correctly wired. Exact tgtype
      // equality is what catches this. Committed, not rolled back, for the same reason as
      // the guard-function-tampering test: ncmecAuditBoundaryStatus() queries through the
      // shared pool, which an uncommitted change on a dedicated client is invisible to.
      await pool.query(`DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_mutate ON ncmec_safety_audit_log`);
      await pool.query(`
        CREATE TRIGGER ncmec_safety_audit_log_no_mutate
          BEFORE INSERT OR UPDATE OR DELETE ON ncmec_safety_audit_log
          FOR EACH ROW EXECUTE FUNCTION ncmec_safety_audit_log_append_only()
      `);
      try {
        const status = await ncmecAuditBoundaryStatus!();
        assert.equal(status.triggersEnabled, false, "an extra INSERT event must not read as wired correctly");
        assert.equal(status.boundaryEnforced, false);
      } finally {
        // Restore the exact expected trigger so every test that runs after this one still
        // has a working append-only gate.
        await pool.query(auditGuardBlock());
      }
    });

    it("reports whether the privilege boundary is actually enforced", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      const status = await ncmecAuditBoundaryStatus();
      assert.equal(status.triggersEnabled, true, "both append-only triggers must be enabled");
      assert.equal(status.guardFunctionIntact, true, "the guard function's source must match exactly, untampered");
      assert.equal(typeof status.tableOwner, "string");
      assert.equal(typeof status.functionOwner, "string");
      // `boundaryEnforced` is deliberately not asserted true: completing it is a
      // DBA step outside the migration (transfer ownership to
      // overhype_audit_owner, grant the app role no membership), and a
      // migration cannot manufacture a privilege boundary above itself. What
      // this asserts is that the state is OBSERVABLE, so the activation gate
      // can refuse production while the ledger is still bypassable.
      assert.equal(
        status.boundaryEnforced,
        status.triggersEnabled &&
          status.guardFunctionIntact &&
          !status.applicationOwnsTable &&
          !status.applicationOwnsFunction &&
          !status.applicationCanBypassTrigger,
      );
    });

    // No behavioral test here for "applicationOwnsFunction gates enforcement when only the
    // table was transferred": ncmecAuditBoundaryStatus() always queries through this file's
    // shared `pool`, which is a superuser — and pg_has_role(superuser, <any role>, 'usage')
    // is unconditionally true regardless of any actual grant (verified directly against this
    // repository's PostgreSQL 16 target), so applicationOwnsFunction would read true here no
    // matter what the real ownership state is. That is the identical class of gap the round-4
    // ADMIN OPTION fix closed for canAssumeRole/canEffectivelyAssumeRole via an injectable
    // pool; the same fix is now applied one level up (see ncmecAuditBoundaryStatus's new
    // `targetPool` parameter in lib/db/src/index.ts) and exercised from a genuinely
    // restricted, non-superuser connection in lib/db/src/ncmecAuditBoundaryStatus.test.ts —
    // this file still cannot construct that connection itself (no direct `pg` dependency;
    // see the sibling helpers' comments on this constraint), so the real coverage lives there.

    it("reports the guard function as tampered when its source no longer matches", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      // Committed, not rolled back: ncmecAuditBoundaryStatus() queries through the shared
      // `pool`, which may hand back any connection — an uncommitted change made inside
      // inRolledBackTx's own dedicated client is invisible to it under READ COMMITTED, and
      // the test would silently observe the untampered function instead. Same permissive-
      // replacement shape as the migration-guard test above: same name and signature,
      // unconditional pass-through body. tgfoid still matches — only the source comparison
      // can catch this.
      await pool.query(`
        CREATE OR REPLACE FUNCTION ncmec_safety_audit_log_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
      `);
      try {
        const status = await ncmecAuditBoundaryStatus!();
        assert.equal(status.guardFunctionIntact, false);
        assert.equal(status.boundaryEnforced, false);
      } finally {
        // Restore the real guard function so every test that runs after this one still has
        // a working append-only gate.
        await pool.query(auditGuardBlock());
      }
    });

    it("reports the guard function as tampered when it is SECURITY DEFINER, even with byte-identical source", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus || !NCMEC_AUDIT_LOG_GUARD_FN_BODY) return t.skip("DATABASE_URL not set");
      // Round 9 finding: prosrc alone is not the whole function definition. Inside a
      // SECURITY DEFINER function, current_user resolves to the FUNCTION OWNER for the
      // duration of the call, not the actual caller — verified directly against this
      // repository's PostgreSQL 16 target. A tampered copy with byte-identical source,
      // marked SECURITY DEFINER and owned by a role that itself holds
      // overhype_audit_maintenance, would pass the guard's own pg_has_role(current_user,
      // 'overhype_audit_maintenance', 'usage') check for EVERY caller — the source text
      // genuinely never changed, so a prosrc-only comparison cannot see this.
      await pool.query(`
        CREATE OR REPLACE FUNCTION ncmec_safety_audit_log_append_only() RETURNS trigger AS $$${NCMEC_AUDIT_LOG_GUARD_FN_BODY}$$
        LANGUAGE plpgsql SECURITY DEFINER;
      `);
      try {
        const status = await ncmecAuditBoundaryStatus!();
        assert.equal(status.guardFunctionIntact, false);
        assert.equal(status.boundaryEnforced, false);
      } finally {
        // Restore the real guard function so every test that runs after this one still has
        // a working append-only gate.
        await pool.query(auditGuardBlock());
      }
    });

    it("keeps NCMEC_AUDIT_LOG_GUARD_FN_BODY (lib/db) byte-identical to 0097's fn_body", (t) => {
      if (!NCMEC_AUDIT_LOG_GUARD_FN_BODY) return t.skip("DATABASE_URL not set");
      // The two copies exist only because a SQL migration and a TypeScript module cannot
      // literally share source text. This is what makes an edit to one without the other a
      // test failure instead of a silently weaker guard-function-integrity check on one side.
      assert.equal(guardFnBodyLiteral(), NCMEC_AUDIT_LOG_GUARD_FN_BODY);
    });
  });

  describe("quarantine_id backfill", () => {
    /**
     * Produce rows the way pre-0097 code did: metadata-only, no `quarantine_id`.
     *
     * The linking trigger 0097 installs would otherwise fill the column at insert time, so
     * a fixture built with it enabled is a POST-migration row wearing legacy clothes — and
     * the backfill, whose whole job is the rows that already existed, would never see a
     * candidate. Disabling the trigger for the insert is the only way to construct the
     * state the backfill actually runs against. DDL is transactional, so this reverts with
     * the rest of the test.
     */
    async function asPreMigrationWriter<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
      await client.query(`ALTER TABLE ncmec_reports DISABLE TRIGGER ncmec_reports_link_quarantine_trg`);
      try {
        return await fn();
      } finally {
        await client.query(`ALTER TABLE ncmec_reports ENABLE TRIGGER ncmec_reports_link_quarantine_trg`);
      }
    }

    it("links from server-written metadata and classifies everything else", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        const { rows: [q] } = await client.query<{ id: string }>(
          `INSERT INTO quarantined_memes (evidence_object_path, source)
           VALUES ('restricted/quarantine/a.jpg','arachnid') RETURNING id`,
        );
        const qid = Number(q!.id);

        // Four legacy shapes, exactly as they occur in the existing table.
        const ids: Record<string, number> = {};
        await asPreMigrationWriter(client, async () => {
          for (const [label, metadata] of [
            ["linked", JSON.stringify({ quarantineId: qid })],
            ["missing", JSON.stringify({ source: "arachnid" })],
            ["malformed", JSON.stringify({ quarantineId: "not-a-number" })],
            ["dangling", JSON.stringify({ quarantineId: 2147483000 })],
            // Digit-only but past bigint. A shape-only `^[0-9]+$` regex lets this through
            // and `::bigint` then raises numeric_value_out_of_range, aborting all of 0097 —
            // the exact failure the classification exists to prevent, surviving in a
            // subclass.
            ["oversized", JSON.stringify({ quarantineId: "999999999999999999999999" })],
          ] as const) {
            const { rows: [r] } = await client.query<{ id: string }>(
              `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
               VALUES ('arachnid', 'restricted/quarantine/x.jpg', $1::jsonb) RETURNING id`,
              [metadata],
            );
            ids[label] = Number(r!.id);
          }
        });

        // Replaying the block is safe: it only ever touches rows whose
        // quarantine_id is still NULL.
        await client.query(backfillBlock());

        const { rows } = await client.query<{ id: string; quarantine_id: string | null }>(
          `SELECT id, quarantine_id FROM ncmec_reports WHERE id = ANY($1) ORDER BY id`,
          [Object.values(ids)],
        );
        const byId = new Map(rows.map((r) => [Number(r.id), r.quarantine_id]));

        assert.equal(Number(byId.get(ids["linked"]!)), qid, "server-written metadata must link");
        // A metadata-less legacy report is left NULL rather than guessed at —
        // it is the backlog audit's population, not the backfill's.
        assert.equal(byId.get(ids["missing"]!), null);
        // A bare `(request_metadata->>'quarantineId')::bigint` would have raised
        // on this row and aborted the whole migration.
        assert.equal(byId.get(ids["malformed"]!), null);
        // Numeric but pointing at no quarantine row: classified, not linked.
        assert.equal(byId.get(ids["dangling"]!), null);
        // And the one that would have aborted the entire migration on a cast.
        assert.equal(byId.get(ids["oversized"]!), null);
      });
    });

    it("aborts rather than auto-picking when two reports claim one quarantine row", async (t) => {
      if (!pool) return t.skip("DATABASE_URL not set");
      await inRolledBackTx(async (client) => {
        const { rows: [q] } = await client.query<{ id: string }>(
          `INSERT INTO quarantined_memes (evidence_object_path, source)
           VALUES ('restricted/quarantine/b.jpg','arachnid') RETURNING id`,
        );
        const metadata = JSON.stringify({ quarantineId: Number(q!.id) });
        // Only constructible as a PRE-migration pair: with the linking trigger enabled the
        // second insert is refused by UQ_ncmec_reports_quarantine, which is the trigger
        // doing its job. The conflict this branch handles is therefore strictly a legacy
        // one — two rows that already claimed the same quarantine before 0097 existed.
        await asPreMigrationWriter(client, async () => {
          for (let i = 0; i < 2; i++) {
            await client.query(
              `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
               VALUES ('arachnid', 'restricted/quarantine/b.jpg', $1::jsonb)`,
              [metadata],
            );
          }
        });
        // Choosing one would silently discard a real report's linkage, and the
        // choice is exactly the judgement a human has to make.
        await expectRaises(client, backfillBlock(), /claim a quarantine row another report already claims/);
      });
    });
  });

  /**
   * Undo everything 0097 creates, so the next statement runs against an 0094-shaped
   * database.
   *
   * Without this the "re-runnable" test proves nothing about the transition that actually
   * matters: the suite's lifecycle runs `push-force` then `migrate`, so the database is
   * already at 0097 before the first line of any test — every application is a no-op over
   * objects that were there when it started. A missing `ADD COLUMN`, or an ordering failure
   * masked by an object Drizzle's push created, would sail past both the column assertions
   * and a two-run rerun check.
   */
  async function rewindTo0094(client: PoolClient): Promise<void> {
    await client.query(`DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_mutate ON ncmec_safety_audit_log`);
    await client.query(`DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_truncate ON ncmec_safety_audit_log`);
    await client.query(`DROP TRIGGER IF EXISTS ncmec_reports_link_quarantine_trg ON ncmec_reports`);
    await client.query(`DROP FUNCTION IF EXISTS ncmec_safety_audit_log_append_only()`);
    await client.query(`DROP FUNCTION IF EXISTS ncmec_reports_link_quarantine()`);
    await client.query(`DROP TABLE IF EXISTS ncmec_safety_audit_log`);
    await client.query(`DROP INDEX IF EXISTS "UQ_ncmec_reports_quarantine"`);
    await client.query(`DROP INDEX IF EXISTS "IDX_ncmec_failed_unalerted"`);
    await client.query(`DROP INDEX IF EXISTS "IDX_ncmec_nonfinal"`);
    await client.query(`ALTER TABLE ncmec_reports DROP CONSTRAINT IF EXISTS ncmec_reports_quarantine_id_fk`);
    await client.query(`ALTER TABLE ncmec_reports DROP CONSTRAINT IF EXISTS ncmec_reports_content_origin_check`);
    await client.query(`ALTER TABLE quarantined_memes DROP CONSTRAINT IF EXISTS quarantined_memes_content_origin_check`);
    for (const column of NCMEC_REPORT_COLUMNS_0097) {
      await client.query(`ALTER TABLE ncmec_reports DROP COLUMN IF EXISTS "${column}"`);
    }
    for (const column of QUARANTINE_COLUMNS_0097) {
      await client.query(`ALTER TABLE quarantined_memes DROP COLUMN IF EXISTS "${column}"`);
    }
    // Back to 0043's narrower vocabulary, which is what 0097 has to widen.
    await client.query(`ALTER TABLE ncmec_reports DROP CONSTRAINT IF EXISTS ncmec_reports_submission_status_check`);
    await client.query(
      `ALTER TABLE ncmec_reports ADD CONSTRAINT ncmec_reports_submission_status_check
         CHECK (submission_status IN ('pending','submitted','failed'))`,
    );
    await client.query(`DELETE FROM admin_config WHERE key = ANY($1)`, [[...NCMEC_SEEDED_CONFIG_KEYS]]);
  }

  it("applies cleanly to an 0094-shaped database, and again on top of itself", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);

      // The transition that ships. Everything before this line is teardown.
      await client.query(executableMigration());

      const { rows: cols } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'ncmec_reports' AND column_name = ANY($1)`,
        [NCMEC_REPORT_COLUMNS_0097],
      );
      assert.equal(cols.length, NCMEC_REPORT_COLUMNS_0097.length, "a column was not added from the 0094 state");

      const { rows: idx } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ncmec_reports'
          AND indexname IN ('IDX_ncmec_nonfinal','IDX_ncmec_failed_unalerted','UQ_ncmec_reports_quarantine')`,
      );
      assert.equal(idx.length, 3);

      const { rows: seeds } = await client.query<{ key: string }>(
        `SELECT key FROM admin_config WHERE key = ANY($1)`,
        [[...NCMEC_SEEDED_CONFIG_KEYS]],
      );
      assert.equal(seeds.length, NCMEC_SEEDED_CONFIG_KEYS.length);

      // And a second application on top, which is what a partially-recovered deployment does.
      await client.query(executableMigration());
    });
  });

  it("refuses to accept a same-named quarantine index whose definition is wrong", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // A partially recovered or manually drifted database could have an index called
    // "UQ_ncmec_reports_quarantine" that is not this migration's constraint at all — not
    // unique, or missing the predicate. `CREATE UNIQUE INDEX IF NOT EXISTS` would accept the
    // name and record 0097 as applied while the correctness constraint stayed absent.
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      // First bring the database to a genuine 0097 state, so quarantine_id exists to index.
      await client.query(executableMigration());
      // Then swap the real (correct) index for a wrong one under the same name — not
      // unique, so two reports could still claim one quarantine hit — and rerun.
      await client.query(`DROP INDEX "UQ_ncmec_reports_quarantine"`);
      await client.query(
        `CREATE INDEX "UQ_ncmec_reports_quarantine" ON ncmec_reports (quarantine_id)`,
      );
      await expectRaises(
        client,
        executableMigration(),
        /already exists but is not the exact unique constraint/,
      );
    });
  });

  it("refuses to accept a same-named quarantine index left invalid by a failed build", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // A crashed or cancelled `CREATE UNIQUE INDEX CONCURRENTLY` can leave an index with the
    // right uniqueness flag, key column and predicate — everything the prior test checks —
    // while pg_index.indisvalid is false, meaning Postgres does not actually enforce it.
    // indisunique alone would accept this and leave the ledger's correctness constraint
    // silently absent.
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      await client.query(executableMigration());
      await client.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"UQ_ncmec_reports_quarantine"'::regclass`,
      );
      await expectRaises(
        client,
        executableMigration(),
        /already exists but is not the exact unique constraint/,
      );
    });
  });

  it("reconciles a quarantine_id FK left pointing at the wrong table by a pre-fix rerun", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // Simulates a database where an earlier, schema-hardcoded version of this migration
    // already created "ncmec_reports_quarantine_id_fk" — a name-only existence check would
    // see the constraint present and leave it alone, even though it points at the wrong
    // (search-path-resolved) table under an isolated schema. A decoy table stands in for
    // "the wrong table" here, since this environment has only one quarantined_memes to
    // resolve to; NOT VALID skips the referential-integrity scan, which is irrelevant to
    // what this test verifies (confrelid, not data).
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      await client.query(executableMigration());

      await client.query(`CREATE TABLE ncmec_fk_reconcile_decoy (id bigint PRIMARY KEY)`);
      await client.query(`ALTER TABLE ncmec_reports DROP CONSTRAINT ncmec_reports_quarantine_id_fk`);
      await client.query(
        `ALTER TABLE ncmec_reports ADD CONSTRAINT ncmec_reports_quarantine_id_fk
           FOREIGN KEY (quarantine_id) REFERENCES ncmec_fk_reconcile_decoy(id)
           ON DELETE SET NULL NOT VALID`,
      );
      const { rows: before } = await client.query<{ confrelid: string }>(
        `SELECT confrelid::regclass::text AS confrelid FROM pg_constraint
          WHERE conname = 'ncmec_reports_quarantine_id_fk'`,
      );
      assert.equal(before[0]?.confrelid, "ncmec_fk_reconcile_decoy", "test setup sanity check");

      await client.query(executableMigration());

      const { rows: after } = await client.query<{ confrelid: string }>(
        `SELECT confrelid::regclass::text AS confrelid FROM pg_constraint
          WHERE conname = 'ncmec_reports_quarantine_id_fk'`,
      );
      assert.equal(after[0]?.confrelid, "quarantined_memes", "the FK must be recreated against the correct table, not left alone");
    });
  });

  it("adds the content-origin CHECK to quarantined_memes even when a same-named constraint exists on an unrelated table", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // Constraint names are unique per TABLE in Postgres, not per schema — a same-named
    // constraint sitting in another schema (this repo's own isolated-test-schema tooling,
    // or a same-named object left in `public`) would satisfy a name-only existence check.
    // A decoy table simulates the identical hazard within a single schema: same conname,
    // different conrelid.
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      await client.query(`CREATE TABLE ncmec_check_reconcile_decoy (content_origin varchar(16))`);
      await client.query(
        `ALTER TABLE ncmec_check_reconcile_decoy ADD CONSTRAINT quarantined_memes_content_origin_check
           CHECK (content_origin IS NULL OR content_origin IN ('generated','user_upload','stock','template','identity'))`,
      );

      await client.query(executableMigration());

      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint
          WHERE conname = 'quarantined_memes_content_origin_check'
            AND conrelid = 'quarantined_memes'::regclass`,
      );
      assert.equal(rows[0]?.n, "1", "the real quarantined_memes table must get its own constraint despite the decoy");
    });
  });

  it("recreates the content-origin CHECK when a same-named constraint on the correct table has drifted", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // A same-named constraint on the RIGHT table but with a drifted (narrower) expression —
    // verifies the fix checks the definition, not just presence-by-name-and-table.
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      await client.query(executableMigration());
      await client.query(`ALTER TABLE ncmec_reports DROP CONSTRAINT ncmec_reports_content_origin_check`);
      await client.query(
        `ALTER TABLE ncmec_reports ADD CONSTRAINT ncmec_reports_content_origin_check
           CHECK (content_origin IS NULL OR content_origin = 'generated')`,
      );

      await client.query(executableMigration());

      // Would be rejected by the drifted (narrower) constraint, but is a legitimate value
      // under the real one — proves the real constraint was recreated, not left alone.
      await client.query(
        `INSERT INTO ncmec_reports (match_source, evidence_uri, content_origin) VALUES ('arachnid', 'x', 'user_upload')`,
      );
    });
  });

  it("links a report written by pre-0097 code during the rolling-deploy window", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // 0097 commits before the new code is serving everywhere, so an OLD instance keeps
    // writing the linkage into request_metadata only — after the one-shot backfill has
    // already selected its rows. Those reports would be invisible to the orphan sweep, which
    // would then create a second report for the same hit.
    await inRolledBackTx(async (client) => {
      const { rows: [q] } = await client.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source)
         VALUES ('restricted/quarantine/rolling.jpg','arachnid') RETURNING id`,
      );
      const qid = Number(q!.id);

      // Exactly what the pre-0097 code writes: no quarantine_id column in the INSERT.
      const { rows: [r] } = await client.query<{ quarantine_id: string | null }>(
        `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
         VALUES ('arachnid', 'restricted/quarantine/rolling.jpg', $1::jsonb)
         RETURNING quarantine_id`,
        [JSON.stringify({ quarantineId: qid, source: "arachnid" })],
      );
      assert.equal(Number(r!.quarantine_id), qid, "the trigger must link a legacy-shaped insert");
    });
  });

  it("leaves an unusable quarantineId alone rather than failing the caller's transaction", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    await inRolledBackTx(async (client) => {
      for (const metadata of [
        { quarantineId: "not-a-number" },
        // Digit-only but past bigint. An unguarded cast here would raise
        // numeric_value_out_of_range and abort the quarantine transaction — which fails
        // closed on the user-facing upload, so a link that cannot be made must be silent.
        { quarantineId: "999999999999999999999999" },
        { quarantineId: 2147483000 },
        { source: "arachnid" },
      ]) {
        const { rows: [row] } = await client.query<{ quarantine_id: string | null }>(
          `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
           VALUES ('arachnid', 'restricted/quarantine/x.jpg', $1::jsonb) RETURNING quarantine_id`,
          [JSON.stringify(metadata)],
        );
        assert.equal(row!.quarantine_id, null, `${JSON.stringify(metadata)} must not link`);
      }
    });
  });

  it("never overwrites a quarantine_id the caller supplied", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // The reconciler sets this column directly; the trigger must not second-guess a caller
    // that knows the linkage.
    await inRolledBackTx(async (client) => {
      const { rows: [a] } = await client.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source)
         VALUES ('restricted/quarantine/a.jpg','arachnid') RETURNING id`,
      );
      const { rows: [b] } = await client.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source)
         VALUES ('restricted/quarantine/b.jpg','arachnid') RETURNING id`,
      );
      const { rows: [row] } = await client.query<{ quarantine_id: string }>(
        `INSERT INTO ncmec_reports (match_source, evidence_uri, quarantine_id, request_metadata)
         VALUES ('arachnid', 'restricted/quarantine/a.jpg', $1, $2::jsonb) RETURNING quarantine_id`,
        [Number(a!.id), JSON.stringify({ quarantineId: Number(b!.id) })],
      );
      assert.equal(Number(row!.quarantine_id), Number(a!.id));
    });
  });
});
