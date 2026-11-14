/**
 * The dedicated fact-enrichment engine, chosen and configured in code
 * (docs/plans/PLAN_AI_SETTINGS_IN_CODE.md):
 *   - the openai-enricher catalogue definition;
 *   - resolveFactEnrichmentLLMSettings() takes the code's settings even when a
 *     stale `fact_enrichment_engine_id` key disagrees;
 *   - a switched-off engine still falls back, with its reason.
 *
 * Touches the real test DB (admin_config); restores what it changes.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { ALL_ENGINES } from "../lib/engines";
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
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "high");
    assert.equal(def!.defaultMaxTokens, 600);
  });
});

describe("resolveFactEnrichmentLLMSettings", () => {
  let savedKey: typeof adminConfigTable.$inferSelect | undefined;

  before(async () => {
    [savedKey] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  });

  after(async () => {
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, KEY));
    if (savedKey) await db.insert(adminConfigTable).values(savedKey);
    bustConfigCache();
  });

  beforeEach(() => {
    bustConfigCache();
  });

  it("takes the code's settings even when the retired key disagrees", async () => {
    await db.insert(adminConfigTable).values({ key: KEY, value: "openai-general", dataType: "string", label: "stale" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "openai-general" } });
    bustConfigCache();

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

  it("falls back, with its reason, when the engine is switched off", async () => {
    // Engines live only in code: flip the catalogue definition itself and restore it.
    const def = ALL_ENGINES.find((e) => e.id === ENGINE_ID)!;
    const original = def.isActive;
    def.isActive = false;
    try {
      const s = await resolveFactEnrichmentLLMSettings();
      assert.equal(s.model, undefined, "no model override on fallback");
      assert.equal(s.temperature, FACT_ENRICHMENT_TEMPERATURE, "temp");
      assert.equal(s.maxTokens, FACT_ENRICHMENT_MAX_TOKENS, "maxTokens");
      assert.equal(s.resolvedEngineId, null, "no resolved engine");
      assert.equal(s.fallbackReason, "engine_inactive", "reason");
    } finally {
      def.isActive = original;
    }
  });
});
