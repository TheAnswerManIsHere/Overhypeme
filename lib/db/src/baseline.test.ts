/**
 * Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §1 and §2): the runner builds an empty database from the baseline, upgrades
 * one that carries a ledger, and refuses one built by anything else — and the
 * baseline agrees with the history it summarises.
 *
 * Every case gets its own scratch database (CREATE DATABASE, which CI's and the
 * sandbox's test role can do), dropped afterwards, so nothing here touches the
 * shared test database's schema.
 *
 *   - empty → baseline: every journal migration recorded, and a second run is a
 *     no-op;
 *   - a migration added after the cutoff runs on top of the baseline, so the
 *     next forward migration needs no regenerated baseline;
 *   - the historical reference (dev's real catalog and ledger, captured
 *     2026-10-27) upgraded by the runner ends with exactly the catalog a
 *     baseline-built database has — column order aside. This is the standing
 *     check that the baseline has not drifted from the history, and it runs no
 *     schema push anywhere;
 *   - a replay of every migration creates nothing the baseline lacks (the
 *     check that no object the history created was lost on the way into it);
 *   - tables but no ledger → refused, recording nothing;
 *   - a baseline that fails part-way leaves nothing behind, and the next run
 *     builds the database;
 *   - and, without a database: no package script, workflow or script invokes
 *     a schema push (the oracle's "no bootstrap or verification path executes
 *     drizzle-kit push", held by a check rather than by memory).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";

import * as schema from "./schema/index.js";
import { catalogFingerprint, executableDumpText, fingerprintDiff, readBaselineMeta } from "./baseline.js";
import { applyMigrations, getMigrationsFolder } from "./migrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_SCHEMA = path.resolve(here, "../baseline-reference/dev-schema.sql");
const REFERENCE_LEDGER = path.resolve(here, "../baseline-reference/dev-ledger.json");
const RUN = crypto.randomBytes(3).toString("hex");

let control: pg.Pool;
const created: string[] = [];

async function scratch(label: string): Promise<pg.Pool> {
  const name = `p3_baseline_${label}_${RUN}`;
  await control.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return new pg.Pool({ connectionString: url.href, max: 2 });
}

async function withClient<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function ledgerCount(c: pg.PoolClient): Promise<number> {
  const { rows } = await c.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
  if (!rows[0].present) return 0;
  return Number((await c.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);
}

const journalTags = (): string[] =>
  JSON.parse(fs.readFileSync(path.join(getMigrationsFolder(), "meta/_journal.json"), "utf8")).entries.map(
    (e: { tag: string }) => e.tag,
  );
const journalLength = (): number => journalTags().length;
/** Migrations added after the baseline's cutoff: the runner applies these on top of it. */
const afterCutoff = (): number => {
  const tags = journalTags();
  const cutoff = tags.indexOf(readBaselineMeta(getMigrationsFolder())!.cutoffTag);
  assert.ok(cutoff >= 0, "the baseline's cutoff is a journal entry");
  return tags.length - cutoff - 1;
};

describe("schema baseline", { concurrency: false }, () => {
  let baselineFingerprint: string[];

  before(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at the test database");
    delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
    delete process.env.DRIZZLE_MIGRATIONS_SCHEMA;
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    assert.ok(readBaselineMeta(getMigrationsFolder()), "the migrations folder carries a baseline");
  });

  after(async () => {
    for (const name of created) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await control.end();
  });

  it("builds an empty database from the baseline, recording every migration, and a second run does nothing", async () => {
    const pool = await scratch("empty");
    try {
      await withClient(pool, async (c) => {
        const first = await applyMigrations(c);
        assert.equal(first.applied, afterCutoff(), "everything up to the cutoff comes from the baseline; only later migrations run");
        assert.equal(await ledgerCount(c), journalLength());
        const second = await applyMigrations(c);
        assert.deepEqual([second.applied, second.skipped], [0, journalLength()]);
        const { rows } = await c.query("SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'");
        assert.equal(Number(rows[0].n), 1, "the baseline installs the vector extension");
        baselineFingerprint = await catalogFingerprint(c);
      });
    } finally {
      await pool.end();
    }
  });

  it("upgrades the historical reference to exactly the baseline's catalog, column order aside", async () => {
    const pool = await scratch("reference");
    try {
      await withClient(pool, async (c) => {
        await c.query(executableDumpText(fs.readFileSync(REFERENCE_SCHEMA, "utf8")));
        await c.query("SET search_path TO public");
        // The test runner's cached schemas are not part of dev's real database.
        await c.query("DROP SCHEMA IF EXISTS heliumdb_test CASCADE; DROP SCHEMA IF EXISTS drizzle_test CASCADE");
        const ledger: Array<{ hash: string; created_at: string }> = JSON.parse(fs.readFileSync(REFERENCE_LEDGER, "utf8"));
        for (const row of ledger) {
          await c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [row.hash, row.created_at]);
        }
        // Exactly the journal entries whose hash dev's ledger lacks run — the
        // migrations written since the reference was captured — and the
        // baseline is never taken: the ledger only grows by those.
        const recorded = new Set(ledger.map((r) => r.hash));
        const pending = journalTags().filter(
          (tag) => !recorded.has(crypto.createHash("sha256").update(fs.readFileSync(path.join(getMigrationsFolder(), `${tag}.sql`), "utf8")).digest("hex")),
        );
        assert.ok(pending.includes("0111_normalize_legacy_names"), "the reference predates 0111");
        const result = await applyMigrations(c);
        assert.equal(result.applied, pending.length, `only the migrations after the reference run: ${pending.join(", ")}`);
        assert.equal(await ledgerCount(c), ledger.length + pending.length, "the baseline was not taken");
        const upgraded = await catalogFingerprint(c);
        const diff = fingerprintDiff(baselineFingerprint, upgraded);
        assert.deepEqual(diff, { onlyA: [], onlyB: [] }, "baseline-built and upgraded-reference catalogs differ");
      });
    } finally {
      await pool.end();
    }
  });

  it("builds from the baseline and then runs a migration added after its cutoff", async () => {
    // The next forward migration lands without regenerating the baseline: a
    // copy of the migrations folder with one more journal entry stands in.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-later-"));
    fs.cpSync(getMigrationsFolder(), folder, { recursive: true });
    const journalPath = path.join(folder, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const last = journal.entries[journal.entries.length - 1];
    const tag = "9999_after_the_cutoff";
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    fs.writeFileSync(path.join(folder, `${tag}.sql`), "CREATE TABLE after_the_cutoff (id integer);");
    process.env.DRIZZLE_MIGRATIONS_FOLDER = folder;
    const pool = await scratch("later");
    try {
      await withClient(pool, async (c) => {
        const result = await applyMigrations(c);
        // Real migrations after the cutoff (journalTags() reads the copied
        // folder, which now holds the synthetic one too) all run, and only they.
        assert.equal(result.applied, afterCutoff(), "only the migrations after the cutoff run");
        assert.equal(await ledgerCount(c), journal.entries.length);
        const { rows } = await c.query("SELECT to_regclass('public.after_the_cutoff') IS NOT NULL AS present");
        assert.ok(rows[0].present);
        const again = await applyMigrations(c);
        assert.deepEqual([again.applied, await ledgerCount(c)], [0, journal.entries.length], "a second run does nothing");
      });
    } finally {
      delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
      fs.rmSync(folder, { recursive: true, force: true });
      await pool.end();
    }
  });

  it("holds every object the full migration history creates", async () => {
    // Replays every migration over dev's historical catalog with an EMPTY
    // ledger, so each one's DDL either finds its work done or creates what it
    // creates; anything in that replay and not in the baseline would be an
    // object the baseline lost. Two kinds of line are expected and filtered:
    // the same CHECK printed two ways (`IN (...)` written by a migration,
    // `= ANY (ARRAY[...::text])` read back from a dump), and the table 0063
    // renamed away (email_outbox → async_jobs), which a replay over the end
    // state creates again because its CREATE comes first.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-replay-"));
    for (const name of fs.readdirSync(getMigrationsFolder())) {
      if (name !== "baseline") fs.cpSync(path.join(getMigrationsFolder(), name), path.join(folder, name), { recursive: true });
    }
    const pool = await scratch("replay");
    try {
      await withClient(pool, async (c) => {
        await c.query(executableDumpText(fs.readFileSync(REFERENCE_SCHEMA, "utf8")));
        await c.query("SET search_path TO public");
        await c.query(`
          DROP SCHEMA IF EXISTS stripe CASCADE; DROP SCHEMA IF EXISTS heliumdb_test CASCADE;
          DROP SCHEMA IF EXISTS drizzle_test CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;
          DROP FUNCTION IF EXISTS public.set_updated_at(); DROP FUNCTION IF EXISTS public.set_updated_at_metadata();`);
        process.env.DRIZZLE_MIGRATIONS_FOLDER = folder;
        await applyMigrations(c);
        const canonical = (line: string) =>
          line.replace(/::character varying|::text|\[\]|[()\s]/g, "").replace(/ARRAY\[/g, "[");
        const inBaseline = new Set(baselineFingerprint.map(canonical));
        const lost = (await catalogFingerprint(c))
          .filter((line) => !inBaseline.has(canonical(line)))
          .filter((line) => !/\bemail_outbox(_\w+)?\b/.test(line));
        assert.deepEqual(lost, [], "objects the migrations create that the baseline does not hold");
      });
    } finally {
      delete process.env.DRIZZLE_MIGRATIONS_FOLDER;
      fs.rmSync(folder, { recursive: true, force: true });
      await pool.end();
    }
  });

  it("refuses a schema that holds tables but no ledger, and records nothing", async () => {
    const pool = await scratch("stray");
    try {
      await withClient(pool, async (c) => {
        await c.query("CREATE TABLE built_elsewhere (id integer)");
        await assert.rejects(applyMigrations(c), /Refusing to migrate: the current schema already holds 1 table/);
        assert.equal(await ledgerCount(c), 0);
      });
    } finally {
      await pool.end();
    }
  });

  it("leaves nothing behind when the baseline fails part-way, and the next run builds the database", async () => {
    const pool = await scratch("retry");
    try {
      await withClient(pool, async (c) => {
        // A type the baseline creates, already present: the baseline's CREATE
        // TYPE fails inside its transaction. A type is not a table, so the
        // runner still takes the baseline path rather than refusing.
        await c.query("CREATE TYPE activity_type AS ENUM ('x')");
        await assert.rejects(applyMigrations(c), /Failed to apply the baseline .* nothing was recorded/);
        assert.equal(await ledgerCount(c), 0);
        const { rows } = await c.query(
          "SELECT count(*) AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'",
        );
        assert.equal(Number(rows[0].n), 0, "no table survives the rollback");

        await c.query("DROP TYPE activity_type");
        await applyMigrations(c);
        assert.equal(await ledgerCount(c), journalLength());
      });
    } finally {
      await pool.end();
    }
  });
});

/** The spellings drizzle and PostgreSQL use for the same column type. */
function sameType(declared: string, stored: string): boolean {
  const norm = (t: string) =>
    t
      .replace(/^bigserial$/, "bigint")
      .replace(/^serial$/, "integer")
      .replace(/^varchar/, "character varying")
      .replace(/^timestamp$/, "timestamp without time zone")
      .replace(/,\s+/g, ",");
  return norm(declared) === norm(stored);
}

describe("the TypeScript schema matches what the migrations build", () => {
  it("every declared table and column exists with its type and nullability, and nothing undeclared does", async () => {
    // Read-only inspection of a baseline-built database: the parity a schema
    // push used to supply as a side effect, without running one.
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const pool = await scratch("parity");
    try {
      await withClient(pool, async (c) => {
        await applyMigrations(c);
        const { rows } = await c.query(`
          SELECT c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS nn
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`);
        const stored = new Map(rows.map((r) => [`${r.t}.${r.col}`, r]));
        const storedTables = new Set(rows.map((r) => r.t as string));
        const declaredTables = new Set<string>();
        const declaredColumns = new Set<string>();
        const issues: string[] = [];
        for (const value of Object.values(schema)) {
          if (!is(value, PgTable)) continue;
          const cfg = getTableConfig(value);
          if (cfg.schema && cfg.schema !== "public") continue;
          declaredTables.add(cfg.name);
          for (const col of cfg.columns) {
            const key = `${cfg.name}.${col.name}`;
            declaredColumns.add(key);
            const row = stored.get(key);
            if (!row) issues.push(`declared, not built: ${key}`);
            else {
              if (row.nn !== col.notNull) issues.push(`nullability differs: ${key} (declared ${col.notNull}, built ${row.nn})`);
              if (!sameType(col.getSQLType(), row.type)) issues.push(`type differs: ${key} (declared ${col.getSQLType()}, built ${row.type})`);
            }
          }
        }
        for (const key of stored.keys()) if (declaredTables.has(key.split(".")[0]) && !declaredColumns.has(key)) issues.push(`built, not declared: ${key}`);
        for (const t of storedTables) if (!declaredTables.has(t)) issues.push(`table built, not declared: ${t}`);
        for (const t of declaredTables) if (!storedTables.has(t)) issues.push(`table declared, not built: ${t}`);
        assert.deepEqual(issues, []);
      });
    } finally {
      await pool.end();
      for (const name of created.splice(0)) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    }
  });
});

describe("no schema push anywhere", () => {
  it("no package script, workflow or shell or TypeScript script outside a comment invokes drizzle-kit push", () => {
    const root = path.resolve(here, "../../..");
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    const inScope = tracked.filter(
      (f) =>
        f.endsWith("package.json") ||
        f.startsWith(".github/workflows/") ||
        f.endsWith(".sh") ||
        (f.endsWith(".ts") && /(^|\/)scripts\//.test(f)),
    );
    const invocation = /drizzle-kit\s+push|(^|["'\s])push-force\b/;
    const offenders: string[] = [];
    for (const file of inScope) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      text.split("\n").forEach((line, i) => {
        const code = line.trim();
        if (/^(#|\/\/|\*|\/\*)/.test(code)) return;
        if (invocation.test(code)) offenders.push(`${file}:${i + 1}: ${code.slice(0, 120)}`);
      });
    }
    assert.deepEqual(offenders, [], "a schema push is invoked; databases are built by the migration runner from the baseline");
  });
});
