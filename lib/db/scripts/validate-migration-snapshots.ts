/**
 * validate-migration-snapshots.ts
 *
 * Checks that consecutive migration snapshots are consistent with the SQL
 * migration files that separate them.
 *
 * Two checks are performed for every consecutive snapshot pair (N → N+1):
 *
 * 1. STALE SNAPSHOT
 *    The migration SQL for N+1 introduces DDL that is not yet reflected in the
 *    snapshot. Concretely: the SQL creates a table/column/enum that does not
 *    already exist in snapshot N, but snapshots N and N+1 are structurally
 *    identical (or the same structural element is still absent from N+1).
 *    This happens when a developer edits SQL but forgets to re-run
 *    `drizzle-kit generate` to update the snapshot.
 *
 * 2. PHANTOM CHANGES
 *    Snapshot N+1 contains tables, columns, or enums that are absent from
 *    snapshot N and that are not mentioned in any CREATE TABLE /
 *    ALTER TABLE ADD COLUMN / CREATE TYPE statement in the migration SQL.
 *    These additions cannot be attributed to the migration, indicating that
 *    the snapshot was edited directly or that the wrong snapshot was committed.
 *
 * Usage:
 *   pnpm --filter @workspace/db validate-snapshots
 *   node --import tsx/esm lib/db/scripts/validate-migration-snapshots.ts
 *
 * After adding a new migration:
 *   pnpm --filter @workspace/db generate   # regenerates snapshot
 *   pnpm --filter @workspace/db validate-snapshots  # should pass
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_DIR = path.resolve(__dirname, "../migrations/meta");
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const JOURNAL_PATH = path.join(META_DIR, "_journal.json");

// ─── Known historical exemptions ─────────────────────────────────────────────
//
// These are phantom column appearances that cannot be explained by any
// migration SQL file. Each entry is a DELIBERATE acknowledgement that the
// deviation is understood and accepted rather than a silent false negative.
//
// HOW TO USE: add an entry here only when you have a clear reason why the
// column exists in the snapshot without a corresponding migration statement.
// Include a comment explaining the situation.
//
// DO NOT add new entries to silence noise — investigate the root cause first.

interface PhantomExemption {
  currPrefix: string;
  table: string;
  col: string;
}

/**
 * Columns that appear in a snapshot without a corresponding ALTER TABLE ADD COLUMN
 * in the migration SQL. These were added to the schema and live database directly
 * (without a formal migration file) before this validation tooling existed, and the
 * rebuild-snapshots.ts reconstruction propagates them from the 0040/0041 accurate
 * anchors into the earliest snapshot where they first appear.
 */
const PHANTOM_COLUMN_EXEMPTIONS: PhantomExemption[] = [
  // Both columns exist in the current TypeScript schema and live database but
  // have no migration SQL file. The rebuild-snapshots script places them first
  // in snapshot 0022 (the nearest snapshot after the accurate 0021 anchor).
  { currPrefix: "0022", table: "lifetime_entitlements", col: "status" },
  { currPrefix: "0022", table: "membership_history", col: "stripe_dispute_id" },
];

function isPhantomColumnExempt(
  currPrefix: string,
  table: string,
  col: string,
): boolean {
  return PHANTOM_COLUMN_EXEMPTIONS.some(
    (e) =>
      e.currPrefix === currPrefix && e.table === table && e.col === col,
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

type Snapshot = Record<string, any>;

interface SqlDdlInfo {
  hasDdl: boolean;
  /** Tables introduced by CREATE TABLE. */
  createdTables: Set<string>;
  /** Tables removed by DROP TABLE. */
  droppedTables: Set<string>;
  /** Tables renamed via ALTER TABLE old RENAME TO new; key = old name, value = new name. */
  renamedTablesFromTo: Map<string, string>;
  /** Tables renamed via ALTER TABLE old RENAME TO new; key = new name, value = old name. */
  renamedTablesToFrom: Map<string, string>;
  /** Columns added via ALTER TABLE … ADD COLUMN, keyed by table name. */
  addedColumns: Map<string, Set<string>>;
  /** Columns removed via ALTER TABLE … DROP COLUMN, keyed by table name. */
  droppedColumns: Map<string, Set<string>>;
  /** Enums created via CREATE TYPE … AS ENUM. */
  createdEnums: Set<string>;
  /** Enums removed via DROP TYPE. */
  droppedEnums: Set<string>;
  /** Values added to existing enums via ALTER TYPE … ADD VALUE. */
  addedEnumValues: Map<string, Set<string>>;
}

interface ValidationError {
  currPrefix: string;
  kind: "stale" | "phantom";
  message: string;
}

// ─── SQL parsing ──────────────────────────────────────────────────────────────

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * Normalise a possibly-schema-qualified SQL identifier to just the entity name.
 * Handles quoted ("public"."users", "users") and unquoted (public.users, users) forms.
 */
function extractSqlName(raw: string): string {
  raw = raw.trim();
  // "schema"."name"
  let m = raw.match(/^(?:"[^"]*"|[^\s."]+)\s*\.\s*"([^"]+)"$/);
  if (m) return m[1].toLowerCase();
  // "name"
  m = raw.match(/^"([^"]+)"$/);
  if (m) return m[1].toLowerCase();
  // schema.name (unquoted)
  m = raw.match(/^[^\s.]+\.(\w+)$/);
  if (m) return m[1].toLowerCase();
  return raw.toLowerCase();
}

/**
 * Regex fragment for an optionally schema-qualified identifier.
 * Handles both quoted ("schema"."name", "name") and unquoted (schema.name, name) forms.
 * All groups are non-capturing so this can be embedded without shifting group indices.
 */
const ID = `(?:"[^"]*"|\\w+)(?:\\s*\\.\\s*(?:"[^"]*"|\\w+))?`;

/**
 * Column name: either double-quoted "name" or a bare SQL identifier.
 * Group 1 = quoted value, group 2 = unquoted value (relative to where this is used).
 */
const COL = `(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))`;

/** Extract the column name from an addColRe / dropColRe match (groups 2 & 3). */
function colName(m: RegExpExecArray): string {
  return (m[2] ?? m[3]).toLowerCase();
}

/**
 * Parse all DDL operations from the given SQL text.
 * Handles both drizzle-kit-style double-quoted identifiers and the unquoted
 * identifiers used in older hand-written migration files.
 */
function parseSqlDdl(sql: string): SqlDdlInfo {
  const clean = stripSqlComments(sql);

  const info: SqlDdlInfo = {
    hasDdl: false,
    createdTables: new Set(),
    droppedTables: new Set(),
    renamedTablesFromTo: new Map(),
    renamedTablesToFrom: new Map(),
    addedColumns: new Map(),
    droppedColumns: new Map(),
    createdEnums: new Set(),
    droppedEnums: new Set(),
    addedEnumValues: new Map(),
  };

  // General DDL presence
  if (
    /\b(?:CREATE|DROP)\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|TYPE|SEQUENCE|VIEW)\b/i.test(
      clean,
    ) ||
    /\bALTER\s+(?:TABLE|TYPE)\b/i.test(clean)
  ) {
    info.hasDdl = true;
  }

  let m: RegExpExecArray | null;

  // ── CREATE TABLE ──────────────────────────────────────────────────────────
  const createTableRe = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ID})`,
    "gi",
  );
  while ((m = createTableRe.exec(clean)) !== null) {
    info.createdTables.add(extractSqlName(m[1]));
  }

  // ── DROP TABLE ────────────────────────────────────────────────────────────
  const dropTableRe = new RegExp(
    `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ID})`,
    "gi",
  );
  while ((m = dropTableRe.exec(clean)) !== null) {
    info.droppedTables.add(extractSqlName(m[1]));
  }

  // ── ALTER TABLE … RENAME TO … ─────────────────────────────────────────────
  // The old name disappearing from the snapshot AND the new name appearing in
  // the snapshot are both accounted for by a rename — no CREATE/DROP needed.
  const renameTableRe = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ID})\\s+RENAME\\s+TO\\s+(${ID})`,
    "gi",
  );
  while ((m = renameTableRe.exec(clean)) !== null) {
    const oldName = extractSqlName(m[1]);
    const newName = extractSqlName(m[2]);
    info.renamedTablesFromTo.set(oldName, newName);
    info.renamedTablesToFrom.set(newName, oldName);
  }

  // ── ALTER TABLE ADD COLUMN ────────────────────────────────────────────────
  // Handles both:
  //   ALTER TABLE "tbl" ADD COLUMN "col" …          (drizzle-kit style)
  //   ALTER TABLE tbl ADD COLUMN IF NOT EXISTS col … (hand-written style)
  // Uses a negative lookahead to skip ADD CONSTRAINT / ADD UNIQUE / etc.
  const addColRe = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ID})\\s+ADD\\s+` +
      `(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?` +
      `(?!CONSTRAINT\\s|UNIQUE\\s|PRIMARY\\s|CHECK\\s|FOREIGN\\s)` +
      COL,
    "gi",
  );
  while ((m = addColRe.exec(clean)) !== null) {
    const table = extractSqlName(m[1]);
    const col = colName(m);
    if (!info.addedColumns.has(table)) info.addedColumns.set(table, new Set());
    info.addedColumns.get(table)!.add(col);
  }

  // ── ALTER TABLE DROP COLUMN ───────────────────────────────────────────────
  const dropColRe = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ID})\\s+DROP\\s+` +
      `(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?` +
      COL,
    "gi",
  );
  while ((m = dropColRe.exec(clean)) !== null) {
    const table = extractSqlName(m[1]);
    const col = colName(m);
    if (!info.droppedColumns.has(table))
      info.droppedColumns.set(table, new Set());
    info.droppedColumns.get(table)!.add(col);
  }

  // ── CREATE TYPE … AS ENUM ─────────────────────────────────────────────────
  const createEnumRe = new RegExp(
    `CREATE\\s+TYPE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ID})\\s+AS\\s+ENUM`,
    "gi",
  );
  while ((m = createEnumRe.exec(clean)) !== null) {
    info.createdEnums.add(extractSqlName(m[1]));
  }

  // ── DROP TYPE ─────────────────────────────────────────────────────────────
  const dropEnumRe = new RegExp(
    `DROP\\s+TYPE\\s+(?:IF\\s+EXISTS\\s+)?(${ID})`,
    "gi",
  );
  while ((m = dropEnumRe.exec(clean)) !== null) {
    info.droppedEnums.add(extractSqlName(m[1]));
  }

  // ── ALTER TYPE … ADD VALUE ────────────────────────────────────────────────
  const alterTypeValueRe = new RegExp(
    `ALTER\\s+TYPE\\s+(${ID})\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'([^']+)'`,
    "gi",
  );
  while ((m = alterTypeValueRe.exec(clean)) !== null) {
    const enumName = extractSqlName(m[1]);
    const val = m[2];
    if (!info.addedEnumValues.has(enumName))
      info.addedEnumValues.set(enumName, new Set());
    info.addedEnumValues.get(enumName)!.add(val);
  }

  return info;
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

function tableBaseName(snapshotKey: string): string {
  return snapshotKey.replace(/^public\./, "");
}

/**
 * Return true if both snapshots have the same schema structure.
 * Ignores the chain-management fields (id, prevId) which always differ.
 */
function snapshotsStructurallyEqual(a: Snapshot, b: Snapshot): boolean {
  const strip = (s: Snapshot): string => {
    const c = { ...s };
    delete c.id;
    delete c.prevId;
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
}

// ─── Per-pair validation ──────────────────────────────────────────────────────

function validatePair(
  prevPrefix: string,
  currPrefix: string,
  sqlTags: string[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  const prevSnap: Snapshot = JSON.parse(
    fs.readFileSync(
      path.join(META_DIR, `${prevPrefix}_snapshot.json`),
      "utf8",
    ),
  );
  const currSnap: Snapshot = JSON.parse(
    fs.readFileSync(
      path.join(META_DIR, `${currPrefix}_snapshot.json`),
      "utf8",
    ),
  );

  // Merge DDL info from all SQL files associated with this snapshot step.
  const ddl: SqlDdlInfo = {
    hasDdl: false,
    createdTables: new Set(),
    droppedTables: new Set(),
    renamedTablesFromTo: new Map(),
    renamedTablesToFrom: new Map(),
    addedColumns: new Map(),
    droppedColumns: new Map(),
    createdEnums: new Set(),
    droppedEnums: new Set(),
    addedEnumValues: new Map(),
  };

  for (const tag of sqlTags) {
    const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const parsed = parseSqlDdl(fs.readFileSync(sqlPath, "utf8"));

    if (parsed.hasDdl) ddl.hasDdl = true;
    for (const t of parsed.createdTables) ddl.createdTables.add(t);
    for (const t of parsed.droppedTables) ddl.droppedTables.add(t);
    for (const [from, to] of parsed.renamedTablesFromTo) {
      ddl.renamedTablesFromTo.set(from, to);
      ddl.renamedTablesToFrom.set(to, from);
    }
    for (const [tbl, cols] of parsed.addedColumns) {
      if (!ddl.addedColumns.has(tbl)) ddl.addedColumns.set(tbl, new Set());
      for (const c of cols) ddl.addedColumns.get(tbl)!.add(c);
    }
    for (const [tbl, cols] of parsed.droppedColumns) {
      if (!ddl.droppedColumns.has(tbl)) ddl.droppedColumns.set(tbl, new Set());
      for (const c of cols) ddl.droppedColumns.get(tbl)!.add(c);
    }
    for (const e of parsed.createdEnums) ddl.createdEnums.add(e);
    for (const e of parsed.droppedEnums) ddl.droppedEnums.add(e);
    for (const [en, vals] of parsed.addedEnumValues) {
      if (!ddl.addedEnumValues.has(en))
        ddl.addedEnumValues.set(en, new Set());
      for (const v of vals) ddl.addedEnumValues.get(en)!.add(v);
    }
  }

  const prevTables = (prevSnap.tables ?? {}) as Record<string, any>;
  const currTables = (currSnap.tables ?? {}) as Record<string, any>;
  const prevEnums = (prevSnap.enums ?? {}) as Record<string, any>;
  const currEnums = (currSnap.enums ?? {}) as Record<string, any>;
  const tagsLabel = sqlTags.join(", ");

  // ── Check 1: STALE SNAPSHOT ───────────────────────────────────────────────
  //
  // The snapshots are structurally identical, meaning no schema change was
  // recorded. Flag cases where the SQL implies a change that is NOT already
  // present in prevSnap — those changes should have appeared in currSnap.

  if (snapshotsStructurallyEqual(prevSnap, currSnap)) {
    for (const table of ddl.createdTables) {
      if (!prevTables[`public.${table}`]) {
        errors.push({
          currPrefix,
          kind: "stale",
          message:
            `${currPrefix}: migration SQL (${tagsLabel}) creates table "${table}" ` +
            `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
            `snapshot was not updated after the migration was written`,
        });
      }
    }

    for (const [table, cols] of ddl.addedColumns) {
      const prevTable = prevTables[`public.${table}`];
      if (!prevTable) continue; // new table — caught by the createdTables check above
      for (const col of cols) {
        if (!prevTable.columns?.[col]) {
          errors.push({
            currPrefix,
            kind: "stale",
            message:
              `${currPrefix}: migration SQL (${tagsLabel}) adds column "${table}.${col}" ` +
              `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
              `snapshot was not updated after the migration was written`,
          });
        }
      }
    }

    for (const enumName of ddl.createdEnums) {
      if (!prevEnums[`public.${enumName}`]) {
        errors.push({
          currPrefix,
          kind: "stale",
          message:
            `${currPrefix}: migration SQL (${tagsLabel}) creates enum "${enumName}" ` +
            `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
            `snapshot was not updated after the migration was written`,
        });
      }
    }

    for (const table of ddl.droppedTables) {
      if (prevTables[`public.${table}`]) {
        errors.push({
          currPrefix,
          kind: "stale",
          message:
            `${currPrefix}: migration SQL (${tagsLabel}) drops table "${table}" ` +
            `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
            `snapshot was not updated after the migration was written`,
        });
      }
    }

    for (const [table, cols] of ddl.droppedColumns) {
      const prevTable = prevTables[`public.${table}`];
      if (!prevTable) continue;
      for (const col of cols) {
        if (prevTable.columns?.[col]) {
          errors.push({
            currPrefix,
            kind: "stale",
            message:
              `${currPrefix}: migration SQL (${tagsLabel}) drops column "${table}.${col}" ` +
              `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
              `snapshot was not updated after the migration was written`,
          });
        }
      }
    }

    for (const [enumName, newVals] of ddl.addedEnumValues) {
      const prevEnum = prevEnums[`public.${enumName}`];
      if (!prevEnum) continue;
      const prevVals = new Set<string>(prevEnum.values ?? []);
      for (const val of newVals) {
        if (!prevVals.has(val)) {
          errors.push({
            currPrefix,
            kind: "stale",
            message:
              `${currPrefix}: migration SQL (${tagsLabel}) adds value "${val}" to enum "${enumName}" ` +
              `but snapshots ${prevPrefix} and ${currPrefix} are identical — ` +
              `snapshot was not updated after the migration was written`,
          });
        }
      }
    }
  }

  // ── Check 2: PHANTOM CHANGES ─────────────────────────────────────────────
  //
  // Flag structural gains in currSnap that cannot be traced to the SQL.

  // Tables newly present
  for (const tableKey of Object.keys(currTables)) {
    if (!prevTables[tableKey]) {
      const name = tableBaseName(tableKey);
      if (!ddl.createdTables.has(name) && !ddl.renamedTablesToFrom.has(name)) {
        errors.push({
          currPrefix,
          kind: "phantom",
          message:
            `${currPrefix}: table "${name}" appears in snapshot but no CREATE TABLE statement ` +
            `for it was found in migration SQL (${tagsLabel})`,
        });
      }
    }
  }

  // Tables that disappeared without a DROP TABLE
  for (const tableKey of Object.keys(prevTables)) {
    if (!currTables[tableKey]) {
      const name = tableBaseName(tableKey);
      if (!ddl.droppedTables.has(name) && !ddl.renamedTablesFromTo.has(name)) {
        errors.push({
          currPrefix,
          kind: "phantom",
          message:
            `${currPrefix}: table "${name}" disappeared from snapshot but no DROP TABLE statement ` +
            `for it was found in migration SQL (${tagsLabel})`,
        });
      }
    }
  }

  // Columns added to existing tables
  for (const tableKey of Object.keys(currTables)) {
    const tableName = tableBaseName(tableKey);
    if (!prevTables[tableKey]) continue; // new table — covered by CREATE TABLE check
    if (ddl.createdTables.has(tableName)) continue; // table was fully recreated

    const prevCols: Record<string, unknown> =
      prevTables[tableKey]?.columns ?? {};
    const currCols: Record<string, unknown> =
      currTables[tableKey]?.columns ?? {};

    for (const col of Object.keys(currCols)) {
      if (!prevCols[col]) {
        if (isPhantomColumnExempt(currPrefix, tableName, col)) continue;
        const sqlCols = ddl.addedColumns.get(tableName) ?? new Set<string>();
        if (!sqlCols.has(col)) {
          errors.push({
            currPrefix,
            kind: "phantom",
            message:
              `${currPrefix}: column "${tableName}.${col}" appears in snapshot but no ` +
              `ALTER TABLE ADD COLUMN statement for it was found in migration SQL (${tagsLabel})`,
          });
        }
      }
    }
  }

  // Columns removed from existing tables
  for (const tableKey of Object.keys(prevTables)) {
    const tableName = tableBaseName(tableKey);
    if (!currTables[tableKey]) continue; // whole table gone — handled above
    if (ddl.droppedTables.has(tableName)) continue;

    const prevCols: Record<string, unknown> =
      prevTables[tableKey]?.columns ?? {};
    const currCols: Record<string, unknown> =
      currTables[tableKey]?.columns ?? {};

    for (const col of Object.keys(prevCols)) {
      if (!currCols[col]) {
        const sqlCols = ddl.droppedColumns.get(tableName) ?? new Set<string>();
        if (!sqlCols.has(col)) {
          errors.push({
            currPrefix,
            kind: "phantom",
            message:
              `${currPrefix}: column "${tableName}.${col}" disappeared from snapshot but no ` +
              `ALTER TABLE DROP COLUMN statement for it was found in migration SQL (${tagsLabel})`,
          });
        }
      }
    }
  }

  // Enums newly present
  for (const enumKey of Object.keys(currEnums)) {
    if (!prevEnums[enumKey]) {
      const name = enumKey.replace(/^public\./, "");
      if (!ddl.createdEnums.has(name)) {
        errors.push({
          currPrefix,
          kind: "phantom",
          message:
            `${currPrefix}: enum "${name}" appears in snapshot but no CREATE TYPE AS ENUM ` +
            `statement for it was found in migration SQL (${tagsLabel})`,
        });
      }
    }
  }

  // Enums that disappeared without a DROP TYPE
  for (const enumKey of Object.keys(prevEnums)) {
    if (!currEnums[enumKey]) {
      const name = enumKey.replace(/^public\./, "");
      if (!ddl.droppedEnums.has(name)) {
        errors.push({
          currPrefix,
          kind: "phantom",
          message:
            `${currPrefix}: enum "${name}" disappeared from snapshot but no DROP TYPE ` +
            `statement for it was found in migration SQL (${tagsLabel})`,
        });
      }
    }
  }

  // Enum values gained without ALTER TYPE ADD VALUE
  for (const enumKey of Object.keys(currEnums)) {
    if (!prevEnums[enumKey]) continue; // new enum — covered by CREATE TYPE check
    const enumName = enumKey.replace(/^public\./, "");
    if (ddl.createdEnums.has(enumName)) continue; // enum was recreated

    const prevVals = new Set<string>(prevEnums[enumKey]?.values ?? []);
    const currVals: string[] = currEnums[enumKey]?.values ?? [];
    const gained = currVals.filter((v) => !prevVals.has(v));

    if (gained.length > 0) {
      const sqlVals = ddl.addedEnumValues.get(enumName) ?? new Set<string>();
      const unexplained = gained.filter((v) => !sqlVals.has(v));
      if (unexplained.length > 0) {
        errors.push({
          currPrefix,
          kind: "phantom",
          message:
            `${currPrefix}: enum "${enumName}" gains value(s) [${unexplained.map((v) => `"${v}"`).join(", ")}] ` +
            `in snapshot but no ALTER TYPE ADD VALUE statement for them was found ` +
            `in migration SQL (${tagsLabel})`,
        });
      }
    }
  }

  return errors;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function run(): void {
  if (!fs.existsSync(JOURNAL_PATH)) {
    console.error(`ERROR: Journal not found at ${JOURNAL_PATH}`);
    process.exit(1);
  }

  const journal: Journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));

  // Build ordered list of unique snapshot prefixes, each with its SQL tags.
  const prefixOrder: string[] = [];
  const prefixToTags = new Map<string, string[]>();
  const seen = new Set<string>();

  for (const entry of journal.entries) {
    const prefix = entry.tag.split("_")[0];
    if (!seen.has(prefix)) {
      seen.add(prefix);
      prefixOrder.push(prefix);
    }
    if (!prefixToTags.has(prefix)) prefixToTags.set(prefix, []);
    prefixToTags.get(prefix)!.push(entry.tag);
  }

  const allErrors: ValidationError[] = [];
  let checkedPairs = 0;
  let skippedPairs = 0;

  for (let i = 1; i < prefixOrder.length; i++) {
    const prevPrefix = prefixOrder[i - 1];
    const currPrefix = prefixOrder[i];

    if (
      !fs.existsSync(path.join(META_DIR, `${prevPrefix}_snapshot.json`)) ||
      !fs.existsSync(path.join(META_DIR, `${currPrefix}_snapshot.json`))
    ) {
      skippedPairs++;
      continue;
    }

    const sqlTags = prefixToTags.get(currPrefix) ?? [];
    allErrors.push(...validatePair(prevPrefix, currPrefix, sqlTags));
    checkedPairs++;
  }

  if (allErrors.length === 0) {
    console.log(
      `✓ Snapshot accuracy check passed — ${checkedPairs} consecutive pairs validated.`,
    );
    if (skippedPairs > 0) {
      console.log(
        `  (${skippedPairs} pairs skipped due to missing snapshot files)`,
      );
    }
    process.exit(0);
  }

  const staleErrors = allErrors.filter((e) => e.kind === "stale");
  const phantomErrors = allErrors.filter((e) => e.kind === "phantom");

  console.error(
    `\nSnapshot accuracy check FAILED — ${allErrors.length} issue(s) detected across ${checkedPairs} pairs.\n`,
  );

  if (staleErrors.length > 0) {
    console.error(
      `STALE SNAPSHOT(s) [${staleErrors.length}] — migration SQL makes schema changes not reflected in the snapshot:`,
    );
    for (const e of staleErrors) console.error(`  • ${e.message}`);
    console.error(
      "\n  Fix: run `pnpm --filter @workspace/db generate` and commit the updated snapshot.\n",
    );
  }

  if (phantomErrors.length > 0) {
    console.error(
      `PHANTOM CHANGE(s) [${phantomErrors.length}] — snapshot gains structure with no corresponding migration SQL:`,
    );
    for (const e of phantomErrors) console.error(`  • ${e.message}`);
    console.error(
      "\n  Fix: ensure migration SQL is complete, or run `pnpm --filter @workspace/db rebuild-snapshots` to resync.\n",
    );
  }

  process.exit(1);
}

run();
