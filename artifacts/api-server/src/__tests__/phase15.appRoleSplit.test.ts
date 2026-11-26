/**
 * Launch Phase 15, increment 5b (#1306; plan docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md):
 * the application runs as its own login on a database split the way production is, and the
 * operator's two runbooks do what they say.
 *
 * Its own scratch database, owned by a NON-superuser CREATEROLE role (as Neon's
 * neondb_owner is), built by the real boot as that owner, then split with the 5a script
 * (lib/db/runbooks/app-role-split.sql). Every boot after that is the real database start-up
 * sequence (scripts/boot-database.ts, the order index.ts runs it) in a child process, with
 * DATABASE_URL the owner's and APP_DATABASE_URL the app's — production's shape.
 *
 * What it proves, in order:
 * 1. the app's boot runs as the app's login: migrations, ensureSchema(), and
 *    [audit-boundary] reporting boundaryEnforced true and ownershipDrift 0;
 * 2. after S1 (app-role-default-privileges.sql), a table the OWNER creates — standing in for
 *    Replit's publish — is readable and writable by the app, and drift reads it;
 * 3. a pending migration that alters that table makes the app's start fail, and the failure
 *    diagnostic names the table;
 * 4. the ownership repair (app-role-ownership-repair.sql) moves it, and an owner-created
 *    function and enum, to the app, leaves the ledger set with the owner and the owner's
 *    membership as it was; the retried start applies the migration and reports drift 0;
 * 5. a pg_dump taken as the app (with Replit's _system schema present and unreadable)
 *    restores into a fresh database that holds the app's tables, the migration ledger and
 *    the safety ledger, and the boot starts against it;
 * 6. in a published-deployment environment, the owner's credential has left process.env,
 *    and Stripe start-up's real sync migrations and the real Stripe driver's pool both run
 *    as the app's login (helpers/stripeStartAsApp.ts; only Stripe's network is absent).
 *
 * The role names in the runbooks are production's (overhype_app); this file substitutes a
 * per-run name so parallel runs never collide. overhype_audit_maintenance is
 * cluster-global and the guard looks for it by that name, so it is created if absent and
 * dropped again afterwards.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { droppablePool } from "./helpers/droppablePool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const runbooks = path.resolve(apiRoot, "../../lib/db/runbooks");
const migrationsSource = path.resolve(apiRoot, "../../lib/db/migrations");

const id = crypto.randomBytes(3).toString("hex");
const ownerRole = `p15o_${id}`;
const appRole = `p15a_${id}`;
const ownerPassword = crypto.randomBytes(12).toString("hex");
const appPassword = crypto.randomBytes(12).toString("hex");
const dbName = `p15_split_${id}`;
const restoredName = `p15_restored_${id}`;

function urlFor(database: string, user: string, password: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.username = user;
  url.password = password;
  url.searchParams.delete("options");
  return url.href;
}
const ownerUrl = (db = dbName) => urlFor(db, ownerRole, ownerPassword);
const appUrl = (db = dbName) => urlFor(db, appRole, appPassword);

/** A runbook's text with production's role name swapped for this run's. */
function runbook(name: string): string {
  return fs
    .readFileSync(path.join(runbooks, name), "utf8")
    .replace(/\boverhype_app\b/g, appRole)
    .replaceAll("CHOOSE-A-PASSWORD", appPassword)
    // The maintenance role is cluster-global: before() makes sure it exists.
    .replace(/^CREATE ROLE overhype_audit_maintenance NOLOGIN;$/m, "");
}

interface BootResult {
  ok: boolean;
  output: string;
  report: { user: string; boundaryEnforced: boolean | null; ownershipDrift: number | null } | null;
}

/** The real database start-up sequence, in a child process, as production connects. */
function boot(opts: { db?: string; migrationsFolder?: string; asApp?: boolean } = {}): BootResult {
  const db = opts.db ?? dbName;
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: ownerUrl(db), PGOPTIONS: "" };
  delete env.APP_DATABASE_URL;
  if (opts.asApp !== false) env.APP_DATABASE_URL = appUrl(db);
  if (opts.migrationsFolder) env.DRIZZLE_MIGRATIONS_FOLDER = opts.migrationsFolder;
  const r = spawnSync("npx", ["tsx", "scripts/boot-database.ts"], { cwd: apiRoot, env, encoding: "utf8" });
  const output = `${r.stdout}\n${r.stderr}`;
  const line = /\[boot-database\] audit-boundary (\{.*\})/.exec(output);
  return { ok: r.status === 0, output, report: line ? JSON.parse(line[1]!) : null };
}

let control: pg.Pool;
let owner: pg.Pool | null = null;
let app: pg.Pool | null = null;
let skipped: string | null = null;
let tmp: string | null = null;
let createdMaintenance = false;

describe("the app as its own login on a split database (Launch Phase 15, 5b)", () => {
  before(async () => {
    control = droppablePool(process.env.DATABASE_URL!);
    try {
      await control.query(`CREATE ROLE "${ownerRole}" LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
      await control.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}" TEMPLATE template0`);
    } catch (err) {
      skipped = `CREATE ROLE / CREATE DATABASE is not permitted here (${(err as Error).message})`;
      return;
    }
    const { rows: maint } = await control.query(`SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_maintenance'`);
    if (maint.length === 0) {
      await control.query(`CREATE ROLE overhype_audit_maintenance NOLOGIN`);
      createdMaintenance = true;
    }
    // The one extension the migrations create needs a superuser here; Neon lets its owner.
    const su = droppablePool(urlFor(dbName, new URL(process.env.DATABASE_URL!).username, decodeURIComponent(new URL(process.env.DATABASE_URL!).password)));
    await su.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    // Replit's own schema, owned by the database owner, which the app cannot read.
    await su.query(`CREATE SCHEMA _system AUTHORIZATION "${ownerRole}"`);
    await su.end();

    const first = boot({ asApp: false }); // built by the owner, as production was before 5a
    assert.ok(first.ok, `the owner's first boot: ${first.output.slice(-2000)}`);

    owner = droppablePool(ownerUrl());
    await owner.query(`CREATE TABLE _system.replit_database_migrations_v1 (id bigserial PRIMARY KEY, build_id text)`);
    await owner.query(runbook("app-role-split.sql"));
    app = droppablePool(appUrl());
  });

  after(async () => {
    await app?.end();
    await owner?.end();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await control.query(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`).catch(() => {});
    await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    for (const role of [appRole, ownerRole]) {
      await control.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
    // Other files in the shard (migrations.0097.test.ts) look for this cluster-global role
    // by name; leave the cluster as this file found it.
    if (createdMaintenance) await control.query(`DROP ROLE IF EXISTS overhype_audit_maintenance`).catch(() => {});
    await control.end();
  });

  it("1. boots as the app's login, with the boundary enforced and nothing to repair", (t) => {
    if (skipped) return t.skip(skipped);
    const r = boot();
    assert.ok(r.ok, r.output.slice(-2000));
    assert.deepEqual(r.report, { user: appRole, boundaryEnforced: true, ownershipDrift: 0 });
  });

  it("2. after S1, a table the owner creates is the app's to read and write, and drift names it", async (t) => {
    if (skipped) return t.skip(skipped);
    const s1 = await owner!.query(runbook("app-role-default-privileges.sql"));
    const readBack = (Array.isArray(s1) ? s1.at(-1)! : s1).rows as Array<{ schema: string; objtype: string }>;
    const { rows: schemas } = await owner!.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('public', 'drizzle', 'stripe')`);
    assert.equal(readBack.length, 2 * schemas[0].n, "two default-privilege rows in each application schema that exists");

    // Standing in for Replit's publish: the owner creates a table, a function and an enum.
    await owner!.query(`CREATE TABLE public.p15_publish_table (id serial PRIMARY KEY, label text)`);
    await owner!.query(`CREATE FUNCTION public.p15_publish_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    await owner!.query(`CREATE TYPE public.p15_publish_enum AS ENUM ('a', 'b')`);

    await app!.query(`INSERT INTO public.p15_publish_table (label) VALUES ('written by the app')`);
    const { rows } = await app!.query(`SELECT count(*)::int AS n FROM public.p15_publish_table`);
    assert.equal(rows[0].n, 1);

    const r = boot();
    assert.ok(r.ok, "drift alone never stops the start (Q15 → 1)");
    assert.equal(r.report?.boundaryEnforced, true);
    assert.equal(r.report?.ownershipDrift, 3, r.output.slice(-2000));
    assert.match(r.output, /public\.p15_publish_table/);
  });

  it("3. a pending migration altering the owner's table fails the start, and the diagnostic names it", (t) => {
    if (skipped) return t.skip(skipped);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p15-migrations-"));
    fs.cpSync(migrationsSource, tmp, { recursive: true });
    const journalPath = path.join(tmp, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const last = journal.entries.at(-1);
    journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: "9999_p15_alter_publish_table", breakpoints: true });
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    fs.writeFileSync(path.join(tmp, "9999_p15_alter_publish_table.sql"), "ALTER TABLE public.p15_publish_table ADD COLUMN IF NOT EXISTS extra integer;\n");

    const r = boot({ migrationsFolder: tmp });
    assert.equal(r.ok, false, "the start must fail on ownership");
    assert.match(r.output, /must be owner of table p15_publish_table/);
    assert.match(r.output, /a migration failed/);
    assert.match(r.output, /table p15_publish_table|public\.p15_publish_table/);
  });

  it("4. the ownership repair clears drift, keeps the ledger the owner's, and the retried start applies the migration", async (t) => {
    if (skipped) return t.skip(skipped);
    const membershipBefore = await control.query(
      `SELECT admin_option, set_option, inherit_option FROM pg_auth_members WHERE roleid = $1::regrole AND member = $2::regrole ORDER BY 1, 2, 3`,
      [appRole, ownerRole],
    );
    await owner!.query(runbook("app-role-ownership-repair.sql"));
    const membershipAfter = await control.query(
      `SELECT admin_option, set_option, inherit_option FROM pg_auth_members WHERE roleid = $1::regrole AND member = $2::regrole ORDER BY 1, 2, 3`,
      [appRole, ownerRole],
    );
    assert.deepEqual(membershipAfter.rows, membershipBefore.rows, "the owner's membership is exactly as it was");
    assert.ok(membershipAfter.rows.every((m) => m.set_option === false));
    assert.ok(membershipAfter.rows.some((m) => m.inherit_option === true), "the owner keeps INHERIT for Replit's publish");

    // pg_class and pg_proc are per database: read through the scratch database's own connection.
    const scoped = await owner!.query<{ name: string; owner: string }>(
      `SELECT relname AS name, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname IN ('p15_publish_table', 'p15_publish_table_id_seq', 'ncmec_safety_audit_log', 'ncmec_safety_audit_log_id_seq')
       UNION ALL SELECT proname, pg_get_userbyid(proowner) FROM pg_proc WHERE proname IN ('p15_publish_fn', 'ncmec_safety_audit_log_append_only')
       UNION ALL SELECT typname, pg_get_userbyid(typowner) FROM pg_type WHERE typname = 'p15_publish_enum'`,
    );
    const ownerOf = Object.fromEntries(scoped.rows.map((r) => [r.name, r.owner]));
    assert.equal(ownerOf.p15_publish_table, appRole);
    assert.equal(ownerOf.p15_publish_table_id_seq, appRole);
    assert.equal(ownerOf.p15_publish_fn, appRole);
    assert.equal(ownerOf.p15_publish_enum, appRole);
    assert.equal(ownerOf.ncmec_safety_audit_log, ownerRole);
    assert.equal(ownerOf.ncmec_safety_audit_log_id_seq, ownerRole);
    assert.equal(ownerOf.ncmec_safety_audit_log_append_only, ownerRole);

    const r = boot({ migrationsFolder: tmp! });
    assert.ok(r.ok, r.output.slice(-2000));
    assert.deepEqual(r.report, { user: appRole, boundaryEnforced: true, ownershipDrift: 0 });
    const { rows } = await app!.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'p15_publish_table' AND column_name = 'extra'`,
    );
    assert.equal(rows[0].n, 1, "the retried start applied the pending migration");
  });

  it("5. a dump taken as the app skips Replit's _system, restores, and the restored database boots", async (t) => {
    if (skipped) return t.skip(skipped);
    const dumpFile = path.join(tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), "p15-")), "app.dump");
    const env = { ...process.env, PGPASSWORD: appPassword, PGOPTIONS: "" };
    const dumpTarget = new URL(appUrl());
    dumpTarget.password = "";
    // The same flags the media backup uses (lib/mediaBackup/capture.ts), minus the snapshot.
    execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "--exclude-schema=_system", "-f", dumpFile, dumpTarget.href], { env, stdio: "pipe" });

    await control.query(`CREATE DATABASE "${restoredName}" OWNER "${ownerRole}" TEMPLATE template0`);
    const su = droppablePool(urlFor(restoredName, new URL(process.env.DATABASE_URL!).username, decodeURIComponent(new URL(process.env.DATABASE_URL!).password)));
    await su.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await su.end();
    const restoreTarget = new URL(ownerUrl(restoredName));
    restoreTarget.password = "";
    const restore = spawnSync("pg_restore", ["--no-owner", "--no-acl", "-d", restoreTarget.href, dumpFile], {
      env: { ...process.env, PGPASSWORD: ownerPassword, PGOPTIONS: "" },
      encoding: "utf8",
    });
    // The vector extension was created ahead by a superuser (as Neon's owner may), so
    // pg_restore cannot re-create or re-comment it; those two lines are expected, and any
    // other error is a failure.
    const errors = restore.stderr
      .split("\n")
      .filter((l) => /error:/i.test(l))
      .filter((l) => !/extension "vector" already exists|schema "public" already exists|must be owner of extension vector/.test(l));
    assert.deepEqual(errors, [], restore.stderr.slice(-2000));

    const restored = droppablePool(ownerUrl(restoredName));
    try {
      const { rows } = await restored.query<{ facts: string | null; ledger: string | null; migrations: number; system: string | null }>(
        `SELECT to_regclass('public.facts')::text AS facts,
                to_regclass('public.ncmec_safety_audit_log')::text AS ledger,
                (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
                to_regnamespace('_system')::text AS system`,
      );
      assert.equal(rows[0]!.facts, "facts");
      assert.equal(rows[0]!.ledger, "ncmec_safety_audit_log");
      assert.ok(rows[0]!.migrations > 0, "the migration ledger came back");
      assert.equal(rows[0]!.system, null, "Replit's publish log is not in the portable dump");
    } finally {
      await restored.end();
    }
    const r = boot({ db: restoredName, asApp: false });
    assert.ok(r.ok, `the restored database starts: ${r.output.slice(-2000)}`);
  });

  it("6. in a deployment, Stripe start-up and the Stripe driver's pool run as the app, after the owner's credential is gone", (t) => {
    if (skipped) return t.skip(skipped);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPLIT_DEPLOYMENT: "1",
      DATABASE_URL: ownerUrl(),
      APP_DATABASE_URL: appUrl(),
      PGPASSWORD: ownerPassword, // as Replit provides it; must be scrubbed too
      PGOPTIONS: "",
    };
    const r = spawnSync("npx", ["tsx", "src/__tests__/helpers/stripeStartAsApp.ts"], { cwd: apiRoot, env, encoding: "utf8" });
    const output = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, output.slice(-2000));
    const line = /\[stripe-probe\] (\{.*\})/.exec(output);
    assert.ok(line, output.slice(-2000));
    const probe = JSON.parse(line[1]!);
    assert.deepEqual(probe.leftInEnv, [], "DATABASE_URL and the PG* variables are gone from process.env");
    assert.equal(probe.resolvedUser, appRole);
    assert.equal(probe.migrationsUser, appRole, "Stripe's sync migrations ran through the app's login");
    assert.equal(probe.driverPoolUser, appRole, "the Stripe driver's own pool connects as the app");
    assert.equal(probe.stripeSchemaOwner, appRole, "the stripe schema the migrations made is the app's");
    assert.equal(probe.completed, false, "start-up stops on purpose before its first call to Stripe");
  });
});
