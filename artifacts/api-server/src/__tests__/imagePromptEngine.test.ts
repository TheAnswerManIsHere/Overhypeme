/**
 * Tests for the dedicated visual-planner engine route (slice 1):
 *   - the openai-visual-planner catalogue definition
 *   - resolveImagePromptLLMSettings(): engine settings + provenance when the
 *     configured row is valid, fallback provenance (with a reason) for every
 *     invalid state — missing id, inactive, soft-deleted, wrong kind, wrong
 *     provider, missing endpointId
 *   - fact_image_prompt_engine_id seeding
 *
 * Touches the real test DB (engines + admin_config).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { enginesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { eq, like, inArray } from "drizzle-orm";

import { ALL_ENGINES } from "../lib/engines";
import { clearEngineCaches } from "../lib/engineInterpreter";
import { bustConfigCache } from "../lib/adminConfig";
import {
  seedImagePromptConfig,
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

const ENGINE_PREFIX = "t-ipe-";
const insertedEngineIds: string[] = [];

async function seedLLMEngine(opts: {
  provider?: string;
  kind?: "image" | "video" | "utility" | "llm";
  endpointId?: string;
  isActive?: boolean;
  deletedAt?: Date | null;
  defaultMaxTokens?: number | null;
  defaultReasoningEffort?: string | null;
  defaultTemperature?: string | null;
} = {}): Promise<string> {
  const id = `${ENGINE_PREFIX}${randomUUID().slice(0, 12)}`;
  await db.insert(enginesTable).values({
    id,
    provider: opts.provider ?? "openai",
    endpointId: opts.endpointId ?? "gpt-5.5",
    label: `Test planner engine ${id}`,
    description: "Synthetic test engine — created by imagePromptEngine.test.ts.",
    kind: opts.kind ?? "llm",
    tierRequirement: "legendary",
    isDefault: false,
    isActive: opts.isActive ?? true,
    sortOrder: 999,
    supportedModes: [],
    audioHandling: "none",
    paramSchema: { params: [] },
    expectedRunMs: 1000,
    deletedAt: opts.deletedAt ?? null,
    defaultMaxTokens: opts.defaultMaxTokens === undefined ? 2800 : opts.defaultMaxTokens,
    defaultReasoningEffort: opts.defaultReasoningEffort === undefined ? "xhigh" : opts.defaultReasoningEffort,
    defaultTemperature: opts.defaultTemperature === undefined ? "0.40" : opts.defaultTemperature,
  });
  insertedEngineIds.push(id);
  clearEngineCaches();
  return id;
}

async function setConfiguredEngineId(value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO admin_config (key, value, data_type, label, description, is_public)
    VALUES (${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}, ${value}, 'string', 'test', 'test', false)
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `);
  bustConfigCache();
  clearEngineCaches();
}

describe("openai-visual-planner catalogue definition", () => {
  it("exists with the agreed defaults and is not kind-default eligible", () => {
    const def = ALL_ENGINES.find((e) => e.id === "openai-visual-planner");
    assert.ok(def, "openai-visual-planner must be in ALL_ENGINES");
    assert.equal(def!.kind, "llm");
    assert.equal(def!.provider, "openai");
    assert.equal(def!.isDefault, false);
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "xhigh");
    assert.equal(def!.defaultMaxTokens, 2800);
    assert.equal(def!.eligibleAsKindDefault, false);
  });
});

describe("resolveImagePromptLLMSettings", () => {
  let originalConfigValue: string | null = null;

  before(async () => {
    const r = await db.execute(sql`
      SELECT value FROM admin_config WHERE key = ${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}
    `);
    const rows = (r.rows ?? []) as Array<{ value: string }>;
    originalConfigValue = rows[0]?.value ?? null;
  });

  after(async () => {
    if (originalConfigValue == null) {
      await db.execute(sql`DELETE FROM admin_config WHERE key = ${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}`);
    } else {
      await setConfiguredEngineId(originalConfigValue);
    }
    if (insertedEngineIds.length > 0) {
      await db.delete(enginesTable).where(inArray(enginesTable.id, insertedEngineIds));
      insertedEngineIds.length = 0;
    }
    await db.delete(enginesTable).where(like(enginesTable.id, `${ENGINE_PREFIX}%`));
    bustConfigCache();
    clearEngineCaches();
  });

  beforeEach(() => {
    bustConfigCache();
    clearEngineCaches();
  });

  it("returns the engine's settings + provenance for a valid active row", async () => {
    const id = await seedLLMEngine();
    await setConfiguredEngineId(id);
    const s = await resolveImagePromptLLMSettings();
    assert.equal(s.model, "gpt-5.5");
    assert.equal(s.maxTokens, 2800);
    assert.equal(s.reasoningEffort, "xhigh");
    assert.equal(s.temperature, 0.4);
    assert.equal(s.timeoutMs, IMAGE_PROMPT_LLM_TIMEOUT_MS);
    assert.deepEqual(s.plannerProvenance, {
      configuredEngineId: id,
      resolvedEngineId: id,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      timeoutMs: IMAGE_PROMPT_LLM_TIMEOUT_MS,
      fallbackReason: null,
    });
  });

  it("falls back to the engine-less defaults with a reason for every invalid state", async () => {
    const cases: Array<{ label: string; engineId: () => Promise<string> | string; reason: string }> = [
      { label: "missing id", engineId: () => `${ENGINE_PREFIX}nope-${randomUUID().slice(0, 8)}`, reason: "engine_not_found" },
      { label: "inactive", engineId: () => seedLLMEngine({ isActive: false }), reason: "engine_inactive" },
      { label: "soft-deleted", engineId: () => seedLLMEngine({ deletedAt: new Date() }), reason: "engine_deleted" },
      { label: "wrong kind", engineId: () => seedLLMEngine({ kind: "utility" }), reason: "engine_not_llm" },
      { label: "wrong provider", engineId: () => seedLLMEngine({ provider: "fal" }), reason: "engine_not_openai" },
      { label: "missing endpointId", engineId: () => seedLLMEngine({ endpointId: "" }), reason: "engine_missing_model" },
    ];
    for (const c of cases) {
      const id = await c.engineId();
      await setConfiguredEngineId(id);
      const s = await resolveImagePromptLLMSettings();
      assert.equal(s.model, undefined, c.label);
      assert.equal(s.temperature, IMAGE_PROMPT_TEMPERATURE, c.label);
      assert.equal(s.maxTokens, IMAGE_PROMPT_MAX_TOKENS, c.label);
      assert.equal(s.timeoutMs, undefined, c.label);
      assert.equal(s.plannerProvenance.fallbackReason, c.reason, c.label);
      assert.equal(s.plannerProvenance.configuredEngineId, id, c.label);
      assert.equal(s.plannerProvenance.resolvedEngineId, null, c.label);
    }
  });
});

describe("fact_image_prompt_engine_id seeding", () => {
  it("seeds the key to the visual planner and the seed is idempotent", async () => {
    await db.execute(sql`DELETE FROM admin_config WHERE key = ${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}`);
    bustConfigCache();
    await seedImagePromptConfig();
    bustConfigCache();
    assert.equal(await getImagePromptEngineId(), DEFAULT_IMAGE_PROMPT_ENGINE_ID);
    assert.equal(DEFAULT_IMAGE_PROMPT_ENGINE_ID, "openai-visual-planner");

    // Idempotent: an admin-edited value survives a re-seed.
    await db.execute(sql`
      UPDATE admin_config SET value = 'custom-engine' WHERE key = ${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}
    `);
    bustConfigCache();
    await seedImagePromptConfig();
    bustConfigCache();
    assert.equal(await getImagePromptEngineId(), "custom-engine");

    // Restore the seeded default for sibling tests.
    await db.execute(sql`
      UPDATE admin_config SET value = ${DEFAULT_IMAGE_PROMPT_ENGINE_ID} WHERE key = ${IMAGE_PROMPT_CONFIG_KEYS.imagePromptEngineId}
    `);
    bustConfigCache();
  });
});
