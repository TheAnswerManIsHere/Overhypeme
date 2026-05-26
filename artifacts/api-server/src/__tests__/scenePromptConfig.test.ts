/**
 * Tests for lib/scenePromptConfig.ts — the admin-configurable scene-prompt
 * levers (system prompt, model, temperature, max tokens).
 *
 * Touches the real test DB. Verifies idempotent seeding, that the getters
 * return the seeded production defaults, and that the debug overlay promotes a
 * key's debug_value when debug mode is active.
 *
 * The debug-mode flip only attaches a debug_value to `scene_prompt_model`
 * (which no other suite reads) and is reset in a finally + after hook, so it
 * cannot leak into a concurrently-running shard's config reads.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedScenePromptConfig,
  getScenePromptGenerationConfig,
  SCENE_PROMPT_MODEL_DEFAULT,
  SCENE_PROMPT_TEMPERATURE_DEFAULT,
  SCENE_PROMPT_MAX_TOKENS_DEFAULT,
} from "../lib/scenePromptConfig";
import { bustConfigCache } from "../lib/adminConfig";

async function resetDebug(): Promise<void> {
  await db.execute(sql`UPDATE admin_config SET value = 'false' WHERE key = 'debug_mode_active'`);
  await db.execute(sql`UPDATE admin_config SET debug_value = NULL WHERE key = 'scene_prompt_model'`);
  bustConfigCache();
}

describe("scenePromptConfig", () => {
  before(async () => {
    // debug_mode_active is seeded in seed.ts; ensure it exists for this isolated run.
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, description, is_public)
      VALUES ('debug_mode_active', 'false', 'boolean', 'Debug Mode Active', '', false)
      ON CONFLICT (key) DO NOTHING
    `);
    await seedScenePromptConfig();
    await resetDebug();
  });

  after(resetDebug);

  it("seeds production defaults that the getters return", async () => {
    const cfg = await getScenePromptGenerationConfig();
    assert.equal(cfg.model, SCENE_PROMPT_MODEL_DEFAULT);
    assert.equal(cfg.temperature, SCENE_PROMPT_TEMPERATURE_DEFAULT);
    assert.equal(cfg.maxTokens, SCENE_PROMPT_MAX_TOKENS_DEFAULT);
    assert.ok(cfg.systemPrompt.length > 100, "system prompt should be the seeded default");
  });

  it("seeding is idempotent (re-seed leaves existing values untouched)", async () => {
    await db.execute(sql`UPDATE admin_config SET value = 'gpt-4o' WHERE key = 'scene_prompt_model'`);
    bustConfigCache();
    await seedScenePromptConfig(); // ON CONFLICT DO NOTHING — must NOT overwrite
    bustConfigCache();
    const cfg = await getScenePromptGenerationConfig();
    assert.equal(cfg.model, "gpt-4o");
    // restore the production default for other tests
    await db.execute(sql`UPDATE admin_config SET value = ${SCENE_PROMPT_MODEL_DEFAULT} WHERE key = 'scene_prompt_model'`);
    bustConfigCache();
  });

  it("debug overlay: debug_value wins only when debug mode is active", async () => {
    await db.execute(sql`UPDATE admin_config SET debug_value = 'gpt-4o-experiment' WHERE key = 'scene_prompt_model'`);
    bustConfigCache();

    // Debug mode OFF → still the production value.
    assert.equal((await getScenePromptGenerationConfig()).model, SCENE_PROMPT_MODEL_DEFAULT);

    try {
      await db.execute(sql`UPDATE admin_config SET value = 'true' WHERE key = 'debug_mode_active'`);
      bustConfigCache();
      assert.equal((await getScenePromptGenerationConfig()).model, "gpt-4o-experiment");
    } finally {
      await resetDebug();
    }
  });
});
