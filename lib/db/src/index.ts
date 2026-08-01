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

/**
 * Per-instance connection ceiling.
 *
 * This was **unset** until the async-queue hardening work, which meant pg's
 * default of 10 — against a worst-case concurrent handler demand of exactly 10
 * across the five worker lanes. Zero spare connections under full load, and
 * nothing in the code said so.
 *
 * 20 is derived, not picked. Measured against production on 2026-07-29:
 * `max_connections` 450, `superuser_reserved_connections` 7, 13 backends in use
 * on a live app, and a **direct** connection (no `-pooler` in the host, so this
 * ceiling is the real one rather than being multiplexed away). That gives
 *
 *   budget = 450 − 7 (superuser) − 5 (migrations/console/admin burst)
 *                − 40 (generous allowance for non-worker peak; observed 13)
 *          = 398
 *   max    = min(20, floor(398 / max_instances))
 *
 * 20 doubles the lanes' worst case and is safe for any autoscale ceiling up to
 * 19 instances. `DB_POOL_MAX` exists for the one case that changes the answer —
 * an autoscale maximum of 20 or more — where the derived `floor(398 / N)` should
 * be set explicitly instead. It is an env var rather than `admin_config` because
 * the pool is constructed before any query can run.
 */
const POOL_MAX_DEFAULT = 20;
const poolMax = Number.parseInt(process.env.DB_POOL_MAX ?? "", 10);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : POOL_MAX_DEFAULT,
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

/** What the database currently enforces on `ncmec_safety_audit_log`. */
export interface NcmecAuditBoundaryStatus {
  /** The role the application connects as. */
  applicationRole: string;
  /** The role that owns the ledger table. */
  tableOwner: string;
  /** True when the maintenance role exists at all — the triggers fail closed without it. */
  maintenanceRoleExists: boolean;
  /**
   * True when the application role effectively holds the maintenance role's
   * privileges right now — either by `SET ROLE` or because the grant
   * `INHERIT`s it outright. Either shape lets an ordinary statement clear the
   * trigger's own `usage` check.
   */
  applicationCanBypassTrigger: boolean;
  /**
   * True when the application role effectively holds the table owner's
   * privileges (by `SET ROLE` or `INHERIT`), and could therefore run
   * `ALTER TABLE … DISABLE TRIGGER` regardless of what the triggers say.
   * Named `applicationOwnsTable` for the property it guards
   * (ownership-equivalent access), not literal `pg_class.relowner` equality.
   */
  applicationOwnsTable: boolean;
  /** Both append-only triggers present and enabled. */
  triggersEnabled: boolean;
}

/**
 * Report whether the append-only guarantee on `ncmec_safety_audit_log` is a
 * real privilege boundary or only a convention with teeth.
 *
 * Migration 0095 creates the table, the role-gated triggers, and the
 * maintenance role — but a migration cannot manufacture a privilege boundary
 * above itself. It runs as the application role, so the application role owns
 * what it creates and `ALTER TABLE … DISABLE TRIGGER` needs nothing more than
 * ownership. Completing the boundary is a DBA step outside the migration
 * (transfer ownership to `overhype_audit_owner`, grant the application role no
 * membership in it), and 0095 prints exactly that command when it finds the
 * step undone.
 *
 * This function is how the rest of the system finds out which of those two
 * states it is in, so the activation gate can refuse production while the
 * ledger is bypassable — blocking the dangerous STATE rather than one path
 * into it. `boundaryEnforced` is the single predicate callers want:
 * `!applicationOwnsTable && !applicationCanBypassTrigger && triggersEnabled`.
 */
/**
 * Can this connection actually become `role` via `SET ROLE`?
 *
 * `pg_has_role(current_user, role, 'usage')` is NOT the right question here,
 * and using it was a real defect this function replaces: `usage` reports
 * whether `role`'s privileges are available *without* `SET ROLE` (i.e. the
 * membership grants `INHERIT`). A membership granted `INHERIT FALSE, SET
 * TRUE` — a normal, supportable grant shape — reports `usage = false` while
 * `SET ROLE role` still succeeds and hands the session that role's full
 * privileges, including the ability to `ALTER TABLE … DISABLE TRIGGER` or
 * bypass the append-only gate. Verified directly against this repository's
 * PostgreSQL 16 target: a role granted with exactly that shape shows
 * `pg_has_role(..., 'usage') = false` and `SET ROLE` succeeding regardless.
 *
 * There is no single `pg_has_role` privilege type that answers "can this
 * session `SET ROLE` to X" — `MEMBER` ignores both `INHERIT` and `SET`,
 * `USAGE` tests only `INHERIT`. So this asks Postgres directly: attempt the
 * `SET ROLE` inside a transaction that is always rolled back, and observe
 * whether it raised. A dedicated client is used (not `pool.query`, whose
 * BEGIN/ROLLBACK could interleave across pooled connections) so the
 * transaction is guaranteed to run start-to-finish on one connection.
 *
 * This is one HALF of "can bypass" — see `canEffectivelyAssumeRole` below for
 * the other half this function alone was wrongly standing in for.
 */
async function canAssumeRole(role: string): Promise<boolean> {
  // SET ROLE takes an identifier, not a bind parameter — quoted per Postgres'
  // own rule (wrap in double quotes, double any embedded double quote), not
  // JSON escaping, which follows different rules. `role` is always sourced
  // from catalog data or a hardcoded constant here, never external input.
  const quotedRole = `"${role.replace(/"/g, '""')}"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${quotedRole}`);
      return true;
    } catch {
      return false;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

/**
 * Does this session effectively already have `role`'s privileges, one way or
 * the other?
 *
 * `canAssumeRole` alone under-reports: a membership granted `INHERIT TRUE,
 * SET FALSE` makes `role`'s privileges available to every ordinary statement
 * RIGHT NOW, with no `SET ROLE` involved at all — and `SET ROLE` to that role
 * is refused, so `canAssumeRole` alone would (wrongly) report `false` for a
 * role the session already exercises passively. The two grant shapes are not
 * exclusive — INHERIT and SET are independent flags — so the honest predicate
 * is the union: inherited right now (`pg_has_role(..., 'usage')`, which
 * *does* correctly answer this half) OR reachable via `SET ROLE`
 * (`canAssumeRole`, which answers the other half `usage` gets wrong). Neither
 * check alone is both correct and complete.
 */
async function canEffectivelyAssumeRole(role: string): Promise<boolean> {
  const { rows } = await pool.query<{ has_usage: boolean }>(
    "SELECT pg_has_role(current_user, $1, 'usage') AS has_usage",
    [role],
  );
  if (rows[0]?.has_usage) return true;
  return canAssumeRole(role);
}

export async function ncmecAuditBoundaryStatus(): Promise<
  NcmecAuditBoundaryStatus & { boundaryEnforced: boolean }
> {
  const { rows } = await pool.query<{
    application_role: string;
    table_owner: string;
    maintenance_role_exists: boolean;
    triggers_enabled: boolean;
  }>(`
    SELECT current_user::text AS application_role,
           pg_get_userbyid(c.relowner) AS table_owner,
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_maintenance')
             AS maintenance_role_exists,
           -- tgenabled: 'O' origin, 'A' always, 'D' disabled, 'R' REPLICA-only.
           -- A replica-only trigger does not fire for ordinary application
           -- statements, so counting it as enabled would report an enforced
           -- boundary over a ledger anyone with UPDATE could still rewrite.
           -- The function and event bits are checked too, so a same-named trigger
           -- wired to something else cannot stand in for the real one.
           (SELECT count(*) = 2
              FROM pg_trigger t
             WHERE t.tgrelid = c.oid
               AND t.tgname IN ('ncmec_safety_audit_log_no_mutate',
                                'ncmec_safety_audit_log_no_truncate')
               AND t.tgenabled IN ('O', 'A')
               AND t.tgfoid = 'public.ncmec_safety_audit_log_append_only()'::regprocedure
               -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE,
               -- 16 = UPDATE, 32 = TRUNCATE. Together the pair must cover UPDATE,
               -- DELETE and TRUNCATE, all BEFORE.
               AND (t.tgtype & 2) = 2
               AND CASE t.tgname
                     WHEN 'ncmec_safety_audit_log_no_mutate'
                       THEN (t.tgtype & 1) = 1 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16
                     ELSE (t.tgtype & 32) = 32
                   END)
             AS triggers_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'ncmec_safety_audit_log' AND n.nspname = 'public'
  `);

  const row = rows[0];
  if (!row) {
    throw new Error(
      "ncmec_safety_audit_log does not exist — migration 0095 has not been applied to this database.",
    );
  }

  const status: NcmecAuditBoundaryStatus = {
    applicationRole: row.application_role,
    tableOwner: row.table_owner,
    maintenanceRoleExists: row.maintenance_role_exists,
    applicationCanBypassTrigger: row.maintenance_role_exists
      ? await canEffectivelyAssumeRole("overhype_audit_maintenance")
      : false,
    applicationOwnsTable: await canEffectivelyAssumeRole(row.table_owner),
    triggersEnabled: row.triggers_enabled,
  };

  return {
    ...status,
    boundaryEnforced:
      status.triggersEnabled &&
      !status.applicationOwnsTable &&
      !status.applicationCanBypassTrigger,
  };
}

export * from "./schema";
