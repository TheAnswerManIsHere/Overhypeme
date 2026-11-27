/**
 * Launch Phase 15, 5c (#1306; plan docs/plans/PLAN_PHASE15_5C_OWNER_LOGIN.md): the app goes
 * back to the database owner's login, and the retirement batch
 * (lib/db/runbooks/app-role-retire.sql) takes 5b's separate login away safely.
 *
 * Its own scratch database, owned by a NON-superuser CREATEROLE role (as Neon's
 * neondb_owner is), built by the real boot, then laid out as production is after 5b
 * (fixtures/phase15-5b-split.sql: the app's objects owned by a separate login, the owner's
 * INHERIT and admin membership, S1's default privileges), plus a table the owner creates
 * itself, standing in for Replit's publish. Every boot is the real database start-up
 * (scripts/boot-database.ts) in a child process, connecting as production now does:
 * DATABASE_URL, the owner — with APP_DATABASE_URL still set, which nothing reads any more.
 *
 * What it proves, in order:
 * 1. BEFORE retirement, the new code starts as the owner while the app's objects still
 *    belong to the separate login, and a migration indexing the owner-created table (the
 *    case that crash-looped on 2026-11-27) applies;
 * 2. the batch refuses, changing nothing, while a session is connected as the old login;
 * 3. the batch times out and rolls back, changing nothing, while a lock it needs is held;
 * 4. the batch retires the login: every row is kept, nothing is left owned by it, the
 *    ledger, its sequence and guard stay the owner's, both triggers stay enabled, and the
 *    ledger still refuses UPDATE and TRUNCATE from the owner;
 * 5. AFTER retirement, the code starts again, a migration altering a formerly app-owned
 *    table applies, and a dump restores and boots.
 *
 * The runbook's role name is production's (overhype_app); this file substitutes a per-run
 * name so parallel runs never collide. overhype_audit_maintenance is cluster-global and the
 * guard looks for it by that name, so it is created if absent and dropped again afterwards.
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

import { pgCommandConnection } from "../lib/pgCommandLine.js";
import { droppablePool } from "./helpers/droppablePool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const runbooks = path.resolve(apiRoot, "../../lib/db/runbooks");
const migrationsSource = path.resolve(apiRoot, "../../lib/db/migrations");

const id = crypto.randomBytes(3).toString("hex");
const ownerRole = `p15ro_${id}`;
const appRole = `p15ra_${id}`;
const ownerPassword = crypto.randomBytes(12).toString("hex");
const appPassword = crypto.randomBytes(12).toString("hex");
const dbName = `p15_retire_${id}`;
const restoredName = `p15_retired_restored_${id}`;

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
const superUrl = (db: string) =>
  urlFor(db, new URL(process.env.DATABASE_URL!).username, decodeURIComponent(new URL(process.env.DATABASE_URL!).password));

/** A SQL file with production's role name swapped for this run's. */
function sqlWithRole(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\boverhype_app\b/g, appRole)
    .replaceAll("CHOOSE-A-PASSWORD", appPassword)
    // The maintenance role is cluster-global: before() makes sure it exists.
    .replace(/^CREATE ROLE overhype_audit_maintenance NOLOGIN;$/m, "");
}
const retireBatch = () => sqlWithRole(path.join(runbooks, "app-role-retire.sql"));

/** A copy of the migrations folder with one extra migration appended. */
function migrationsWith(tag: string, sql: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p15r-migrations-"));
  tmpDirs.push(dir);
  fs.cpSync(migrationsSource, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag, breakpoints: true });
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  fs.writeFileSync(path.join(dir, `${tag}.sql`), sql);
  return dir;
}

/** The real database start-up, in a child process, as production now connects. */
function boot(opts: { db?: string; migrationsFolder?: string } = {}): { ok: boolean; output: string } {
  const db = opts.db ?? dbName;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: ownerUrl(db),
    // Still set in production until the first 5c publish deletes it; nothing reads it.
    APP_DATABASE_URL: appUrl(db),
    PGOPTIONS: "",
  };
  if (opts.migrationsFolder) env.DRIZZLE_MIGRATIONS_FOLDER = opts.migrationsFolder;
  const r = spawnSync("npx", ["tsx", "scripts/boot-database.ts"], { cwd: apiRoot, env, encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

interface Snapshot {
  roleExists: boolean;
  ownedByApp: number;
  facts: number;
  ledgerRows: number;
}
async function snapshot(): Promise<Snapshot> {
  const { rows } = await owner!.query(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "roleExists",
            (SELECT count(*)::int FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS "ownedByApp",
            (SELECT count(*)::int FROM public.facts) AS facts,
            (SELECT count(*)::int FROM public.ncmec_safety_audit_log) AS "ledgerRows"`,
    [appRole],
  );
  return rows[0] as Snapshot;
}

let control: pg.Pool;
let owner: pg.Pool | null = null;
let skipped: string | null = null;
let createdMaintenance = false;
const tmpDirs: string[] = [];

describe("retiring 5b's separate login (Launch Phase 15, 5c)", () => {
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
      await control.query(`CREATE ROLE overhype_audit_maintenance NOLOGIN`).catch(() => {});
      createdMaintenance = true;
    }
    // The one extension the migrations create needs a superuser here; Neon lets its owner.
    const su = droppablePool(superUrl(dbName));
    await su.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await su.query(`CREATE SCHEMA _system AUTHORIZATION "${ownerRole}"`);
    await su.end();

    const first = boot();
    assert.ok(first.ok, `the owner's first boot: ${first.output.slice(-2000)}`);

    owner = droppablePool(ownerUrl());
    // Production after 5b: the split, then S1's default privileges.
    await owner.query(sqlWithRole(path.join(here, "fixtures/phase15-5b-split.sql")));
    // Standing in for Replit's publish under 5b: the owner creates a table, then rows exist.
    await owner.query(`CREATE TABLE public.p15r_publish_table (id serial PRIMARY KEY, label text)`);
    await owner.query(`INSERT INTO public.p15r_publish_table (label) VALUES ('kept')`);
    await owner.query(`INSERT INTO public.ncmec_safety_audit_log (actor_label, action) VALUES ('p15r rehearsal', 'retry')`);
  });

  after(async () => {
    await owner?.end();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    await control.query(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`).catch(() => {});
    await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    for (const role of [appRole, ownerRole]) {
      await control.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
    // Cluster-wide, and shards run in parallel on one server: leave it as this file found it.
    if (createdMaintenance) await control.query(`DROP ROLE IF EXISTS overhype_audit_maintenance`).catch(() => {});
    await control.end();
  });

  it("1. before retirement, the code starts as the owner and indexes a table the owner created", async (t) => {
    if (skipped) return t.skip(skipped);
    const before = await snapshot();
    assert.ok(before.ownedByApp > 0, "the app's objects still belong to the separate login");
    const r = boot({
      migrationsFolder: migrationsWith(
        "9998_p15r_index_owner_table",
        `CREATE INDEX IF NOT EXISTS "p15r_publish_table_label" ON "p15r_publish_table" ("label");\n`,
      ),
    });
    assert.ok(r.ok, r.output.slice(-2000));
    const { rows } = await owner!.query(`SELECT to_regclass('public.p15r_publish_table_label')::text AS idx`);
    assert.equal(rows[0].idx, "p15r_publish_table_label");
  });

  it("2. the batch refuses while a session is connected as the old login, and changes nothing", async (t) => {
    if (skipped) return t.skip(skipped);
    const before = await snapshot();
    const app = new pg.Client({ connectionString: appUrl() });
    await app.connect();
    try {
      await assert.rejects(owner!.query(retireBatch()), /session\(s\) still connected as/);
    } finally {
      await app.end();
    }
    assert.deepEqual(await snapshot(), before);
  });

  it("3. the batch times out and rolls back while a lock it needs is held, and changes nothing", async (t) => {
    if (skipped) return t.skip(skipped);
    // The old login's sessions are gone (pg_stat_activity can lag a closed client briefly).
    for (let i = 0; i < 50; i++) {
      const { rows } = await control.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [appRole]);
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const before = await snapshot();
    const holder = new pg.Client({ connectionString: ownerUrl() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE public.facts IN ACCESS SHARE MODE"); // as a pg_dump would hold it
      await assert.rejects(owner!.query(retireBatch()), /lock timeout/);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    assert.deepEqual(await snapshot(), before);
  });

  it("4. the batch retires the login, keeps every row, and leaves the ledger's guard exactly as it was", async (t) => {
    if (skipped) return t.skip(skipped);
    const before = await snapshot();
    const results = (await owner!.query(retireBatch())) as unknown as pg.QueryResult[];
    const readBack = Object.fromEntries(results.at(-1)!.rows.map((r: { item: string; value: string }) => [r.item, r.value]));
    assert.equal(readBack.overhype_app_exists, "false");
    assert.equal(readBack["ledger owner"], ownerRole);
    assert.equal(readBack["guard function owner"], ownerRole);
    const triggers = Object.entries(readBack).filter(([k]) => k.startsWith("trigger "));
    assert.equal(triggers.length, 2, "both ledger triggers are present");
    assert.ok(triggers.every(([, v]) => v === "A"), "both are enabled always");

    const after = await snapshot();
    assert.equal(after.roleExists, false);
    assert.equal(after.ownedByApp, 0);
    assert.equal(after.facts, before.facts);
    assert.equal(after.ledgerRows, before.ledgerRows);
    const { rows } = await owner!.query(`SELECT count(*)::int AS n FROM public.p15r_publish_table`);
    assert.equal(rows[0].n, 1, "the owner-created table's rows are kept");
    const { rows: defaults } = await owner!.query(`SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclacl::text LIKE $1`, [`%${appRole}=%`]);
    assert.equal(defaults[0].n, 0, "no default privilege names the retired login");

    // The guard still holds against the owner, which is now the application's login.
    await assert.rejects(owner!.query(`UPDATE public.ncmec_safety_audit_log SET reason = 'edited'`), /is append-only/);
    await assert.rejects(owner!.query(`TRUNCATE public.ncmec_safety_audit_log`), /is append-only/);
  });

  it("5. after retirement, the code starts, alters a formerly app-owned table, and a dump restores and boots", async (t) => {
    if (skipped) return t.skip(skipped);
    const r = boot({
      migrationsFolder: migrationsWith(
        "9999_p15r_alter_app_table",
        `ALTER TABLE public.facts ADD COLUMN IF NOT EXISTS p15r_extra integer;\n`,
      ),
    });
    assert.ok(r.ok, r.output.slice(-2000));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p15r-dump-"));
    tmpDirs.push(dir);
    const dumpFile = path.join(dir, "owner.dump");
    // The media backup's flags (lib/mediaBackup/capture.ts), minus the snapshot.
    const dumpConn = pgCommandConnection(ownerUrl(), { ...process.env, PGOPTIONS: "" });
    execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "--exclude-schema=_system", "-f", dumpFile, dumpConn.url], { env: dumpConn.env, stdio: "pipe" });

    await control.query(`CREATE DATABASE "${restoredName}" OWNER "${ownerRole}" TEMPLATE template0`);
    const su = droppablePool(superUrl(restoredName));
    await su.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await su.end();
    const restoreConn = pgCommandConnection(ownerUrl(restoredName), { ...process.env, PGOPTIONS: "" });
    const restore = spawnSync("pg_restore", ["--no-owner", "--no-acl", "-d", restoreConn.url, dumpFile], { env: restoreConn.env, encoding: "utf8" });
    const errors = restore.stderr
      .split("\n")
      .filter((l) => /error:/i.test(l))
      .filter((l) => !/extension "vector" already exists|schema "public" already exists|must be owner of extension vector/.test(l));
    assert.deepEqual(errors, [], restore.stderr.slice(-2000));
    const restored = boot({ db: restoredName });
    assert.ok(restored.ok, `the restored database starts: ${restored.output.slice(-2000)}`);
  });
});
