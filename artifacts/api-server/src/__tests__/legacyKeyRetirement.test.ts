/**
 * Phase 6 retirement of the legacy ad-hoc per-model admin_config keys.
 *
 * This test file pins the contract:
 *   1. The 0060_retire_legacy_model_config_keys.sql migration deletes EXACTLY
 *      the set of keys the retirement spec covers (no more, no fewer).
 *   2. After applying the migration to a DB that previously held those rows,
 *      subsequent reads return the caller-supplied default.
 *
 * Tests rely on `@workspace/db`'s shared connection (same convention as
 * budgetGate.test.ts, etc.). When DATABASE_URL is unset the DB-touching test
 * is skipped so the static-analysis assertion still runs in offline CI.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../lib/db/migrations/0060_retire_legacy_model_config_keys.sql",
);

// The canonical retired key list. Keep in lockstep with the SQL DELETE.
const RETIRED_KEYS = [
  // Image generation
  "ai_image_model_standard",
  "ai_image_model_reference",
  "ai_image_size",
  "ai_std_num_inference_steps",
  "ai_std_guidance_scale",
  "ai_std_safety_tolerance",
  "ai_std_seed",
  "ai_std_output_format",
  "ai_std_aspect_ratio",
  "ai_std_ultra_raw",
  "ai_ref_pulid_id_scale",
  "ai_ref_pulid_guidance_scale",
  "ai_ref_pulid_num_inference_steps",
  "ai_ref_pulid_true_cfg_scale",
  "ai_ref_pulid_start_step",
  "ai_pulid_composition_suffix",
  "ai_pulid_id_scale_pct",
  "ai_scene_prompt_model",
  "ai_scene_prompt_max_tokens",
  "ai_scene_prompt_temperature",
  "ai_scene_prompt_system",
  // Video generation
  "video_model",
  "video_duration",
  "video_aspect_ratio",
  "video_resolution",
  "video_prompt_system_prompt",
] as const;

describe("legacy admin_config key retirement (migration 0060)", () => {
  it("migration file exists and is pure DML", () => {
    assert.ok(
      fs.existsSync(MIGRATION_PATH),
      `expected migration at ${MIGRATION_PATH}`,
    );
    const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
    // DML-only — must not touch the schema.
    assert.match(sql, /DELETE FROM admin_config/i);
    assert.doesNotMatch(sql, /\bCREATE\s+(TABLE|INDEX|TYPE)\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|INDEX|TYPE)\b/i);
  });

  it("DELETE statement targets exactly the retired key set", () => {
    const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
    // Capture every single-quoted identifier inside the DELETE IN(...) list.
    // We look at the slice from "DELETE FROM admin_config" forward.
    const tail = sql.slice(sql.toUpperCase().indexOf("DELETE FROM ADMIN_CONFIG"));
    const matches = tail.match(/'([a-z0-9_]+)'/g) ?? [];
    const keysInSql = matches.map((m) => m.slice(1, -1)).sort();
    const expected = [...RETIRED_KEYS].sort();
    assert.deepEqual(
      keysInSql,
      expected,
      "DELETE list drifted from the canonical RETIRED_KEYS array",
    );
  });

  it("journal lists 0060 and check-snapshots marks it exempt", () => {
    const journalPath = path.resolve(
      __dirname,
      "../../../../lib/db/migrations/meta/_journal.json",
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string }>;
    };
    assert.ok(
      journal.entries.some((e) => e.tag === "0060_retire_legacy_model_config_keys"),
      "journal does not include the 0060 migration",
    );
    const checkScript = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../../lib/db/scripts/check-migration-snapshots.ts",
      ),
      "utf-8",
    );
    assert.match(
      checkScript,
      /"0060_retire_legacy_model_config_keys"/,
      "0060 must be in SNAPSHOT_EXEMPT_TAGS (DML-only)",
    );
  });

  describe("DB behaviour (skipped when DATABASE_URL is unset)", () => {
    let dbAvailable = false;
    let db: typeof import("@workspace/db")["db"] | null = null;
    let adminConfigTable: typeof import("@workspace/db/schema")["adminConfigTable"] | null = null;
    let bustConfigCache: (() => void) | null = null;
    let getConfigString: ((k: string, d: string) => Promise<string>) | null = null;

    before(async () => {
      if (!process.env.DATABASE_URL) return;
      try {
        const dbMod = await import("@workspace/db");
        const schemaMod = await import("@workspace/db/schema");
        const adminCfgMod = await import("../lib/adminConfig.js");
        db = dbMod.db;
        adminConfigTable = schemaMod.adminConfigTable;
        bustConfigCache = adminCfgMod.bustConfigCache;
        getConfigString = adminCfgMod.getConfigString;
        dbAvailable = true;
      } catch {
        dbAvailable = false;
      }
    });

    it("retired keys are absent from admin_config", async (t) => {
      if (!dbAvailable || !db || !adminConfigTable) {
        t.skip("DATABASE_URL not set — skipping live DB assertion");
        return;
      }
      const { inArray } = await import("drizzle-orm");
      const rows = await db
        .select({ key: adminConfigTable.key })
        .from(adminConfigTable)
        .where(inArray(adminConfigTable.key, [...RETIRED_KEYS]));
      assert.deepEqual(
        rows.map((r) => r.key),
        [],
        "expected zero admin_config rows for retired keys after migration 0060",
      );
    });

    it("getConfigString falls back to caller default for every retired key", async (t) => {
      if (!dbAvailable || !bustConfigCache || !getConfigString) {
        t.skip("DATABASE_URL not set — skipping live DB assertion");
        return;
      }
      bustConfigCache();
      for (const key of RETIRED_KEYS) {
        const sentinel = `__sentinel_${key}__`;
        const got = await getConfigString(key, sentinel);
        assert.equal(
          got,
          sentinel,
          `expected getConfigString("${key}", "${sentinel}") to return the default; got "${got}"`,
        );
      }
    });

    after(() => {
      // Nothing to clean — the migration is part of the regular migrate chain
      // and this test only reads.
    });
  });
});
