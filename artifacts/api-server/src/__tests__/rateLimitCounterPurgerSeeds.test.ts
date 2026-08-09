/**
 * The `admin_config` rows `seed.ts`'s `ensureSchema()` seeds for the
 * rate_limit_counters purger's two tunables.
 *
 * Asserted against the SOURCE FILE, not against a database — same reason as
 * `membershipConfigSeeds.test.ts`: the sharded test runner clones its
 * databases with `pg_dump --schema-only`, so `ensureSchema()`'s DML never
 * runs against them, and a test that read the rows back would pass or fail
 * on which harness ran it.
 *
 * The load-bearing case here is the bounds check: `MIN_BATCH_SIZE` /
 * `MAX_BATCH_SIZE` / `MIN_MAX_BATCHES` / `MAX_MAX_BATCHES` live in
 * `rateLimitCounterPurger.ts` as the values the code actually clamps to;
 * `min_value`/`max_value` in the seed are separate literals in SQL. Bumping
 * one without the other would leave the admin-config UI enforcing a range
 * PATCH accepts but the job silently re-clamps — the "operator-tunable"
 * promise breaking quietly rather than loudly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_BATCHES,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_MAX_BATCHES,
  MAX_MAX_BATCHES,
} from "../jobs/rateLimitCounterPurger.js";

const SEED_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/seed.ts");

interface SeededRow {
  value: number;
  dataType: string;
  minValue: number | null;
  maxValue: number | null;
  isPublic: boolean;
}

/** Parses one `INSERT INTO admin_config (...) VALUES (...)` DML string for a single key. */
function parseSeed(source: string, key: string): SeededRow | undefined {
  const pattern = new RegExp(
    `VALUES\\s*\\(\\s*'${key}',\\s*'([^']*)',\\s*'(integer|float|numeric|string)',` +
      `\\s*'(?:[^']|'')*',\\s*'(?:[^']|'')*',\\s*(-?\\d+|NULL),\\s*(-?\\d+|NULL),\\s*(true|false)\\s*\\)`,
  );
  const match = pattern.exec(source);
  if (!match) return undefined;
  return {
    value: Number(match[1]),
    dataType: match[2],
    minValue: match[3] === "NULL" ? null : Number(match[3]),
    maxValue: match[4] === "NULL" ? null : Number(match[4]),
    isPublic: match[5] === "true",
  };
}

const source = fs.readFileSync(SEED_FILE, "utf8");
const batchSizeSeed = parseSeed(source, "rate_limit_counters\\.purge_batch_size");
const maxBatchesSeed = parseSeed(source, "rate_limit_counters\\.purge_max_batches");

describe("rate_limit_counters purge admin_config seeds", () => {
  it("seeds a row for both tunables — a key that exists only as a code fallback is un-editable via PATCH (404)", () => {
    assert.ok(batchSizeSeed, "rate_limit_counters.purge_batch_size not found in seed.ts");
    assert.ok(maxBatchesSeed, "rate_limit_counters.purge_max_batches not found in seed.ts");
  });

  it("seeds each key at its code default, so the two cannot disagree on day one", () => {
    assert.equal(batchSizeSeed!.value, DEFAULT_BATCH_SIZE);
    assert.equal(maxBatchesSeed!.value, DEFAULT_MAX_BATCHES);
  });

  it("declares both keys integer — the only PATCH branch these values parse under", () => {
    assert.equal(batchSizeSeed!.dataType, "integer");
    assert.equal(maxBatchesSeed!.dataType, "integer");
  });

  it("agrees with the job's own clamp bounds, so PATCH and the code enforce the same range", () => {
    assert.equal(batchSizeSeed!.minValue, MIN_BATCH_SIZE);
    assert.equal(batchSizeSeed!.maxValue, MAX_BATCH_SIZE);
    assert.equal(maxBatchesSeed!.minValue, MIN_MAX_BATCHES);
    assert.equal(maxBatchesSeed!.maxValue, MAX_MAX_BATCHES);
  });

  it("keeps both keys internal — not the kind of value GET /api/config should expose publicly", () => {
    assert.equal(batchSizeSeed!.isPublic, false);
    assert.equal(maxBatchesSeed!.isPublic, false);
  });
});
