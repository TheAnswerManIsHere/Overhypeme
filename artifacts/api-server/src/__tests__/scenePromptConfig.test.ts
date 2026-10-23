/**
 * Tests for lib/scenePromptConfig.ts — the admin-configurable scene-prompt
 * SYSTEM prompt. The model + sampling now come from the shared
 * general-intelligence engine, so only the system prompt lives here.
 *
 * Touches the real test DB. Verifies idempotent seeding and that the getter
 * returns the seeded default.
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
});
