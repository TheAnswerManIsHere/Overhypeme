/**
 * Launch Phase 3, increment 8, plan amendment 2 (docs/plans/PLAN_PHASE3_AMENDMENT_2.md):
 * production's first database on Replit arrives with dev's structure and no
 * migration record. Adoption proves that structure equal to what the code
 * builds and installs the migrations' rows, ledger and sequence positions in
 * one transaction; every refusal changes nothing; a failure after the
 * sequences moved leaves them as they were; and it needs no superuser.
 *
 * The "Replit-shaped" production is a schema-only restore of a database the
 * runner built: tables, no rows, an empty ledger.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { databaseUrl } from "../lib/devRebuild.js";
import { adoptProduction, type AdoptReport } from "../lib/productionAdopt.js";
import { pgCommandConnection } from "../lib/pgCommandLine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const apiRoot = path.resolve(here, "../..");
const suffix = crypto.randomBytes(3).toString("hex");
const srcName = `p3_adopt_src_${suffix}`;
const baseName = `p3_adopt_base_${suffix}`;
const url = (db: string) => databaseUrl(process.env.DATABASE_URL!, db);

let control: pg.Pool;
let workDir: string;
let fullDump: string;
let creatable = true;
let cases = 0;

async function query<T extends pg.QueryResultRow>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

function restore(dump: string, target: string): void {
  const conn = pgCommandConnection(target);
  execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", conn.url, dump], { env: conn.env, stdio: "pipe" });
}

/** A fresh Replit-shaped production: tables, no rows, no ledger rows. */
async function newCase(): Promise<string> {
  const name = `p3_adopt_case_${suffix}_${++cases}`;
  await control.query(`CREATE DATABASE "${name}" TEMPLATE "${baseName}"`);
  return name;
}

const adopt = (prod: string, extra: Partial<Parameters<typeof adoptProduction>[0]> = {}) =>
  adoptProduction({ productionUrl: url(prod), devUrl: url(srcName), migrate: (u) => restore(fullDump, u), ...extra });

const ledgerCount = async (db: string) => Number((await query<{ n: string }>(db, "SELECT count(*) AS n FROM drizzle.__drizzle_migrations"))[0].n);

async function assertRefusedUnchanged(db: string, report: AdoptReport, reason: RegExp): Promise<void> {
  assert.equal(report.verdict, "refused");
  assert.match(report.reasons.join("\n"), reason);
  assert.equal(report.installed, null);
  assert.equal(await ledgerCount(db), 0, "the ledger is untouched");
}

describe("adopting production's first database with proof", () => {
  before(async () => {
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-test-"));
    try {
      await control.query(`CREATE DATABASE "${srcName}" TEMPLATE template0`);
    } catch {
      creatable = false;
      return;
    }
    // The code's build: the runner and nothing else.
    execFileSync("npx", ["tsx", "lib/db/src/migrate.ts"], { cwd: repoRoot, env: { ...process.env, DATABASE_URL: url(srcName), PGOPTIONS: "" }, stdio: "pipe" });
    const conn = pgCommandConnection(url(srcName));
    fullDump = path.join(workDir, "full.dump");
    const schemaDump = path.join(workDir, "schema.dump");
    execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", fullDump, conn.url], { env: conn.env, stdio: "pipe" });
    execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "--schema-only", "-f", schemaDump, conn.url], { env: conn.env, stdio: "pipe" });
    await control.query(`CREATE DATABASE "${baseName}" TEMPLATE template0`);
    restore(schemaDump, url(baseName));
  });

  after(async () => {
    if (creatable) {
      const { rows } = await control.query<{ d: string }>(
        "SELECT datname AS d FROM pg_database WHERE datname LIKE $1",
        [`p3_adopt_%${suffix}%`],
      );
      for (const { d } of rows) await control.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      await control.query("DROP ROLE IF EXISTS adopt_owner_test").catch(() => {});
    }
    await control.end();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("adopts: the migrations' rows, ledger and sequences, then the runner boots it with nothing pending", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here; CI runs per-database");
    const db = await newCase();
    const report = await adopt(db);
    assert.deepEqual(report.reasons, []);
    assert.equal(report.verdict, "adopted");
    assert.equal(report.structure.onlyInProduction.length + report.structure.onlyInReference.length, 0);
    const srcLedger = await query<{ hash: string }>(srcName, "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY hash");
    const dbLedger = await query<{ hash: string }>(db, "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY hash");
    assert.ok(srcLedger.length > 100);
    assert.deepEqual(dbLedger, srcLedger);
    assert.equal(report.installed?.ledgerEntries, srcLedger.length);
    // The rows a first boot from code has: the entitlement singleton and 0113's setting among them.
    assert.equal((await query(db, "SELECT 1 FROM entitlement_grid_revision")).length, 1);
    assert.equal((await query(db, "SELECT 1 FROM admin_config WHERE key = 'nsfw_classifier_fail_open'")).length, 1);
    // Every populated table matches the code's build row for row.
    for (const table of Object.keys(report.installed!.tables)) {
      const h = (d: string) => query<{ h: string }>(d, `SELECT md5(to_jsonb(t)::text) AS h FROM ${table} t ORDER BY 1`);
      assert.deepEqual(await h(db), await h(srcName), table);
    }
    // A fresh insert gets the next value, not a duplicate.
    const seqs = await query<{ t: string; c: string; s: string }>(
      db,
      `SELECT c.relname AS t, a.attname AS c, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS s
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL`,
    );
    for (const s of seqs) {
      const [{ mx }] = await query<{ mx: string | null }>(db, `SELECT max("${s.c}")::text AS mx FROM "${s.t}"`);
      if (mx === null) continue;
      const [{ nv }] = await query<{ nv: string }>(db, `SELECT nextval('${s.s}')::text AS nv`);
      assert.ok(BigInt(nv) > BigInt(mx), `${s.t}.${s.c}: next ${nv} after max ${mx}`);
    }
    // The server's own boot: runner (nothing pending), seeds, engine reconcile.
    execFileSync("npx", ["tsx", "scripts/boot-database.ts"], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: url(db), PGOPTIONS: "" }, stdio: "pipe" });
    assert.equal(await ledgerCount(db), srcLedger.length);
    // A feature-access read through the app's own module, against the adopted database.
    const read = execFileSync(
      "npx",
      ["tsx", "-e", `import("./src/lib/featureAccess.ts").then(async (m) => { const g = await m.getAllTierFeatureMatrix(); console.log(JSON.stringify({ f: g.features.length, p: g.permissions.length })); process.exit(0); })`],
      { cwd: apiRoot, env: { ...process.env, DATABASE_URL: url(db), PGOPTIONS: "" }, encoding: "utf8" },
    );
    const counts = JSON.parse(read.trim().split("\n").pop()!) as { f: number; p: number };
    assert.ok(counts.f > 0 && counts.p > 0, `feature access read: ${read}`);
  });

  it("refuses a database holding any row, anywhere", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const db = await newCase();
    await query(db, "CREATE SCHEMA stripe; CREATE TABLE stripe.accounts (id text); INSERT INTO stripe.accounts VALUES ('acct_x')");
    await assertRefusedUnchanged(db, await adopt(db), /production holds 1 row\(s\)/);
  });

  it("refuses a database whose ledger already records a migration", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const db = await newCase();
    await query(db, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('x', 1)");
    const report = await adopt(db);
    assert.equal(report.verdict, "refused");
    assert.match(report.reasons.join("\n"), /ledger already records 1 migration/);
    assert.equal(await ledgerCount(db), 1);
  });

  it("refuses an unrecognised schema", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const db = await newCase();
    await query(db, "CREATE SCHEMA zz_unknown");
    await assertRefusedUnchanged(db, await adopt(db), /unrecognised schema\(s\): zz_unknown/);
  });

  const mutations: Array<[string, (db: string) => Promise<void>, RegExp]> = [
    ["a dropped column", async (db) => void (await query(db, "ALTER TABLE admin_config DROP COLUMN description")), /column admin_config\.description/],
    ["an extra index", async (db) => void (await query(db, "CREATE INDEX zz_extra_idx ON admin_config (label)")), /zz_extra_idx/],
    [
      "a trigger's firing mode changed from ALWAYS to ORIGIN",
      async (db) => {
        const [{ n }] = await query<{ n: string }>(
          db,
          "SELECT tgname AS n FROM pg_trigger WHERE tgrelid = 'ncmec_safety_audit_log'::regclass AND NOT tgisinternal AND tgenabled = 'A' ORDER BY 1 LIMIT 1",
        );
        await query(db, `ALTER TABLE ncmec_safety_audit_log ENABLE TRIGGER "${n}"`);
      },
      /trigger-mode ncmec_safety_audit_log\.\S+ O/,
    ],
    [
      "a sequence's increment changed",
      async (db) => {
        const [{ s }] = await query<{ s: string }>(db, "SELECT sequencename AS s FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1 LIMIT 1");
        await query(db, `ALTER SEQUENCE public."${s}" INCREMENT BY 2`);
      },
      /sequence-def \S+ .* inc 2 /,
    ],
    [
      "a table made unlogged",
      async (db) => {
        const [{ t: table }] = await query<{ t: string }>(
          db,
          `SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND (k.conrelid = c.oid OR k.confrelid = c.oid))
           ORDER BY 1 LIMIT 1`,
        );
        await query(db, `ALTER TABLE public."${table}" SET UNLOGGED`);
      },
      /persistence u/,
    ],
    ["an extra materialized view", async (db) => void (await query(db, "CREATE MATERIALIZED VIEW zz_mv AS SELECT 1 AS one")), /relation zz_mv kind m/],
    ["a missing extension", async (db) => void (await query(db, "DROP EXTENSION vector CASCADE")), /extension vector in public/],
  ];
  for (const [what, mutate, line] of mutations) {
    it(`refuses ${what}, names it, and changes nothing`, async (t) => {
      if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
      const db = await newCase();
      await mutate(db);
      const report = await adopt(db);
      await assertRefusedUnchanged(db, report, /structure differs from the code's/);
      assert.match([...report.structure.onlyInProduction, ...report.structure.onlyInReference].join("\n"), line);
      // The diagnosis: dev (the code's build here) does not share the difference, so it came in transfer.
      assert.ok(report.diagnosis.length > 0 && report.diagnosis.every((d) => d.origin === "transfer"));
    });
  }

  it("rolls everything back when installation fails after the sequences moved, sequences included", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const db = await newCase();
    const seqState = () =>
      query<{ s: string; lv: string; ic: boolean }>(
        db,
        `SELECT schemaname || '.' || sequencename AS s, last_value::text AS lv, last_value IS NOT NULL AS ic FROM pg_sequences
         WHERE schemaname IN ('public', 'drizzle') ORDER BY 1`,
      );
    const readCalled = async () => {
      const out: Array<[string, string, boolean]> = [];
      for (const { s } of await seqState()) {
        const [r] = await query<{ lv: string; ic: boolean }>(db, `SELECT last_value::text AS lv, is_called AS ic FROM ${s.split(".").map((x) => `"${x}"`).join(".")}`);
        out.push([s, r.lv, r.ic]);
      }
      return out;
    };
    const before = await readCalled();
    assert.ok(before.some(([s]) => s.startsWith("drizzle.")), "the ledger's sequence is among those checked");
    const report = await adopt(db, {
      afterSequences: async () => {
        throw new Error("forced failure after the sequences moved");
      },
    });
    await assertRefusedUnchanged(db, report, /installation rolled back: forced failure/);
    assert.deepEqual(await readCalled(), before);
    for (const table of ["admin_config", "entitlement_grid_revision"]) {
      assert.equal((await query(db, `SELECT 1 FROM ${table}`)).length, 0, table);
    }
  });

  it("adopts as a non-superuser owner, with no privilege to change replication settings", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    try {
      await control.query("CREATE ROLE adopt_owner_test LOGIN PASSWORD 'adopt_owner_test' NOSUPERUSER NOCREATEDB NOCREATEROLE");
    } catch {
      return t.skip("CREATE ROLE is not permitted here");
    }
    const db = await newCase();
    await query(
      db,
      `DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm')
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') LOOP
           EXECUTE format('ALTER TABLE %I.%I OWNER TO adopt_owner_test', r.s, r.t);
         END LOOP;
         FOR r IN SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname IN ('public', 'drizzle') AND c.relkind = 'S'
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')) LOOP
           EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO adopt_owner_test', r.s, r.t);
         END LOOP;
       END $$;
       GRANT USAGE ON SCHEMA public, drizzle TO adopt_owner_test;`,
    );
    const owner = new URL(url(db));
    owner.username = "adopt_owner_test";
    owner.password = "adopt_owner_test";
    const [{ su }] = await query<{ su: boolean }>(db, "SELECT rolsuper AS su FROM pg_roles WHERE rolname = 'adopt_owner_test'");
    assert.equal(su, false);
    const report = await adoptProduction({ productionUrl: owner.href, devUrl: url(srcName), migrate: (u) => restore(fullDump, u) });
    assert.deepEqual(report.reasons, []);
    assert.equal(report.verdict, "adopted");
  });
});
