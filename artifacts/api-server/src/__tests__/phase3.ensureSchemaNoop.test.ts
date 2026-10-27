/**
 * Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §1): on a database the migration runner built from the schema baseline, the
 * boot-time ensureSchema() changes no structure. It still runs every boot (its
 * config INSERTs are classified in increment 3); this pins that its DDL — which
 * catches its own errors and continues — has nothing left to do, so the baseline
 * and the migrations stay the one source of a fresh database's schema.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pool } from "@workspace/db";
import { catalogFingerprint, fingerprintDiff } from "@workspace/db/baseline";

import { ensureSchema } from "../lib/seed.js";

describe("ensureSchema() on a baseline-built database", () => {
  it("changes no table, column, constraint, index, function, trigger, type or sequence", async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
      const schema = rows[0].schema;
      const before = await catalogFingerprint(client, schema);
      await ensureSchema();
      const after = await catalogFingerprint(client, schema);
      assert.deepEqual(fingerprintDiff(before, after), { onlyA: [], onlyB: [] });
    } finally {
      client.release();
    }
  });
});
