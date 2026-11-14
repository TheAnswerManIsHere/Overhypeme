/**
 * The dedicated visual-planner engine, chosen and configured in code
 * (docs/plans/PLAN_AI_SETTINGS_IN_CODE.md):
 *   - the openai-visual-planner catalogue definition;
 *   - resolveImagePromptLLMSettings() takes the code's settings and provenance
 *     even when a stale `fact_image_prompt_engine_id` key disagrees;
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
  getImagePromptEngineId,
  DEFAULT_IMAGE_PROMPT_ENGINE_ID,
  IMAGE_PROMPT_CONFIG_KEYS,
} from "../lib/imagePromptConfig";
import {
  resolveImagePromptLLMSettings,
  IMAGE_PROMPT_TEMPERATURE,
  IMAGE_PROMPT_MAX_TOKENS,
  IMAGE_PROMPT_LLM_TIMEOUT_MS,
} from "../lib/imagePrompt/generator";

const ENGINE_ID = DEFAULT_IMAGE_PROMPT_ENGINE_ID;
const KEY = IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId;

describe("openai-visual-planner catalogue definition", () => {
  it("exists with the agreed defaults and is an LLM engine on OpenAI", () => {
    const def = ALL_ENGINES.find((e) => e.id === "openai-visual-planner");
    assert.ok(def, "openai-visual-planner must be in ALL_ENGINES");
    assert.equal(def!.kind, "llm");
    assert.equal(def!.provider, "openai");
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "high");
    assert.equal(def!.defaultMaxTokens, 2800);
  });
});

describe("resolveImagePromptLLMSettings", () => {
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

  it("takes the code's settings and provenance even when the retired key disagrees", async () => {
    await db.insert(adminConfigTable).values({ key: KEY, value: "custom-engine", dataType: "string", label: "stale" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "custom-engine" } });
    bustConfigCache();

    assert.equal(await getImagePromptEngineId(), ENGINE_ID);
    const def = ALL_ENGINES.find((e) => e.id === ENGINE_ID)!;
    const s = await resolveImagePromptLLMSettings();
    assert.equal(s.model, def.endpointId);
    assert.equal(s.maxTokens, def.defaultMaxTokens);
    assert.equal(s.reasoningEffort, def.defaultReasoningEffort);
    assert.equal(s.timeoutMs, IMAGE_PROMPT_LLM_TIMEOUT_MS);
    assert.deepEqual(s.plannerProvenance, {
      configuredEngineId: ENGINE_ID,
      resolvedEngineId: ENGINE_ID,
      model: def.endpointId,
      reasoningEffort: def.defaultReasoningEffort,
      timeoutMs: IMAGE_PROMPT_LLM_TIMEOUT_MS,
      fallbackReason: null,
    });
  });

  it("falls back, with its reason, when the engine is switched off", async () => {
    // Engines live only in code: flip the catalogue definition itself and restore it.
    const def = ALL_ENGINES.find((e) => e.id === ENGINE_ID)!;
    const original = def.isActive;
    def.isActive = false;
    try {
      const s = await resolveImagePromptLLMSettings();
      assert.equal(s.model, undefined);
      assert.equal(s.temperature, IMAGE_PROMPT_TEMPERATURE);
      assert.equal(s.maxTokens, IMAGE_PROMPT_MAX_TOKENS);
      assert.equal(s.timeoutMs, undefined);
      assert.equal(s.plannerProvenance.fallbackReason, "engine_inactive");
      assert.equal(s.plannerProvenance.configuredEngineId, ENGINE_ID);
      assert.equal(s.plannerProvenance.resolvedEngineId, null);
    } finally {
      def.isActive = original;
    }
  });
});
