/**
 * Migration 0095 — NCMEC CyberTipline submission, phase 1.
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
import { execFileSync } from "node:child_process";

import {
  CONTENT_ORIGINS,
  NCMEC_SUBMISSION_STATUSES,
  NCMEC_FINAL_STATUSES,
  NCMEC_NONFINAL_STATUSES,
} from "@workspace/db/schema";

import {
  NCMEC_RESERVED_CONFIG_KEYS,
  NCMEC_SEEDED_CONFIG_KEYS,
  isNcmecReservedConfigKey,
} from "../lib/moderation/ncmecConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DB = path.resolve(__dirname, "../../../../lib/db");
const MIGRATION_PATH = path.join(REPO_DB, "migrations/0095_ncmec_submission.sql");
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, "utf-8");

const BACKFILL_START = "-- >>> ncmec-0095 backfill block (start)";
const BACKFILL_END = "-- <<< ncmec-0095 backfill block (end)";

/** Every column 0095 adds. Also the teardown list for the 0094-state fixture. */
const NCMEC_REPORT_COLUMNS_0095 = [
  "finished_at", "finish_started_at", "attempt_count", "last_error", "last_error_code",
  "submission_environment", "uploaded_files", "retracted_at", "submission_lease_owner",
  "submission_lease_until", "manually_filed_at", "test_submitted_at",
  "test_submission_started_at", "test_report_id", "quarantine_id", "failed_at",
  "last_attempt_failed_at", "alert_notified_at", "content_origin", "reporter_snapshot",
  "backlog_audited_at", "backlog_audit_note", "identity_omission_approved_at",
  "manual_report_id",
];

const QUARANTINE_COLUMNS_0095 = [
  "content_origin", "report_intent", "reporter_snapshot", "request_metadata",
];

/** The migration text with drizzle's statement separators removed, ready to execute. */
function executableMigration(): string {
  return MIGRATION_SQL.split("--> statement-breakpoint").join("\n");
}

const GUARD_START = "-- >>> ncmec-0095 audit guard block (start)";
const GUARD_END = "-- <<< ncmec-0095 audit guard block (end)";

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = MIGRATION_SQL.indexOf(startMarker);
  const end = MIGRATION_SQL.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `sentinels ${startMarker} / ${endMarker} missing from 0095`);
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

const OWNERSHIP_START = "-- >>> ncmec-0095 ownership hardening block (start)";
const OWNERSHIP_END = "-- <<< ncmec-0095 ownership hardening block (end)";

/** Just the DBA-provisioned-ownership-transfer DO block. */
function ownershipHardeningBlock(): string {
  return sliceBetween(OWNERSHIP_START, OWNERSHIP_END);
}

describe("migration 0095 — static contract", () => {
  it("is registered in the journal and exempted from snapshot checking", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO_DB, "migrations/meta/_journal.json"), "utf-8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    const entry = journal.entries.find((e) => e.tag === "0095_ncmec_submission");
    assert.ok(entry, "journal does not include 0095_ncmec_submission");
    assert.equal(entry.idx, 95, "0095 must sit at journal idx 95");

    // 0094 is PR #288's worker_lane_heartbeats. If this ever fails, someone
    // renumbered a migration into a slot that is already taken.
    const at94 = journal.entries.find((e) => e.idx === 94);
    assert.equal(at94?.tag, "0094_worker_lane_heartbeats");

    const checkScript = fs.readFileSync(
      path.join(REPO_DB, "scripts/check-migration-snapshots.ts"),
      "utf-8",
    );
    assert.match(checkScript, /"0095_ncmec_submission"/);
  });

  it("submission_status CHECK is in lockstep with NCMEC_SUBMISSION_STATUSES", () => {
    const match = MIGRATION_SQL.match(
      /ADD CONSTRAINT "ncmec_reports_submission_status_check"\s*\n\s*CHECK \("submission_status" IN \(([^)]*)\)\)/,
    );
    assert.ok(match?.[1], "could not find the submission_status CHECK in 0095");
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
      "0095's seed list and NCMEC_SEEDED_CONFIG_KEYS have drifted",
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

  it("every index and CHECK 0095 creates is also declared in the Drizzle schema", () => {
    // `drizzle-kit push --force` reconciles the database to the Drizzle snapshot and
    // auto-approves data-loss statements, so an object that lives only in a numbered
    // migration can be dropped by a push — and the hash-based migrator will not recreate it,
    // because 0095 is already recorded as applied. For UQ_ncmec_reports_quarantine, which is
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
    ];
    for (const name of declared) {
      assert.match(MIGRATION_SQL, new RegExp(`"${name}"`), `${name} is not created by 0095`);
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
    assert.match(MIGRATION_SQL, /IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;/);
    assert.doesNotMatch(MIGRATION_SQL, /THEN RETURN NULL/);
    // A row trigger does not fire on TRUNCATE.
    assert.match(MIGRATION_SQL, /BEFORE TRUNCATE ON "ncmec_safety_audit_log"\s*\n\s*FOR EACH STATEMENT/);
  });
});

describe("migration 0095 — database behaviour (skipped when DATABASE_URL is unset)", () => {
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

  it("adds every ncmec_reports column the later phases write", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = NCMEC_REPORT_COLUMNS_0095;
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ncmec_reports' AND column_name = ANY($1)`,
      [expected],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...expected].sort());
  });

  it("adds the four quarantined_memes provenance columns", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = QUARANTINE_COLUMNS_0095;
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
    // 0094->0095 transition test already uses.
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
        // Required on PostgreSQL 15+, which no longer grants CREATE on the public schema to
        // every role by default — without this, ALTER TABLE ... OWNER TO fails with
        // "permission denied for schema public" (the NEW owner needs CREATE, not the
        // executing role). Matches the corrected DBA instructions this test is verifying.
        await pool.query(`GRANT CREATE ON SCHEMA public TO overhype_audit_owner`);
      }
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
                      AND t.tgenabled IN ('O','A')) AS enforced`,
        );
        assert.equal(rows[0]!.enforced, false, "a replica-only trigger must not read as enabled");

        // And it really is bypassed: the same UPDATE that raises with the trigger in origin
        // mode now goes through.
        await client.query(
          `INSERT INTO ncmec_safety_audit_log (actor_label, action) VALUES ('t','config_write')`,
        );
        const upd = await client.query(`UPDATE ncmec_safety_audit_log SET reason = 'silently rewritten'`);
        assert.ok(upd.rowCount && upd.rowCount > 0, "expected the replica-only trigger to be skipped");
      });
    });

    it("reports whether the privilege boundary is actually enforced", async (t) => {
      if (!pool || !ncmecAuditBoundaryStatus) return t.skip("DATABASE_URL not set");
      const status = await ncmecAuditBoundaryStatus();
      assert.equal(status.triggersEnabled, true, "both append-only triggers must be enabled");
      assert.equal(typeof status.tableOwner, "string");
      // `boundaryEnforced` is deliberately not asserted true: completing it is a
      // DBA step outside the migration (transfer ownership to
      // overhype_audit_owner, grant the app role no membership), and a
      // migration cannot manufacture a privilege boundary above itself. What
      // this asserts is that the state is OBSERVABLE, so the activation gate
      // can refuse production while the ledger is still bypassable.
      assert.equal(
        status.boundaryEnforced,
        status.triggersEnabled && !status.applicationOwnsTable && !status.applicationCanBypassTrigger,
      );
    });
  });

  describe("quarantine_id backfill", () => {
    /**
     * Produce rows the way pre-0095 code did: metadata-only, no `quarantine_id`.
     *
     * The linking trigger 0095 installs would otherwise fill the column at insert time, so
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
            // and `::bigint` then raises numeric_value_out_of_range, aborting all of 0095 —
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
        // one — two rows that already claimed the same quarantine before 0095 existed.
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
   * Undo everything 0095 creates, so the next statement runs against an 0094-shaped
   * database.
   *
   * Without this the "re-runnable" test proves nothing about the transition that actually
   * matters: the suite's lifecycle runs `push-force` then `migrate`, so the database is
   * already at 0095 before the first line of any test — every application is a no-op over
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
    for (const column of NCMEC_REPORT_COLUMNS_0095) {
      await client.query(`ALTER TABLE ncmec_reports DROP COLUMN IF EXISTS "${column}"`);
    }
    for (const column of QUARANTINE_COLUMNS_0095) {
      await client.query(`ALTER TABLE quarantined_memes DROP COLUMN IF EXISTS "${column}"`);
    }
    // Back to 0043's narrower vocabulary, which is what 0095 has to widen.
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
        [NCMEC_REPORT_COLUMNS_0095],
      );
      assert.equal(cols.length, NCMEC_REPORT_COLUMNS_0095.length, "a column was not added from the 0094 state");

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
    // name and record 0095 as applied while the correctness constraint stayed absent.
    await inRolledBackTx(async (client) => {
      await rewindTo0094(client);
      // First bring the database to a genuine 0095 state, so quarantine_id exists to index.
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

  it("links a report written by pre-0095 code during the rolling-deploy window", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    // 0095 commits before the new code is serving everywhere, so an OLD instance keeps
    // writing the linkage into request_metadata only — after the one-shot backfill has
    // already selected its rows. Those reports would be invisible to the orphan sweep, which
    // would then create a second report for the same hit.
    await inRolledBackTx(async (client) => {
      const { rows: [q] } = await client.query<{ id: string }>(
        `INSERT INTO quarantined_memes (evidence_object_path, source)
         VALUES ('restricted/quarantine/rolling.jpg','arachnid') RETURNING id`,
      );
      const qid = Number(q!.id);

      // Exactly what the pre-0095 code writes: no quarantine_id column in the INSERT.
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
