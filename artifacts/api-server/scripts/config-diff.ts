/**
 * The config diff (Launch Phase 3, increment 3, #770; plan
 * docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §3): what an existing database's
 * configuration holds that a database built from code alone would not.
 *
 * It builds a scratch database from the schema baseline, boots it
 * (scripts/boot-database.ts: migrations, ensureSchema, the engine catalogue),
 * and compares every configuration table the classification names
 * (lib/db/src/tableClassification.ts) against the target, row by row:
 *
 *   - missing:      a row or a code-owned value the target has and code does not
 *                   produce. Each becomes a seed or a migration, or is recorded
 *                   as deliberately left behind.
 *   - operator-set: an admin-owned value that differs from the default. It goes
 *                   to David only where it records an unsettled product choice;
 *                   otherwise an admin sets it again.
 *   - new in code:  a row code produces that the target lacks (it has not booted
 *                   this code yet). Informational.
 *   Runtime-owned columns are ignored.
 *
 * The target is read, never written: a live database in a READ ONLY
 * transaction (--target-url), or a JSON export of its configuration tables
 * (--target-json, an object of table name → array of rows, as json_agg prints
 * them). The scratch database lives on --server (default: DATABASE_URL's
 * server) and is dropped afterwards.
 *
 * Run:
 *   DATABASE_URL=… pnpm --filter @workspace/api-server exec tsx scripts/config-diff.ts \
 *     (--target-url <url> | --target-json <file>) [--out <report.json>]
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { configTables, type ConfigOwnership } from "@workspace/db/table-classification";

import { diffTable, type Row } from "../src/lib/configDiff.js";

/**
 * Selects a config table's rows with each conditional admin column's predicate
 * evaluated. Hashed: each code- and admin-owned value is replaced by the md5 of
 * its text form, computed by PostgreSQL, so a large export (prompts run to
 * kilobytes) travels as a fingerprint and both sides are normalised alike.
 */
export function selectSql(table: string, owners: ConfigOwnership, hashed = false): string {
  const flags = Object.entries(owners.adminOnlyWhere ?? {}).map(([col, p]) => `, (${p}) AS "__admin_${col}"`);
  if (!hashed) return `SELECT *${flags.join("")} FROM "${table}"`;
  const keys = owners.key.map((k) => `"${k}"`);
  const values = [...owners.code, ...owners.admin].map((c) => `md5(coalesce("${c}"::text, '<null>')) AS "${c}"`);
  return `SELECT ${[...keys, ...values].join(", ")}${flags.join("")} FROM "${table}"`;
}

/** A conditional predicate evaluated in JS for exported rows; only the shapes the classification uses. */
function evalPredicate(predicate: string, row: Row): boolean {
  const m = /^(\w+) = '([^']*)'$/.exec(predicate.trim());
  if (!m) throw new Error(`config-diff: cannot evaluate ${JSON.stringify(predicate)} on an export; use --target-url`);
  return row[m[1]] === m[2];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
  const server = arg("--server") ?? process.env.DATABASE_URL;
  const targetUrl = arg("--target-url");
  const targetJson = arg("--target-json");
  const hashed = process.argv.includes("--hashed");
  if (process.argv.includes("--print-export-sql")) {
    // The one query that exports a target's configuration for --target-json --hashed.
    const parts = configTables().map(([t, o]) => `'${t}', (SELECT coalesce(json_agg(x), '[]') FROM (${selectSql(t, o, true)}) x)`);
    console.log(`SELECT json_build_object(${parts.join(", ")})`);
    return;
  }
  if (!server || (!targetUrl === !targetJson)) {
    throw new Error(
      "usage: config-diff.ts (--target-url <url> | --target-json <file>) [--hashed] [--server <url>] [--out <file>] | --print-export-sql",
    );
  }

  const tables = configTables();
  const target = new Map<string, Row[]>();
  if (targetJson) {
    const data = JSON.parse(fs.readFileSync(targetJson, "utf8")) as Record<string, Row[]>;
    for (const [table, owners] of tables) {
      if (!Array.isArray(data[table])) throw new Error(`config-diff: the export has no ${table}`);
      target.set(
        table,
        data[table].map((r) => {
          // A hashed export carries its predicate flags already evaluated.
          const flags = hashed
            ? {}
            : Object.fromEntries(
                Object.entries(owners.adminOnlyWhere ?? {}).map(([col, p]) => [`__admin_${col}`, evalPredicate(p, r)]),
              );
          return { ...r, ...flags };
        }),
      );
    }
  } else {
    const client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      for (const [table, owners] of tables) target.set(table, (await client.query(selectSql(table, owners, hashed))).rows);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  }

  const scratchName = `config_diff_${crypto.randomBytes(3).toString("hex")}`;
  const control = new pg.Client({ connectionString: server });
  await control.connect();
  const freshUrl = new URL(server);
  freshUrl.pathname = `/${scratchName}`;
  freshUrl.search = "";
  const fresh = new Map<string, Row[]>();
  try {
    await control.query(`CREATE DATABASE "${scratchName}" TEMPLATE template0`);
    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: freshUrl.href, PGOPTIONS: "" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const client = new pg.Client({ connectionString: freshUrl.href });
    await client.connect();
    try {
      for (const [table, owners] of tables) fresh.set(table, (await client.query(selectSql(table, owners, hashed))).rows);
    } finally {
      await client.end();
    }
  } finally {
    await control.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await control.end();
  }

  const differences = tables.flatMap(([table, owners]) => diffTable(table, owners, target.get(table)!, fresh.get(table)!));
  const counts = { missing: 0, "operator-set": 0, "new-in-code": 0 };
  for (const d of differences) counts[d.kind]++;
  console.log(`[config-diff] ${tables.length} configuration tables compared: ${JSON.stringify(counts)}`);
  for (const d of differences) {
    const cols = d.columns.map((c) => c.column).join(", ");
    console.log(`  ${d.kind.padEnd(12)} ${d.table} ${d.key}${cols ? ` (${cols})` : ""}`);
  }
  const out = arg("--out");
  if (out) fs.writeFileSync(out, `${JSON.stringify({ counts, differences }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
