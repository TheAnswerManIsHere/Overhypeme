/**
 * Tests for lib/videoDirection.ts — the admin-configurable video-direction
 * SYSTEM prompt. The model + sampling now come from the shared
 * general-intelligence engine, so only the system prompt lives here.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedVideoDirectionConfig,
  getVideoDirectionSystem,
  VIDEO_DIRECTION_SYSTEM_DEFAULT,
} from "../lib/videoDirection";
import { bustConfigCache } from "../lib/adminConfig";

async function resetDebug(): Promise<void> {
  await db.execute(sql`UPDATE admin_config SET value = 'false' WHERE key = 'debug_mode_active'`);
  await db.execute(sql`UPDATE admin_config SET debug_value = NULL WHERE key = 'video_direction_system'`);
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

  it("seeds the production default that the getter returns", async () => {
    const systemPrompt = await getVideoDirectionSystem();
    assert.ok(systemPrompt.length > 100, "system prompt should be the seeded default");
    assert.match(systemPrompt, /image-to-video/);
  });

  it("seeds the system prompt as a textarea (data_type text)", async () => {
    const r = await db.execute(
      sql`SELECT data_type FROM admin_config WHERE key = 'video_direction_system'`,
    );
    const row = (r.rows ?? (r as unknown as { data_type: string }[]))[0] as { data_type: string };
    assert.equal(row.data_type, "text");
  });

  it("seeding is idempotent (re-seed leaves existing values untouched)", async () => {
    await db.execute(sql`UPDATE admin_config SET value = 'custom video prompt' WHERE key = 'video_direction_system'`);
    bustConfigCache();
    await seedVideoDirectionConfig(); // ON CONFLICT DO NOTHING — must NOT overwrite
    bustConfigCache();
    assert.equal(await getVideoDirectionSystem(), "custom video prompt");
    await db.execute(sql`UPDATE admin_config SET value = ${VIDEO_DIRECTION_SYSTEM_DEFAULT} WHERE key = 'video_direction_system'`);
    bustConfigCache();
  });

  it("debug overlay: debug_value wins only when debug mode is active", async () => {
    await db.execute(sql`UPDATE admin_config SET debug_value = 'debug video prompt' WHERE key = 'video_direction_system'`);
    bustConfigCache();

    assert.equal(await getVideoDirectionSystem(), VIDEO_DIRECTION_SYSTEM_DEFAULT);

    try {
      await db.execute(sql`UPDATE admin_config SET value = 'true' WHERE key = 'debug_mode_active'`);
      bustConfigCache();
      assert.equal(await getVideoDirectionSystem(), "debug video prompt");
    } finally {
      await resetDebug();
    }
  });
});
