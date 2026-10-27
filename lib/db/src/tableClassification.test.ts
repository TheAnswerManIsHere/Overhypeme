/**
 * Launch Phase 3, increment 3 (#770; plan §3): every table the migrations build
 * is classified, nothing classified is missing, and every column of every
 * configuration table has exactly one owner — so a table or column added later
 * fails here until someone decides what it is, instead of slipping past the
 * config diff.
 *
 * Reads the test database (built from the schema baseline by `migrate`); it
 * writes nothing.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { TABLE_CLASSIFICATION, configTables } from "./tableClassification.js";

let pool: pg.Pool;
const columnsOf = new Map<string, string[]>();

describe("table classification", () => {
  before(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at the test database");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const { rows } = await pool.query<{ t: string; col: string }>(`
      SELECT c.relname AS t, a.attname AS col
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`);
    for (const { t, col } of rows) columnsOf.set(t, [...(columnsOf.get(t) ?? []), col]);
  });

  after(async () => {
    await pool.end();
  });

  it("names every table the migrations build, and no table they do not", () => {
    const built = [...columnsOf.keys()].sort();
    const classified = Object.keys(TABLE_CLASSIFICATION).sort();
    assert.deepEqual(
      { unclassified: built.filter((t) => !(t in TABLE_CLASSIFICATION)), stale: classified.filter((t) => !columnsOf.has(t)) },
      { unclassified: [], stale: [] },
      "classify the table in lib/db/src/tableClassification.ts (product, config, runtime or excluded)",
    );
  });

  it("gives every column of every configuration table exactly one owner", () => {
    const issues: string[] = [];
    for (const [table, owners] of configTables()) {
      const claimed = [...owners.key, ...owners.code, ...owners.admin, ...owners.runtime];
      const built = columnsOf.get(table) ?? [];
      for (const col of built) {
        const n = claimed.filter((c) => c === col).length;
        if (n !== 1) issues.push(`${table}.${col}: ${n === 0 ? "no owner" : `${n} owners`}`);
      }
      for (const col of claimed) if (!built.includes(col)) issues.push(`${table}.${col}: claimed, not built`);
    }
    assert.deepEqual(issues, []);
  });
});
