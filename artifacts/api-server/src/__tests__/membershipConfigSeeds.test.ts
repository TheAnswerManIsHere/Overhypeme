/**
 * The `admin_config` seeds migration 0094 writes.
 *
 * Asserted against the MIGRATION FILE, not against a database. That is
 * deliberate: the sharded test runner clones its databases with
 * `pg_dump --schema-only`, so migration DML is absent from them by design, and a
 * test that read the rows back would pass or fail on which harness ran it. The
 * declarations are the thing that can drift, and they live in the file.
 *
 * The end-to-end half — every key visible in `GET /admin/config` and editable
 * via `PATCH` after the migration actually runs — needs a migrated database and
 * belongs in the TEST_RUN, which is what a TEST_RUN is for.
 *
 * The load-bearing case here is the last one: `lease_ttl_seconds`'s `min_value`
 * is a literal in SQL, derived from constants that live in TypeScript. Changing
 * a constant without re-seeding would silently leave the supported admin UI
 * accepting a lease shorter than the Stripe request it must outlive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEMBERSHIP_CONFIG_DEFAULTS,
  minimumLeaseTtlSeconds,
  minimumRunLeaseTtlSeconds,
  type MembershipConfigKey,
} from "../lib/membershipTiming.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../lib/db/migrations",
);
const MIGRATION = path.join(MIGRATIONS_DIR, "0094_membership_entitlements.sql");
/**
 * Migrations that RE-SEED a key 0094 already inserted.
 *
 * The effective seed is the insert as later migrations left it, not the insert
 * alone — so a re-seed that corrected a derived floor has to be read here too.
 * Reading only 0094 would make the drift tripwire below assert against a value
 * no database has had since 0096 ran, which is the tripwire failing open.
 */
const RESEED_MIGRATIONS = ["0096_reconciliation_runs.sql"];

const KEYS = Object.keys(MEMBERSHIP_CONFIG_DEFAULTS) as MembershipConfigKey[];

interface SeededRow {
  key: string;
  value: string;
  dataType: string;
  minValue: number | null;
  maxValue: number | null;
  isPublic: boolean;
}

/**
 * Parse the `INSERT INTO admin_config … VALUES …` block.
 *
 * Each tuple is `(key, value, data_type, label, description, min, max, is_public)`.
 * Labels and descriptions are quoted strings that may contain commas, so this
 * anchors on the shape of the leading and trailing scalars rather than splitting.
 */
function parseSeeds(sql: string): SeededRow[] {
  const rows: SeededRow[] = [];
  const pattern =
    /\(\s*'([a-z_]+)',\s*'([^']*)',\s*'(integer|float|numeric|string)',\s*'(?:[^']|'')*',\s*'(?:[^']|'')*',\s*(-?\d+|NULL),\s*(-?\d+|NULL),\s*(true|false)\s*\)/g;

  for (const match of sql.matchAll(pattern)) {
    rows.push({
      key: match[1],
      value: match[2],
      dataType: match[3],
      minValue: match[4] === "NULL" ? null : Number(match[4]),
      maxValue: match[5] === "NULL" ? null : Number(match[5]),
      isPublic: match[6] === "true",
    });
  }
  return rows;
}

/**
 * Does a re-seed's guard hold for the value the chain has produced so far?
 *
 * A re-seed is often conditional — "raise it only where it is now unsafe", so an
 * operator's deliberate higher setting survives. Whether it applies to a FRESH
 * database is then a question about the value 0094 inserted, which is exactly
 * what this evaluates. Only the numeric comparisons the migrations actually use
 * are modelled, and anything else THROWS rather than being skipped: a guard this
 * cannot read is a guard whose effect on the seed is unknown, and quietly
 * ignoring it would turn the drift tripwire below into a test that passes
 * because it stopped looking.
 */
function guardHolds(where: string, row: SeededRow): boolean {
  const conditions = where.match(/\bAND\b\s*([^)]*?)(?=\s*\bAND\b|$)/gi) ?? [];

  for (const raw of conditions) {
    const condition = raw.replace(/^\s*AND\s*/i, "").trim().replace(/;$/, "");
    if (!condition) continue;

    // A digits-only shape guard — always true of a seeded integer literal.
    if (/^\(?\s*value\s*~\s*'\^\[0-9\]\+\$'\s*\)?$/i.test(condition)) {
      if (!/^\d+$/.test(row.value)) return false;
      continue;
    }

    const numeric = condition.match(/^\(?\s*value::integer\s*(<=|>=|<|>|=)\s*(-?\d+)\s*\)?$/i);
    if (numeric) {
      const actual = Number(row.value);
      const bound = Number(numeric[2]);
      const holds =
        numeric[1] === "<" ? actual < bound
        : numeric[1] === ">" ? actual > bound
        : numeric[1] === "<=" ? actual <= bound
        : numeric[1] === ">=" ? actual >= bound
        : actual === bound;
      if (!holds) return false;
      continue;
    }

    throw new Error(
      `unmodelled re-seed guard "${condition}" — teach guardHolds() what it means, ` +
        `rather than letting the seed assertions run against a value no fresh database has`,
    );
  }

  return true;
}

/**
 * Apply an `UPDATE admin_config SET … WHERE key = '…'` re-seed over the parsed
 * inserts, producing the seed a FRESH database actually ends up with.
 *
 * Only `value` and `min_value` are tracked — those are the two this file asserts
 * on, and a re-seed touching anything else would not change what "the effective
 * seed" means for these cases.
 */
function applyReseeds(rows: Map<string, SeededRow>, sql: string): void {
  const stmtPattern = /UPDATE\s+admin_config\s+SET\s+([\s\S]*?)WHERE\s+key\s*=\s*'([a-z_]+)'([\s\S]*?);/gi;

  for (const stmt of sql.matchAll(stmtPattern)) {
    const [, assignments, key, where] = stmt;
    const row = rows.get(key);
    if (!row) continue;
    if (!guardHolds(where ?? "", row)) continue;

    const minValue = assignments.match(/min_value\s*=\s*(-?\d+)/i);
    if (minValue) row.minValue = Number(minValue[1]);

    // Anchored to a `SET value =` assignment, so `min_value = …` cannot match
    // as though it set the value.
    const value = assignments.match(/(?:^|,)\s*value\s*=\s*'([^']*)'/i);
    if (value) row.value = value[1];
  }
}

const seeds = new Map(parseSeeds(fs.readFileSync(MIGRATION, "utf8")).map((r) => [r.key, r]));
for (const file of RESEED_MIGRATIONS) {
  applyReseeds(seeds, fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
}

describe("membership admin_config seeds", () => {
  it("parsed the migration at all — a zero-row parse would make every other case vacuous", () => {
    assert.ok(seeds.size >= KEYS.length, `parsed ${seeds.size} seeded rows`);
  });

  it("seeds a row for every key the model introduces", () => {
    // Naming a key does not create it: `getAllConfig` returns only STORED rows
    // and PATCH 404s when the row is absent, so a key that exists only as a code
    // fallback is invisible in the admin list and un-editable without a deploy.
    const missing = KEYS.filter((key) => !seeds.has(key));
    assert.deepEqual(missing, []);
  });

  it("seeds each key at its code default, so the two cannot disagree on day one", () => {
    for (const key of KEYS) {
      assert.equal(Number(seeds.get(key)!.value), MEMBERSHIP_CONFIG_DEFAULTS[key], key);
    }
  });

  it("declares every key integer or float — the only two discriminators PATCH range-checks", () => {
    // A row seeded as `numeric` matches neither branch of the route's
    // validation, so it would take no numeric parsing and no min/max check at
    // all, and arbitrary text would be accepted.
    for (const key of KEYS) {
      const dataType = seeds.get(key)!.dataType;
      assert.ok(
        dataType === "integer" || dataType === "float",
        `${key} is declared "${dataType}", which PATCH does not range-check`,
      );
    }
  });

  it("declares the fraction as float, not integer", () => {
    assert.equal(seeds.get("reconcile_max_downgrade_fraction")!.dataType, "float");
  });

  it("gives every key a min and a max, so the route has something to enforce", () => {
    for (const key of KEYS) {
      const row = seeds.get(key)!;
      assert.notEqual(row.minValue, null, `${key} has no min_value`);
      assert.notEqual(row.maxValue, null, `${key} has no max_value`);
    }
  });

  it("keeps every seeded default inside its own seeded range", () => {
    for (const key of KEYS) {
      const row = seeds.get(key)!;
      const value = MEMBERSHIP_CONFIG_DEFAULTS[key];
      assert.ok(value >= row.minValue!, `${key} default ${value} is below its min ${row.minValue}`);
      assert.ok(value <= row.maxValue!, `${key} default ${value} is above its max ${row.maxValue}`);
    }
  });

  it("keeps every key private — none of this is public config", () => {
    for (const key of KEYS) {
      assert.equal(seeds.get(key)!.isPublic, false, `${key} must not be exposed by GET /api/config`);
    }
  });

  it("keeps lease_ttl_seconds's seeded floor equal to the derived budget minimum", () => {
    assert.equal(
      seeds.get("lease_ttl_seconds")!.minValue,
      minimumLeaseTtlSeconds(),
      "the migration's literal min_value has drifted from the constants it was derived from — " +
        "re-seed it, or the admin UI will accept a lease shorter than the Stripe request it must outlive",
    );
  });

  it("keeps the run-lease floor at three heartbeat intervals of the seeded heartbeat", () => {
    assert.equal(
      seeds.get("reconcile_run_lease_ttl_seconds")!.minValue,
      minimumRunLeaseTtlSeconds(MEMBERSHIP_CONFIG_DEFAULTS.reconcile_heartbeat_interval_seconds),
    );
  });
});
