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

/** The migration text with drizzle's statement separators removed, ready to execute. */
function executableMigration(): string {
  return MIGRATION_SQL.split("--> statement-breakpoint").join("\n");
}

/** Just the classify-then-link DO block, for replaying against fixtures. */
function backfillBlock(): string {
  const start = MIGRATION_SQL.indexOf(BACKFILL_START);
  const end = MIGRATION_SQL.indexOf(BACKFILL_END);
  assert.ok(start >= 0 && end > start, "backfill sentinels missing from 0095");
  return MIGRATION_SQL.slice(start + BACKFILL_START.length, end);
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
    const indexAt = MIGRATION_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ncmec_reports_quarantine"');
    assert.ok(backfillAt >= 0 && indexAt >= 0);
    assert.ok(
      backfillAt < indexAt,
      "the backfill must run first, or a pre-existing duplicate is silently skipped instead of surfacing",
    );
  });

  it("the append-only triggers gate on role membership, never on a settable GUC", () => {
    assert.match(MIGRATION_SQL, /pg_has_role\(current_user, 'overhype_audit_maintenance', 'member'\)/);
    // A session variable is not a privilege boundary: SET LOCAL is available to
    // the very role whose raw writes the trigger exists to block.
    assert.doesNotMatch(MIGRATION_SQL, /current_setting\s*\(/i);
    // BEFORE row triggers cancel the operation on a NULL return, so the
    // maintenance path must return OLD/NEW or the escape hatch silently
    // swallows the correction it exists to permit.
    assert.match(MIGRATION_SQL, /IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\s*\n\s*RETURN NEW;/);
    // A row trigger does not fire on TRUNCATE.
    assert.match(MIGRATION_SQL, /BEFORE TRUNCATE ON "ncmec_safety_audit_log"\s*\n\s*FOR EACH STATEMENT/);
  });
});

describe("migration 0095 — database behaviour (skipped when DATABASE_URL is unset)", () => {
  type PoolClient = import("pg").PoolClient;

  let pool: import("pg").Pool | null = null;
  let ncmecAuditBoundaryStatus:
    | typeof import("@workspace/db")["ncmecAuditBoundaryStatus"]
    | null = null;

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    try {
      const mod = await import("@workspace/db");
      pool = mod.pool;
      ncmecAuditBoundaryStatus = mod.ncmecAuditBoundaryStatus;
    } catch {
      pool = null;
    }
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

  it("adds every ncmec_reports column the later phases write", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = [
      "finished_at", "finish_started_at", "attempt_count", "last_error", "last_error_code",
      "submission_environment", "uploaded_files", "retracted_at", "submission_lease_owner",
      "submission_lease_until", "manually_filed_at", "test_submitted_at",
      "test_submission_started_at", "test_report_id", "quarantine_id", "failed_at",
      "last_attempt_failed_at", "alert_notified_at", "content_origin", "reporter_snapshot",
      "backlog_audited_at", "backlog_audit_note", "identity_omission_approved_at",
      "manual_report_id",
    ];
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ncmec_reports' AND column_name = ANY($1)`,
      [expected],
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...expected].sort());
  });

  it("adds the four quarantined_memes provenance columns", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const expected = ["content_origin", "report_intent", "reporter_snapshot", "request_metadata"];
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
    const { rows } = await pool.query<{ key: string; value: string }>(
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
    // assumes ~98.6. A test that injected the config would pass against a
    // production that never had it — so this reads what the migration left.
    assert.equal(byKey.get("async_job_ncmec_submit_max_attempts"), "8");
    assert.equal(byKey.get("async_job_ncmec_submit_retry_delay_4_ms"), "86400000");
  });

  it("gives the retry keys bounds, so a typo cannot silently destroy the horizon", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    const { rows } = await pool.query<{ key: string; min_value: number | null; max_value: number | null }>(
      `SELECT key, min_value, max_value FROM admin_config
        WHERE key IN ('async_job_ncmec_submit_max_attempts','async_job_ncmec_submit_retry_delay_4_ms')`,
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.min_value !== null, `${row.key} has no min_value`);
      assert.ok(row.max_value !== null, `${row.key} has no max_value`);
    }
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
        for (const [label, metadata] of [
          ["linked", JSON.stringify({ quarantineId: qid })],
          ["missing", JSON.stringify({ source: "arachnid" })],
          ["malformed", JSON.stringify({ quarantineId: "not-a-number" })],
          ["dangling", JSON.stringify({ quarantineId: 2147483000 })],
        ] as const) {
          const { rows: [r] } = await client.query<{ id: string }>(
            `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
             VALUES ('arachnid', 'restricted/quarantine/x.jpg', $1::jsonb) RETURNING id`,
            [metadata],
          );
          ids[label] = Number(r!.id);
        }

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
        for (let i = 0; i < 2; i++) {
          await client.query(
            `INSERT INTO ncmec_reports (match_source, evidence_uri, request_metadata)
             VALUES ('arachnid', 'restricted/quarantine/b.jpg', $1::jsonb)`,
            [metadata],
          );
        }
        // Choosing one would silently discard a real report's linkage, and the
        // choice is exactly the judgement a human has to make.
        await expectRaises(client, backfillBlock(), /claim a quarantine row another report already claims/);
      });
    });
  });

  it("is re-runnable — a partially-recovered deployment applies it twice", async (t) => {
    if (!pool) return t.skip("DATABASE_URL not set");
    await inRolledBackTx(async (client) => {
      await client.query(executableMigration());
      await client.query(executableMigration());
    });
  });
});
