/**
 * The gag writer's settled pieces (plan docs/plans/PLAN_GAG_GENERATOR.md):
 * the system prompt is the text David locked, byte for byte, and migration
 * 0137 points the gag generator at GPT-6 Astra from any previous setting
 * while leaving the render planner alone. Since 2026-11-14 the engine and its
 * settings are set in code, so the generation resolves to Astra at medium
 * effort whatever the setting or the row says.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sql, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { adminConfigTable, enginesTable } from "@workspace/db/schema";
import { FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT } from "../lib/visualConceptsConfig.js";
import { resolveVisualConceptsLLMSettings } from "../lib/visualConcepts/generator.js";
import { reconcileEngines } from "../lib/engines/reconcile.js";
import { clearEngineCaches, loadEngine } from "../lib/engineInterpreter.js";
import { bustConfigCache } from "../lib/adminConfig.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const LOCKED_SHA256 = "838fce3ae26e9ed0b09bdd581f09fb814f4d111b246c279fabd23c35921bff6f";
const KEY = "fact_visual_concepts_engine_id";
const BEFORE = "fact_visual_concepts_engine_id_before_0137";

describe("the gag writer's system prompt", () => {
  it("is the locked text, byte for byte", () => {
    assert.equal(createHash("sha256").update(FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT).digest("hex"), LOCKED_SHA256);
    assert.equal(FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT, readFileSync(resolve(repo, "docs/plans/gag-prompt-LOCKED.md"), "utf8"));
  });
});

describe("migration 0137 points the gag generator at GPT-6 Astra", () => {
  const migration = readFileSync(resolve(repo, "lib/db/migrations/0137_gag_writer.sql"), "utf8");
  const repoint = migration.slice(migration.indexOf("DO $$"));
  let original: string | undefined;
  let originalEffort: string | null | undefined;

  after(async () => {
    if (originalEffort !== undefined) await db.update(enginesTable).set({ defaultReasoningEffort: originalEffort }).where(eq(enginesTable.id, "openai-gag-writer"));
    clearEngineCaches();
    if (original !== undefined) await db.update(adminConfigTable).set({ value: original }).where(eq(adminConfigTable.key, KEY));
    else await db.update(adminConfigTable).set({ value: "openai-gag-writer" }).where(eq(adminConfigTable.key, KEY));
    bustConfigCache();
  });

  for (const previous of ["openai-visual-planner", "some-custom-engine"]) {
    it(`from ${previous}: the setting moves, the old value is kept, and generation resolves to gpt-6-astra`, async () => {
      await reconcileEngines();
      // A stale stored effort is not read.
      if (originalEffort === undefined) originalEffort = (await db.select({ e: enginesTable.defaultReasoningEffort }).from(enginesTable).where(eq(enginesTable.id, "openai-gag-writer")))[0]?.e ?? null;
      await db.update(enginesTable).set({ defaultReasoningEffort: "high" }).where(eq(enginesTable.id, "openai-gag-writer"));
      clearEngineCaches();
      const [row] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
      original ??= row?.value;
      await db.execute(sql`DELETE FROM admin_config WHERE key = ${BEFORE}`);
      // Upsert: another test in the same database may have cleared admin_config.
      await db.execute(sql`INSERT INTO admin_config (key, value, data_type, label, description, is_public) VALUES (${KEY}, ${previous}, 'string', 'Visual Concepts — Engine', 'x', false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      await db.execute(sql.raw(repoint));
      const rows = await db.select().from(adminConfigTable).where(sql`key in (${KEY}, ${BEFORE})`);
      const by = new Map(rows.map((r) => [r.key, r.value]));
      assert.equal(by.get(KEY), "openai-gag-writer");
      assert.equal(by.get(BEFORE), previous);
      await db.execute(sql.raw(repoint));
      assert.equal((await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, BEFORE)))[0]?.value, previous, "a second run keeps the recorded value");
      bustConfigCache();
      const settings = await resolveVisualConceptsLLMSettings();
      assert.equal(settings.unusableReason, null);
      assert.equal(settings.model, "gpt-6-astra");
      // The effort is the code's (decisions.md 2026-11-14), whatever the row stores.
      assert.equal(settings.reasoningEffort, "medium");
      const planner = await loadEngine("openai-visual-planner");
      assert.equal(planner?.endpointId, "gpt-5.5", "the render planner's engine is unchanged");
    });
  }
});
