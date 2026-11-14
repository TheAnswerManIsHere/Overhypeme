/**
 * The dedicated visual-planner engine, chosen and configured in code
 * (docs/plans/PLAN_AI_SETTINGS_IN_CODE.md):
 *   - the openai-visual-planner catalogue definition;
 *   - resolveImagePromptLLMSettings() takes the code's settings and provenance
 *     even when the engine row and the retired `fact_image_prompt_engine_id`
 *     key disagree;
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
  it("exists with the agreed defaults and is not kind-default eligible", () => {
    const def = ALL_ENGINES.find((e) => e.id === "openai-visual-planner");
    assert.ok(def, "openai-visual-planner must be in ALL_ENGINES");
    assert.equal(def!.kind, "llm");
    assert.equal(def!.provider, "openai");
    assert.equal(def!.isDefault, false);
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "high");
    assert.equal(def!.defaultMaxTokens, 2800);
    assert.equal(def!.eligibleAsKindDefault, false);
  });
});

describe("resolveImagePromptLLMSettings", () => {
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

  it("takes the code's settings and provenance even when the row and the retired key disagree", async () => {
    await db.update(enginesTable).set({
      endpointId: "",
      defaultReasoningEffort: "xhigh",
      defaultMaxTokens: 77,
      defaultTemperature: "1.10",
      provider: "fal",
      kind: "utility",
    }).where(eq(enginesTable.id, ENGINE_ID));
    await db.insert(adminConfigTable).values({ key: KEY, value: "custom-engine", dataType: "string", label: "stale" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "custom-engine" } });
    bustConfigCache();
    clearEngineCaches();

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

  it("falls back, with its reason, when the stored row is switched off or archived", async () => {
    const cases: Array<{ label: string; set: Partial<Engine>; reason: string }> = [
      { label: "inactive", set: { isActive: false }, reason: "engine_inactive" },
      { label: "soft-deleted", set: { deletedAt: new Date() }, reason: "engine_deleted" },
    ];
    for (const c of cases) {
      if (savedRow) await db.update(enginesTable).set(savedRow).where(eq(enginesTable.id, ENGINE_ID));
      await db.update(enginesTable).set(c.set).where(eq(enginesTable.id, ENGINE_ID));
      clearEngineCaches();
      const s = await resolveImagePromptLLMSettings();
      assert.equal(s.model, undefined, c.label);
      assert.equal(s.temperature, IMAGE_PROMPT_TEMPERATURE, c.label);
      assert.equal(s.maxTokens, IMAGE_PROMPT_MAX_TOKENS, c.label);
      assert.equal(s.timeoutMs, undefined, c.label);
      assert.equal(s.plannerProvenance.fallbackReason, c.reason, c.label);
      assert.equal(s.plannerProvenance.configuredEngineId, ENGINE_ID, c.label);
      assert.equal(s.plannerProvenance.resolvedEngineId, null, c.label);
    }
  });
});
