/**
 * @purpose The schema baseline: where it lives beside the migrations, how a pg_dump text is executed through node-postgres, and a catalog fingerprint that compares two databases' structure while ignoring column order.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §1). No database of this product was ever built from its migrations alone —
 * 0001 alters tables that already exist — so an empty database starts from the
 * baseline: one SQL file holding the full catalog and the rows the migrations
 * themselves insert, as they stand after every migration up to a named cutoff.
 * The runner (migrate.ts) applies it to an empty database and records the
 * migrations it covers; every later migration runs as usual.
 *
 * The baseline lives INSIDE the migrations folder (`baseline/`) so the build's
 * recursive copy of that folder ships it with the server, and a test that points
 * the runner at a temporary migrations folder without one keeps the old
 * behaviour.
 */

import fs from "node:fs";
import path from "node:path";
import type pg from "pg";

export interface BaselineMeta {
  /** The journal tag of the last migration the baseline already contains. */
  cutoffTag: string;
  /** sha256 of baseline.sql, checked before the file is applied. */
  sqlSha256: string;
  /** sha256 of the historical reference the baseline was verified against. */
  referenceSchemaSha256: string;
  generatedAt: string;
  generatedAtCommit: string;
}

export const BASELINE_DIR = "baseline";

/**
 * Objects in the public schema that belong to the Stripe sync library
 * (stripe-replit-sync), which creates them at boot through its own migrations
 * (`stripeInit.ts`): triggers in its `stripe` schema call them. They are not
 * ours, so the baseline omits them and the fingerprint ignores them.
 */
export const LIBRARY_OWNED_FUNCTIONS = new Set(["set_updated_at", "set_updated_at_metadata"]);

export function readBaselineMeta(migrationsFolder: string): BaselineMeta | null {
  const metaPath = path.join(migrationsFolder, BASELINE_DIR, "baseline.json");
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf8")) as BaselineMeta;
}

export function baselineSqlPath(migrationsFolder: string): string {
  return path.join(migrationsFolder, BASELINE_DIR, "baseline.sql");
}

/**
 * Makes a plain pg_dump text executable through node-postgres' simple query
 * protocol: drops psql meta-commands (pg_dump 16.10+ wraps its output in
 * `\restrict` / `\unrestrict`) and the session `SET`s and `set_config` call that
 * would otherwise leave this pooled connection with an empty search_path.
 */
export function executableDumpText(dump: string): string {
  return dump
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .filter((line) => !/^SET [a-z_]+ = /.test(line))
    .filter((line) => !line.startsWith("SELECT pg_catalog.set_config('search_path'"))
    .join("\n");
}

/**
 * One line per structural object in `schema`, sorted, so two databases can be
 * compared exactly while column ORDER is ignored (a database that grew by
 * ALTER TABLE and one built in one step differ only there). Covers tables and
 * their columns (type, nullability, default), constraints, indexes, functions,
 * triggers, enum types and their labels, sequences, and views.
 */
export async function catalogFingerprint(client: pg.ClientBase, schema = "public"): Promise<string[]> {
  const lines: string[] = [];
  const q = async (sql: string) => (await client.query(sql, [schema])).rows as Record<string, unknown>[];

  for (const r of await q(`
    SELECT c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS ident
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped`)) {
    lines.push(`column ${r.t}.${r.col} ${r.type}${r.nn ? " not null" : ""}${r.def ? ` default ${r.def}` : ""}${r.ident ? ` identity ${r.ident}` : ""}`);
  }
  for (const r of await q(`
    SELECT c.relname AS t, con.conname AS name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relnamespace = $1::regnamespace`)) {
    lines.push(`constraint ${r.t}.${r.name} ${r.def}`);
  }
  for (const r of await q(`SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = $1`)) {
    lines.push(`index ${r.name} ${String(r.def).replaceAll(`${schema}.`, "")}`);
  }
  for (const r of await q(`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS body
    FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.prokind IN ('f','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`)) {
    if (LIBRARY_OWNED_FUNCTIONS.has(String(r.name))) continue;
    lines.push(`function ${r.name}(${r.args}) ${r.body}`);
  }
  for (const r of await q(`
    SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal`)) {
    lines.push(`trigger ${r.name} ${String(r.def).replaceAll(`${schema}.`, "")}`);
  }
  for (const r of await q(`
    SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = $1::regnamespace GROUP BY t.typname`)) {
    lines.push(`enum ${r.name} ${r.labels}`);
  }
  for (const r of await q(`SELECT sequencename AS name FROM pg_sequences WHERE schemaname = $1`)) {
    lines.push(`sequence ${r.name}`);
  }
  for (const r of await q(`SELECT viewname AS name, md5(definition) AS def FROM pg_views WHERE schemaname = $1`)) {
    lines.push(`view ${r.name} ${r.def}`);
  }
  return lines.sort();
}

/** Lines in one fingerprint and not the other, for a readable failure. */
export function fingerprintDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((l) => !sb.has(l)), onlyB: b.filter((l) => !sa.has(l)) };
}
