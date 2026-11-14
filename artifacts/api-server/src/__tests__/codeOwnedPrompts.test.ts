/**
 * Launch Phase 3, plan amendment 1, Part B (docs/plans/PLAN_PHASE3_AMENDMENT_1.md):
 * the six AI system prompts are set in code. Every reader returns the code text
 * even when an older database still holds a different row; boot seeding writes
 * none of them; and the two wordings David chose are the ones in the code.
 *
 * Since 2026-11-14 (docs/plans/PLAN_AI_SETTINGS_IN_CODE.md) the same holds for
 * the retired engine-choice keys, and the admin API neither saves nor lists any
 * AI setting: David retired every admin surface for them.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { adminConfigTable, usersTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { bustConfigCache } from "../lib/adminConfig.js";
import { isCodeOwnedAiConfigKey, isCodeOwnedPromptKey, RETIRED_AI_ENGINE_CONFIG_KEYS } from "../lib/codeOwnedPrompts.js";
import {
  FACT_ENRICHMENT_SYSTEM_DEFAULT,
  getFactEnrichmentSystem,
  resolveFactEnrichmentSystemPrompt,
} from "../lib/factEnrichmentConfig.js";
import {
  FACT_IMAGE_PROMPT_SYSTEM_DEFAULT,
  FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT,
  getFactSourceClassifierSystem,
  getImagePromptSystem,
  seedImagePromptConfig,
} from "../lib/imagePromptConfig.js";
import { REFERENCE_RESEARCH_SYSTEM_DEFAULT, getReferenceResearchSystem } from "../lib/referenceResearchConfig.js";
import { SCENE_PROMPT_SYSTEM_DEFAULT, getScenePromptSystem } from "../lib/scenePromptConfig.js";
import {
  FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT,
  getVisualConceptsSystem,
} from "../lib/visualConceptsConfig.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const READERS: Array<[string, () => Promise<string>, string]> = [
  ["fact_enrichment_system", getFactEnrichmentSystem, FACT_ENRICHMENT_SYSTEM_DEFAULT],
  ["fact_image_prompt_system", getImagePromptSystem, FACT_IMAGE_PROMPT_SYSTEM_DEFAULT],
  ["fact_source_classifier_system", getFactSourceClassifierSystem, FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT],
  ["fact_visual_concepts_system", getVisualConceptsSystem, FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT],
  ["reference_research_system", getReferenceResearchSystem, REFERENCE_RESEARCH_SYSTEM_DEFAULT],
  ["scene_prompt_system", getScenePromptSystem, SCENE_PROMPT_SYSTEM_DEFAULT],
];
const KEYS = READERS.map(([key]) => key);
const ENGINE_KEYS = [...RETIRED_AI_ENGINE_CONFIG_KEYS];
const ALL_AI_KEYS = [...KEYS, ...ENGINE_KEYS];

let saved: Array<typeof adminConfigTable.$inferSelect> = [];
let adminId = "";
let adminSid = "";

describe("AI settings are set in code and have no admin surface", () => {
  before(async () => {
    saved = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    adminId = `t_cop_${randomUUID()}`;
    await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() });
    const data: SessionData = {
      user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
      access_token: "test-token",
      isAdmin: true,
    };
    adminSid = await createSession(data, adminId);
  });

  after(async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    if (saved.length > 0) await db.insert(adminConfigTable).values(saved);
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
    bustConfigCache();
  });

  it("covers exactly the six prompt keys, and every AI setting with the nine retired engine-setting keys", () => {
    for (const key of KEYS) assert.ok(isCodeOwnedPromptKey(key), key);
    assert.equal(isCodeOwnedPromptKey("fact_enrichment_engine_id"), false);
    assert.equal(ENGINE_KEYS.length, 9);
    for (const key of ALL_AI_KEYS) assert.ok(isCodeOwnedAiConfigKey(key), key);
    assert.equal(isCodeOwnedAiConfigKey("review_duplicate_threshold"), false);
  });

  it("every reader returns the code text, even when a stale row says otherwise", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    await db.insert(adminConfigTable).values(KEYS.map((key) => ({ key, value: "stale stored prompt", dataType: "text", label: key })));
    bustConfigCache();
    for (const [key, read, text] of READERS) assert.equal(await read(), text, key);
    const resolution = await resolveFactEnrichmentSystemPrompt();
    assert.equal(resolution.source, "code_default");
    assert.equal(resolution.matchesCodeDefault, true);
  });

  it("boot seeding writes none of the six prompt rows or the nine retired engine-setting rows", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    await seedImagePromptConfig();
    const rows = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    assert.deepEqual(rows, []);
  });

  it("the admin API refuses to save any AI setting", async () => {
    const app = createApp();
    for (const key of ALL_AI_KEYS) {
      const res = await request(app).patch(`/api/admin/config/${key}`).set("Authorization", `Bearer ${adminSid}`).send({ value: "edited" });
      assert.equal(res.status, 403, key);
      assert.match(res.body.error, /set in code/);
    }
  });

  it("the admin API lists no AI setting, even when stale rows exist, and removes the reset and provenance routes", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, ALL_AI_KEYS));
    await db.insert(adminConfigTable).values(ALL_AI_KEYS.map((key) => ({ key, value: "stale stored value", dataType: "text", label: key })));
    bustConfigCache();
    const app = createApp();
    const res = await request(app).get("/api/admin/config").set("Authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    const listed = (res.body as Array<{ key: string }>).map((r) => r.key);
    assert.ok(listed.length > 0, "the list still carries the non-AI settings");
    for (const key of ALL_AI_KEYS) assert.ok(!listed.includes(key), key);
    const reset = await request(app).post("/api/admin/config/fact-enrichment-system/reset-to-default").set("Authorization", `Bearer ${adminSid}`);
    assert.equal(reset.status, 404);
    const provenance = await request(app).get("/api/admin/config/fact-enrichment-system/provenance").set("Authorization", `Bearer ${adminSid}`);
    assert.equal(provenance.status, 404);
  });

  it("holds the wording David chose (2026-10-29): the code's enrichment prompt, the tuned reference-research prompt with web_search", () => {
    assert.equal(md5(FACT_ENRICHMENT_SYSTEM_DEFAULT), "2db85bd52c00f4c009db8b8fb204dcea");
    assert.equal(md5(REFERENCE_RESEARCH_SYSTEM_DEFAULT), "79b131309730218b6b1899ba2f6ea3c4");
    assert.doesNotMatch(REFERENCE_RESEARCH_SYSTEM_DEFAULT, /web_search_preview/);
    assert.match(REFERENCE_RESEARCH_SYSTEM_DEFAULT, /capture the JOKE MECHANISM/);
  });
});
