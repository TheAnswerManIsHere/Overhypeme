/**
 * Launch Phase 3, increment 3 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §3, "no boot overwrites an admin-owned value"): on a database built from the
 * schema baseline and booted once, an operator changes EVERY admin-owned column
 * the classification names (lib/db/src/tableClassification.ts), the server's
 * database boot runs again, and every one of them reads back as the operator
 * left it. Driven by the classification, so an admin-owned column added later is
 * covered without touching this file.
 *
 * Its own scratch database, booted in a child process (scripts/boot-database.ts):
 * the boot steps change shared configuration rows, which other test files in
 * this shard read.
 *
 * Also holds the engines entry of the classification equal to the code's own
 * list of admin-editable engine fields, the one place ownership is already
 * written down elsewhere.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { configTables, TABLE_CLASSIFICATION } from "@workspace/db/table-classification";
import { ADMIN_EDITABLE_FIELDS } from "../lib/engines/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const scratchName = `p3_admin_boot_${crypto.randomBytes(3).toString("hex")}`;

function scratchUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${scratchName}`;
  url.searchParams.delete("options"); // keep sslmode; drop only the schema-isolation options
  return url.href;
}

function boot(): void {
  execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: scratchUrl(), PGOPTIONS: "" },
    stdio: "pipe",
  });
}

/** A different value of the same type, in SQL. Every admin-owned column's type has one. */
function changed(col: string, type: string): string {
  const c = `"${col}"`;
  if (type === "boolean") return `NOT ${c}`;
  if (type === "integer" || type === "bigint") return `coalesce(${c}, 0) + 1`;
  if (type.startsWith("numeric")) return `coalesce(${c}, 0) + 0.5`;
  if (type.startsWith("timestamp")) return `CASE WHEN ${c} IS NULL THEN now() ELSE NULL END`;
  const len = /\((\d+)\)/.exec(type)?.[1];
  return len ? `left('p3·' || coalesce(${c}, ''), ${len})` : `'p3·' || coalesce(${c}, '')`;
}

let control: pg.Pool;
let scratch: pg.Pool | null = null;

describe("admin-owned configuration survives a boot", () => {
  before(async () => {
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  });

  after(async () => {
    await scratch?.end();
    await control.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await control.end();
  });

  it("the engines entry names exactly the code's admin-editable fields, plus the tombstone", () => {
    const entry = TABLE_CLASSIFICATION.engines;
    assert.equal(entry.class, "config");
    const snake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const expected = [...ADMIN_EDITABLE_FIELDS.map(snake), "deleted_at"].sort();
    assert.deepEqual([...(entry.class === "config" ? entry.columns.admin : [])].sort(), expected);
  });

  it("every admin-owned column reads back as the operator set it after the boot runs again", async (t) => {
    try {
      await control.query(`CREATE DATABASE "${scratchName}" TEMPLATE template0`);
    } catch (err) {
      t.skip(`CREATE DATABASE is not permitted here (${(err as Error).message}); CI runs per-database`);
      return;
    }
    boot(); // the first boot: the baseline, then the seeds and the engine catalogue
    scratch = new pg.Pool({ connectionString: scratchUrl(), max: 1 });

    const set: Array<{ table: string; where: string; params: unknown[]; col: string; value: unknown }> = [];
    for (const [table, owners] of configTables()) {
      if (owners.admin.length === 0) continue;
      const { rows: types } = await scratch.query<{ col: string; type: string }>(
        `SELECT attname AS col, format_type(atttypid, atttypmod) AS type
         FROM pg_attribute WHERE attrelid = $1::regclass AND attname = ANY($2)`,
        [table, owners.admin],
      );
      // Columns admin-owned on every row change on one row; a column admin-owned
      // only where a predicate holds changes on a row the predicate selects.
      const groups = new Map<string, string[]>();
      for (const col of owners.admin) {
        const predicate = owners.adminOnlyWhere?.[col] ?? "true";
        groups.set(predicate, [...(groups.get(predicate) ?? []), col]);
      }
      const keyList = owners.key.map((k) => `"${k}"`).join(", ");
      for (const [predicate, cols] of groups) {
        const { rows } = await scratch.query(
          `SELECT ${keyList} FROM "${table}" WHERE ${predicate} ORDER BY ${keyList} LIMIT 1`,
        );
        assert.ok(rows[0], `the first boot leaves ${table} with a row where ${predicate}`);
        const where = owners.key.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
        const params = owners.key.map((k) => rows[0][k]);
        const assignments = types
          .filter(({ col }) => cols.includes(col))
          .map(({ col, type }) => `"${col}" = ${changed(col, type)}`)
          .join(", ");
        const { rows: after } = await scratch.query(
          `UPDATE "${table}" SET ${assignments} WHERE ${where} RETURNING ${cols.map((c) => `"${c}"`).join(", ")}`,
          params,
        );
        for (const col of cols) set.push({ table, where, params, col, value: after[0][col] });
      }
    }
    assert.ok(set.length > 0);

    boot(); // the second boot

    const overwritten: string[] = [];
    for (const { table, where, params, col, value } of set) {
      const { rows } = await scratch.query(`SELECT "${col}" AS v FROM "${table}" WHERE ${where}`, params);
      if (JSON.stringify(rows[0]?.v) !== JSON.stringify(value)) {
        overwritten.push(`${table}.${col}: set ${JSON.stringify(value)}, read ${JSON.stringify(rows[0]?.v)}`);
      }
    }
    assert.deepEqual(overwritten, [], "a boot overwrote an operator's value");
  });
});
