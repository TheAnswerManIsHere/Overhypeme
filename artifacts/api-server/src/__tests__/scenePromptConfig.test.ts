/**
 * Tests for lib/scenePromptConfig.ts — the admin-configurable scene-prompt
 * SYSTEM prompt. The model + sampling now come from the shared
 * general-intelligence engine, so only the system prompt lives here.
 *
 * Touches the real test DB. Verifies idempotent seeding, that the getter
 * returns the seeded default, and that the debug overlay promotes the
 * debug_value when debug mode is active.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedScenePromptConfig,
  getScenePromptSystem,
  SCENE_PROMPT_SYSTEM_DEFAULT,
} from "../lib/scenePromptConfig";
import { bustConfigCache } from "../lib/adminConfig";

async function resetDebug(): Promise<void> {
  await db.execute(sql`UPDATE admin_config SET value = 'false' WHERE key = 'debug_mode_active'`);
  await db.execute(sql`UPDATE admin_config SET debug_value = NULL WHERE key = 'scene_prompt_system'`);
  bustConfigCache();
}

describe("scenePromptConfig", () => {
  before(async () => {
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, description, is_public)
      VALUES ('debug_mode_active', 'false', 'boolean', 'Debug Mode Active', '', false)
      ON CONFLICT (key) DO NOTHING
    `);
    await seedScenePromptConfig();
    await resetDebug();
  });

  after(resetDebug);

  it("seeds the production default that the getter returns", async () => {
    const systemPrompt = await getScenePromptSystem();
    assert.ok(systemPrompt.length > 100, "system prompt should be the seeded default");
    assert.match(systemPrompt, /Return ONLY valid JSON/);
  });

  it("seeds the system prompt as a textarea (data_type text)", async () => {
    const r = await db.execute(
      sql`SELECT data_type FROM admin_config WHERE key = 'scene_prompt_system'`,
    );
    const row = (r.rows ?? (r as unknown as { data_type: string }[]))[0] as { data_type: string };
    assert.equal(row.data_type, "text");
  });

  it("seeding is idempotent (re-seed leaves existing values untouched)", async () => {
    await db.execute(sql`UPDATE admin_config SET value = 'custom prompt' WHERE key = 'scene_prompt_system'`);
    bustConfigCache();
    await seedScenePromptConfig(); // ON CONFLICT DO NOTHING — must NOT overwrite
    bustConfigCache();
    assert.equal(await getScenePromptSystem(), "custom prompt");
    await db.execute(sql`UPDATE admin_config SET value = ${SCENE_PROMPT_SYSTEM_DEFAULT} WHERE key = 'scene_prompt_system'`);
    bustConfigCache();
  });

  it("debug overlay: debug_value wins only when debug mode is active", async () => {
    await db.execute(sql`UPDATE admin_config SET debug_value = 'debug experiment prompt' WHERE key = 'scene_prompt_system'`);
    bustConfigCache();

    assert.equal(await getScenePromptSystem(), SCENE_PROMPT_SYSTEM_DEFAULT);

    try {
      await db.execute(sql`UPDATE admin_config SET value = 'true' WHERE key = 'debug_mode_active'`);
      bustConfigCache();
      assert.equal(await getScenePromptSystem(), "debug experiment prompt");
    } finally {
      await resetDebug();
    }
  });
});
