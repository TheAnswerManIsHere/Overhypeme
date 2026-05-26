/**
 * Tests for lib/videoDirection.ts — the admin-configurable video-direction
 * levers (system prompt, model, temperature, max tokens) that produce the
 * motion/action direction layered onto the motion preset for image-to-video.
 *
 * Touches the real test DB. Verifies idempotent seeding, that the getter
 * returns the seeded production defaults, and that the debug overlay promotes a
 * key's debug_value when debug mode is active.
 *
 * The debug-mode flip only attaches a debug_value to `video_direction_model`
 * (which no other suite reads) and is reset in a finally + after hook, so it
 * cannot leak into a concurrently-running shard's config reads.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedVideoDirectionConfig,
  getVideoDirectionGenerationConfig,
  VIDEO_DIRECTION_MODEL_DEFAULT,
  VIDEO_DIRECTION_TEMPERATURE_DEFAULT,
  VIDEO_DIRECTION_MAX_TOKENS_DEFAULT,
} from "../lib/videoDirection";
import { bustConfigCache } from "../lib/adminConfig";

async function resetDebug(): Promise<void> {
  await db.execute(sql`UPDATE admin_config SET value = 'false' WHERE key = 'debug_mode_active'`);
  await db.execute(sql`UPDATE admin_config SET debug_value = NULL WHERE key = 'video_direction_model'`);
  bustConfigCache();
}

describe("videoDirection", () => {
  before(async () => {
    await db.execute(sql`
      INSERT INTO admin_config (key, value, data_type, label, description, is_public)
      VALUES ('debug_mode_active', 'false', 'boolean', 'Debug Mode Active', '', false)
      ON CONFLICT (key) DO NOTHING
    `);
    await seedVideoDirectionConfig();
    await resetDebug();
  });

  after(resetDebug);

  it("seeds production defaults that the getter returns", async () => {
    const cfg = await getVideoDirectionGenerationConfig();
    assert.equal(cfg.model, VIDEO_DIRECTION_MODEL_DEFAULT);
    assert.equal(cfg.temperature, VIDEO_DIRECTION_TEMPERATURE_DEFAULT);
    assert.equal(cfg.maxTokens, VIDEO_DIRECTION_MAX_TOKENS_DEFAULT);
    assert.ok(cfg.systemPrompt.length > 100, "system prompt should be the seeded default");
  });

  it("seeds the system prompt as a textarea (data_type text)", async () => {
    const r = await db.execute(
      sql`SELECT data_type FROM admin_config WHERE key = 'video_direction_system'`,
    );
    const row = (r.rows ?? (r as unknown as { data_type: string }[]))[0] as { data_type: string };
    assert.equal(row.data_type, "text");
  });

  it("seeding is idempotent (re-seed leaves existing values untouched)", async () => {
    await db.execute(sql`UPDATE admin_config SET value = 'gpt-4o' WHERE key = 'video_direction_model'`);
    bustConfigCache();
    await seedVideoDirectionConfig(); // ON CONFLICT DO NOTHING — must NOT overwrite
    bustConfigCache();
    const cfg = await getVideoDirectionGenerationConfig();
    assert.equal(cfg.model, "gpt-4o");
    await db.execute(sql`UPDATE admin_config SET value = ${VIDEO_DIRECTION_MODEL_DEFAULT} WHERE key = 'video_direction_model'`);
    bustConfigCache();
  });

  it("debug overlay: debug_value wins only when debug mode is active", async () => {
    await db.execute(sql`UPDATE admin_config SET debug_value = 'gpt-4o-experiment' WHERE key = 'video_direction_model'`);
    bustConfigCache();

    assert.equal((await getVideoDirectionGenerationConfig()).model, VIDEO_DIRECTION_MODEL_DEFAULT);

    try {
      await db.execute(sql`UPDATE admin_config SET value = 'true' WHERE key = 'debug_mode_active'`);
      bustConfigCache();
      assert.equal((await getVideoDirectionGenerationConfig()).model, "gpt-4o-experiment");
    } finally {
      await resetDebug();
    }
  });
});
