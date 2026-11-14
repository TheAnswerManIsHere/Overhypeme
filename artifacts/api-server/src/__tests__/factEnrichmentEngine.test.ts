/**
 * The dedicated fact-enrichment engine, chosen and configured in code
 * (docs/plans/PLAN_AI_SETTINGS_IN_CODE.md):
 *   - the openai-enricher catalogue definition;
 *   - resolveFactEnrichmentLLMSettings() takes the code's settings even when the
 *     engine row and the retired `fact_enrichment_engine_id` key disagree;
 *   - a switched-off or archived row still falls back, with its reason.
 *
 * Touches the real test DB (engines + admin_config); restores what it changes.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { adminConfigTable, enginesTable, type Engine } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { ALL_ENGINES, reconcileEngines } from "../lib/engines";
import { clearEngineCaches } from "../lib/engineInterpreter";
import { bustConfigCache } from "../lib/adminConfig";
import {
  getFactEnrichmentEngineId,
  DEFAULT_FACT_ENRICHMENT_ENGINE_ID,
  FACT_ENRICHMENT_CONFIG_KEYS,
  FACT_ENRICHMENT_TEMPERATURE,
  FACT_ENRICHMENT_MAX_TOKENS,
} from "../lib/factEnrichmentConfig";
import {
  resolveFactEnrichmentLLMSettings,
  FACT_ENRICHMENT_LLM_TIMEOUT_MS,
} from "../lib/factEnrichment";

const ENGINE_ID = DEFAULT_FACT_ENRICHMENT_ENGINE_ID;
const KEY = FACT_ENRICHMENT_CONFIG_KEYS.engineId;

describe("openai-enricher catalogue definition", () => {
  it("exists with the agreed defaults and is an LLM engine on OpenAI", () => {
    const def = ALL_ENGINES.find((e) => e.id === "openai-enricher");
    assert.ok(def, "openai-enricher must be in ALL_ENGINES");
    assert.equal(def!.kind, "llm");
    assert.equal(def!.provider, "openai");
    assert.equal(def!.isDefault, false);
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "high");
    assert.equal(def!.defaultMaxTokens, 600);
  });
});

describe("resolveFactEnrichmentLLMSettings", () => {
  let savedRow: Engine | undefined;
  let savedKey: typeof adminConfigTable.$inferSelect | undefined;

  before(async () => {
    await reconcileEngines();
    [savedRow] = await db.select().from(enginesTable).where(eq(enginesTable.id, ENGINE_ID));
    [savedKey] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  });

  after(async () => {
    if (savedRow) await db.update(enginesTable).set(savedRow).where(eq(enginesTable.id, ENGINE_ID));
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, KEY));
    if (savedKey) await db.insert(adminConfigTable).values(savedKey);
    bustConfigCache();
    clearEngineCaches();
  });

  beforeEach(async () => {
    if (savedRow) await db.update(enginesTable).set(savedRow).where(eq(enginesTable.id, ENGINE_ID));
    bustConfigCache();
    clearEngineCaches();
  });

  it("takes the code's settings even when the row and the retired key disagree", async () => {
    await db.update(enginesTable).set({
      endpointId: "gpt-4o-mini",
      defaultReasoningEffort: "low",
      defaultMaxTokens: 50,
      defaultTemperature: "1.50",
      provider: "fal",
      kind: "image",
    }).where(eq(enginesTable.id, ENGINE_ID));
    await db.insert(adminConfigTable).values({ key: KEY, value: "openai-general", dataType: "string", label: "stale" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "openai-general" } });
    bustConfigCache();
    clearEngineCaches();

    assert.equal(await getFactEnrichmentEngineId(), ENGINE_ID);
    const def = ALL_ENGINES.find((e) => e.id === ENGINE_ID)!;
    const s = await resolveFactEnrichmentLLMSettings();
    assert.equal(s.model, def.endpointId);
    assert.equal(s.maxTokens, def.defaultMaxTokens);
    assert.equal(s.reasoningEffort, def.defaultReasoningEffort);
    assert.equal(s.timeoutMs, FACT_ENRICHMENT_LLM_TIMEOUT_MS);
    assert.equal(s.resolvedEngineId, ENGINE_ID);
    assert.equal(s.fallbackReason, null);
  });

  it("falls back, with its reason, when the stored row is switched off or archived", async () => {
    const cases: Array<{ label: string; set: Partial<Engine>; reason: string }> = [
      { label: "inactive", set: { isActive: false }, reason: "engine_inactive" },
      { label: "soft-deleted", set: { deletedAt: new Date(0) }, reason: "engine_deleted" },
    ];
    for (const c of cases) {
      if (savedRow) await db.update(enginesTable).set(savedRow).where(eq(enginesTable.id, ENGINE_ID));
      await db.update(enginesTable).set(c.set).where(eq(enginesTable.id, ENGINE_ID));
      clearEngineCaches();
      const s = await resolveFactEnrichmentLLMSettings();
      assert.equal(s.model, undefined, `${c.label}: no model override on fallback`);
      assert.equal(s.temperature, FACT_ENRICHMENT_TEMPERATURE, `${c.label}: temp`);
      assert.equal(s.maxTokens, FACT_ENRICHMENT_MAX_TOKENS, `${c.label}: maxTokens`);
      assert.equal(s.resolvedEngineId, null, `${c.label}: no resolved engine`);
      assert.equal(s.fallbackReason, c.reason, `${c.label}: reason`);
    }
  });
});
