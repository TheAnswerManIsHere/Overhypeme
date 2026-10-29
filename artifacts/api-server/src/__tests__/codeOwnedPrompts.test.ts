/**
 * Launch Phase 3, plan amendment 1, Part B (docs/plans/PLAN_PHASE3_AMENDMENT_1.md):
 * the six AI system prompts are set in code. Every reader returns the code text
 * even when an older database still holds a different row; boot seeding writes
 * none of them; the admin API refuses to save them and lists them from code,
 * marked code-owned; and the two wordings David chose are the ones in the code.
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
import { isCodeOwnedPromptKey } from "../lib/codeOwnedPrompts.js";
import {
  FACT_ENRICHMENT_SYSTEM_DEFAULT,
  getFactEnrichmentSystem,
  resolveFactEnrichmentSystemPrompt,
  seedFactEnrichmentConfig,
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
  seedVisualConceptsConfig,
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

let saved: Array<typeof adminConfigTable.$inferSelect> = [];
let adminId = "";
let adminSid = "";

describe("the six AI system prompts are set in code", () => {
  before(async () => {
    saved = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    adminId = `t_cop_${randomUUID()}`;
    await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", captchaVerified: true });
    const data: SessionData = {
      user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
      access_token: "test-token",
      isAdmin: true,
      captchaVerified: true,
    };
    adminSid = await createSession(data, adminId);
  });

  after(async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    if (saved.length > 0) await db.insert(adminConfigTable).values(saved);
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
    bustConfigCache();
  });

  it("covers exactly the six keys of the amendment", () => {
    for (const key of KEYS) assert.ok(isCodeOwnedPromptKey(key), key);
    assert.equal(isCodeOwnedPromptKey("fact_enrichment_engine_id"), false);
  });

  it("every reader returns the code text, even when a stale row says otherwise", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    await db.insert(adminConfigTable).values(KEYS.map((key) => ({ key, value: "stale stored prompt", dataType: "text", label: key })));
    bustConfigCache();
    for (const [key, read, text] of READERS) assert.equal(await read(), text, key);
    const resolution = await resolveFactEnrichmentSystemPrompt();
    assert.equal(resolution.source, "code_default");
    assert.equal(resolution.matchesCodeDefault, true);
  });

  it("boot seeding writes none of the six rows", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    await seedFactEnrichmentConfig();
    await seedImagePromptConfig();
    await seedVisualConceptsConfig();
    const rows = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    assert.deepEqual(rows, []);
  });

  it("the admin API refuses to save any of the six", async () => {
    const app = createApp();
    for (const key of KEYS) {
      const res = await request(app).patch(`/api/admin/config/${key}`).set("Authorization", `Bearer ${adminSid}`).send({ value: "edited" });
      assert.equal(res.status, 403, key);
      assert.match(res.body.error, /set in code/);
    }
  });

  it("the admin API lists the six from code, marked code-owned, and removes the reset and provenance routes", async () => {
    await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
    await db.insert(adminConfigTable).values({ key: "scene_prompt_system", value: "stale stored prompt", dataType: "text", label: "x" });
    bustConfigCache();
    const app = createApp();
    const res = await request(app).get("/api/admin/config").set("Authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    const rows = (res.body as Array<{ key: string; value: string; codeOwned?: boolean }>).filter((r) => isCodeOwnedPromptKey(r.key));
    assert.equal(rows.length, 6);
    for (const [key, , text] of READERS) {
      const row = rows.find((r) => r.key === key);
      assert.equal(row?.value, text, key);
      assert.equal(row?.codeOwned, true, key);
    }
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
