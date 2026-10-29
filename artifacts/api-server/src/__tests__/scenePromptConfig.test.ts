/**
 * Tests for lib/scenePromptConfig.ts — the admin-configurable scene-prompt
 * SYSTEM prompt. The model + sampling now come from the shared
 * general-intelligence engine, so only the system prompt lives here.
 *
 * The prompt is set in code (Launch Phase 3, plan amendment 1).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedScenePromptConfig,
  getScenePromptSystem,
  SCENE_PROMPT_SYSTEM_DEFAULT,
} from "../lib/scenePromptConfig";
import { bustConfigCache } from "../lib/adminConfig";

describe("scenePromptConfig", () => {
  before(async () => {
    await seedScenePromptConfig();
    bustConfigCache();
  });

  it("the getter returns the code's production prompt", async () => {
    const systemPrompt = await getScenePromptSystem();
    assert.ok(systemPrompt.length > 100, "system prompt should be the seeded default");
    assert.match(systemPrompt, /Return ONLY valid JSON/);
  });

  it("ignores a stored row: the prompt is set in code (codeOwnedPrompts.test.ts covers all six)", async () => {
    await db.execute(sql`INSERT INTO admin_config (key, value, data_type, label) VALUES ('scene_prompt_system', 'custom prompt', 'text', 'x') ON CONFLICT (key) DO UPDATE SET value = 'custom prompt'`);
    bustConfigCache();
    assert.equal(await getScenePromptSystem(), SCENE_PROMPT_SYSTEM_DEFAULT);
    await db.execute(sql`DELETE FROM admin_config WHERE key = 'scene_prompt_system'`);
    bustConfigCache();
  });
});
