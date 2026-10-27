/**
 * Generates the schema baseline (Launch Phase 3, increment 2, #770; plan
 * docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §1) into
 * lib/db/migrations/baseline/: baseline.sql and baseline.json.
 *
 * Built WITHOUT drizzle-kit push, from the historical reference — dev's real
 * catalog and migration ledger, captured by scripts/snapshot-database.ts and
 * committed under lib/db/baseline-reference/ — in two scratch databases:
 *
 *   1. STRUCTURE: the reference catalog (minus what is not ours: the test
 *      runner's cached schemas, the Stripe sync library's `stripe` schema and
 *      its two functions) with dev's own ledger, upgraded by the real runner.
 *      Only the migrations dev has not run apply, exactly as they would on any
 *      long-lived database. This is the catalog the history actually produced.
 *   2. SEED ROWS: the same catalog with an EMPTY ledger, every migration
 *      replayed. Their DDL finds its work done and is skipped; their INSERTs and
 *      UPDATEs leave the rows migrations put there. Replaying history over its
 *      own end state also resurrects things later migrations renamed away (an
 *      `email_outbox` table, for one), which is why the structure never comes
 *      from here — only the rows of tables the structure also has. No operator
 *      value from dev can reach the baseline: the reference holds no rows.
 *   3. The rows are copied into the structure database, its public schema is
 *      dumped, schema and rows, and stored with its sha256.
 *
 * Run (needs a local PostgreSQL superuser, as CI and the sandbox have):
 *   DATABASE_URL=postgres://… pnpm --filter @workspace/db exec tsx scripts/generate-baseline.ts
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { BASELINE_DIR, executableDumpText, type BaselineMeta } from "../src/baseline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbRoot = path.resolve(here, "..");
const migrationsFolder = path.join(dbRoot, "migrations");
const referenceSchema = path.join(dbRoot, "baseline-reference", "dev-schema.sql");

const control = process.env.DATABASE_URL;
if (!control) throw new Error("DATABASE_URL (a local superuser connection) is required");
if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
const cutoffTag: string = journal.entries[journal.entries.length - 1].tag;

const scratchName = `overhype_baseline_${Date.now()}`;
const created: string[] = [];
const controlPool = new pg.Pool({ connectionString: control });

const referenceText = fs.readFileSync(referenceSchema, "utf8");
const referenceLedger: Array<{ hash: string; created_at: string }> = JSON.parse(
  fs.readFileSync(path.join(dbRoot, "baseline-reference", "dev-ledger.json"), "utf8"),
);

// A copy of the migrations folder WITHOUT the baseline keeps the runner in its
// plain upgrade behaviour for both scratch databases.
const plainFolder = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-migrations-"));
for (const name of fs.readdirSync(migrationsFolder)) {
  if (name === BASELINE_DIR) continue;
  fs.cpSync(path.join(migrationsFolder, name), path.join(plainFolder, name), { recursive: true });
}
process.env.DRIZZLE_MIGRATIONS_FOLDER = plainFolder;
process.env.DRIZZLE_MIGRATIONS_SCHEMA = "drizzle";
const { applyMigrations } = await import("../src/migrate.js");

async function scratchDatabase(suffix: string): Promise<{ url: URL; pool: pg.Pool }> {
  const name = `${scratchName}_${suffix}`;
  await controlPool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created.push(name);
  const url = new URL(control);
  url.pathname = `/${name}`;
  return { url, pool: new pg.Pool({ connectionString: url.href, max: 1 }) };
}

/** The reference catalog, minus what is not ours; keeps or empties its ledger. */
async function loadReference(client: pg.PoolClient, keepLedger: boolean): Promise<void> {
  await client.query(executableDumpText(referenceText));
  await client.query("SET search_path TO public");
  await client.query(`
    DROP SCHEMA IF EXISTS stripe CASCADE;
    DROP SCHEMA IF EXISTS heliumdb_test CASCADE;
    DROP SCHEMA IF EXISTS drizzle_test CASCADE;
    DROP FUNCTION IF EXISTS public.set_updated_at();
    DROP FUNCTION IF EXISTS public.set_updated_at_metadata();
  `);
  if (keepLedger) {
    for (const row of referenceLedger) {
      await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [row.hash, row.created_at]);
    }
  } else {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  }
}

try {
  // 1. Structure: the reference with dev's ledger, upgraded.
  const structure = await scratchDatabase("structure");
  const sClient = await structure.pool.connect();
  await loadReference(sClient, true);
  const upgraded = await applyMigrations(sClient);
  console.log(`[baseline] structure: ${upgraded.applied} migration(s) dev had not run, applied`);

  // 2. Seed rows: the reference with an empty ledger, every migration replayed.
  const seeds = await scratchDatabase("seeds");
  const rClient = await seeds.pool.connect();
  await loadReference(rClient, false);
  const replayed = await applyMigrations(rClient);
  console.log(`[baseline] seeds: ${replayed.applied} migrations replayed`);
  const { rows: tables } = await rClient.query<{ t: string }>(
    "SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'",
  );
  const withRows: string[] = [];
  for (const { t } of tables) {
    const present = await sClient.query("SELECT to_regclass($1) IS NOT NULL AS p", [`public."${t}"`]);
    const count = await rClient.query(`SELECT count(*) AS n FROM public."${t}"`);
    if (present.rows[0].p && Number(count.rows[0].n) > 0) withRows.push(t);
  }
  rClient.release();
  await seeds.pool.end();

  // 3. Copy the seed rows across, then dump.
  if (withRows.length > 0) {
    const data = execFileSync(
      "pg_dump",
      ["--data-only", "--column-inserts", "--no-owner", "--no-acl", ...withRows.map((t) => `--table=public."${t}"`), seeds.url.href],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    await sClient.query(executableDumpText(data));
    await sClient.query("SET search_path TO public");
  }
  console.log(`[baseline] seed rows copied from: ${withRows.sort().join(", ") || "(none)"}`);
  sClient.release();
  await structure.pool.end();
  const scratchUrl = structure.url;

  // 3. Dump the public schema, schema and rows.
  const dump = execFileSync(
    "pg_dump",
    ["--schema=public", "--no-owner", "--no-acl", "--column-inserts", "--no-comments", scratchUrl.href],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // The public schema already exists in every database, so its CREATE goes;
  // pg_dump's table-of-contents comments go too, which keeps the file readable.
  const body = executableDumpText(dump)
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .filter((line) => line !== "CREATE SCHEMA public;")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  const header =
    `-- Schema baseline at ${cutoffTag} (Launch Phase 3, #770). GENERATED by\n` +
    "-- lib/db/scripts/generate-baseline.ts — do not edit by hand; regenerate.\n" +
    "-- Applied by lib/db/src/migrate.ts to an EMPTY database only, in one\n" +
    "-- transaction with the ledger rows for every migration up to the cutoff.\n" +
    "-- Seed rows' timestamps are the generation run's, so two runs differ there\n" +
    "-- and nowhere else.\n\n" +
    "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n";
  const sql = `${header}${body.trimEnd()}\n`;

  const outDir = path.join(migrationsFolder, BASELINE_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "baseline.sql"), sql);
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // not a checkout
  }
  const meta: BaselineMeta = {
    cutoffTag,
    sqlSha256: sha256(sql),
    referenceSchemaSha256: sha256(referenceText),
    generatedAt: new Date().toISOString(),
    generatedAtCommit: commit,
  };
  fs.writeFileSync(path.join(outDir, "baseline.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[baseline] wrote ${outDir} (cutoff ${cutoffTag}, sha256 ${meta.sqlSha256})`);
} finally {
  for (const name of created) await controlPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await controlPool.end();
}
