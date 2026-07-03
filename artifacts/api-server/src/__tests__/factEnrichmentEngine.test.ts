/**
 * Tests for the dedicated fact-enrichment engine route:
 *   - the openai-enricher catalogue definition
 *   - resolveFactEnrichmentLLMSettings(): engine settings when the configured
 *     row is valid, fallback (with a reason) for every invalid state
 *   - fact_enrichment_engine_id seeding
 *
 * Touches the real test DB (engines + admin_config).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { enginesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { like, inArray } from "drizzle-orm";

import { ALL_ENGINES } from "../lib/engines";
import { clearEngineCaches } from "../lib/engineInterpreter";
import { bustConfigCache } from "../lib/adminConfig";
import {
  seedFactEnrichmentConfig,
  getFactEnrichmentEngineId,
  DEFAULT_FACT_ENRICHMENT_ENGINE_ID,
  FACT_ENRICHMENT_CONFIG_KEYS,
  FACT_ENRICHMENT_TEMPERATURE,
  FACT_ENRICHMENT_MAX_TOKENS,
} from "../lib/factEnrichmentConfig";
import {
  resolveFactEnrichmentLLMSettings,
  FACT_ENRICHMENT_LLM_TIMEOUT_MS,
} from "../lib/factEnrichment";

const ENGINE_PREFIX = "t-fee-";
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
    label: `Test enricher engine ${id}`,
    description: "Synthetic test engine — created by factEnrichmentEngine.test.ts.",
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
    defaultMaxTokens: opts.defaultMaxTokens === undefined ? 600 : opts.defaultMaxTokens,
    defaultReasoningEffort: opts.defaultReasoningEffort === undefined ? "high" : opts.defaultReasoningEffort,
    defaultTemperature: opts.defaultTemperature === undefined ? "0.20" : opts.defaultTemperature,
  });
  insertedEngineIds.push(id);
  clearEngineCaches();
  return id;
}

async function setConfiguredEngineId(value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO admin_config (key, value, data_type, label, description, is_public)
    VALUES (${FACT_ENRICHMENT_CONFIG_KEYS.engineId}, ${value}, 'string', 'test', 'test', false)
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `);
  bustConfigCache();
  clearEngineCaches();
}

describe("openai-enricher catalogue definition", () => {
  it("exists with the agreed defaults and is not kind-default eligible", () => {
    const def = ALL_ENGINES.find((e) => e.id === "openai-enricher");
    assert.ok(def, "openai-enricher must be in ALL_ENGINES");
    assert.equal(def!.kind, "llm");
    assert.equal(def!.provider, "openai");
    assert.equal(def!.isDefault, false);
    assert.equal(def!.endpointId, "gpt-5.5");
    assert.equal(def!.defaultReasoningEffort, "high");
    assert.equal(def!.defaultMaxTokens, 600);
    assert.equal(def!.eligibleAsKindDefault, false);
  });
});

describe("resolveFactEnrichmentLLMSettings", () => {
  let originalConfigValue: string | null = null;

  before(async () => {
    const r = await db.execute(sql`
      SELECT value FROM admin_config WHERE key = ${FACT_ENRICHMENT_CONFIG_KEYS.engineId}
    `);
    const rows = (r.rows ?? []) as Array<{ value: string }>;
    originalConfigValue = rows[0]?.value ?? null;
  });

  after(async () => {
    if (originalConfigValue == null) {
      await db.execute(sql`DELETE FROM admin_config WHERE key = ${FACT_ENRICHMENT_CONFIG_KEYS.engineId}`);
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

  it("returns the engine's settings for a valid active row", async () => {
    const id = await seedLLMEngine();
    await setConfiguredEngineId(id);
    const s = await resolveFactEnrichmentLLMSettings();
    assert.equal(s.model, "gpt-5.5");
    assert.equal(s.maxTokens, 600);
    assert.equal(s.reasoningEffort, "high");
    assert.equal(s.temperature, 0.2);
    assert.equal(s.timeoutMs, FACT_ENRICHMENT_LLM_TIMEOUT_MS);
    assert.equal(s.resolvedEngineId, id);
    assert.equal(s.fallbackReason, null);
  });

  it("falls back to the engine-less defaults (no model) for every invalid state", async () => {
    const cases: Array<{ label: string; engineId: () => Promise<string> | string; reason: string }> = [
      { label: "missing id", engineId: () => `${ENGINE_PREFIX}nope-${randomUUID().slice(0, 8)}`, reason: "engine_not_found" },
      { label: "inactive", engineId: () => seedLLMEngine({ isActive: false }), reason: "engine_inactive" },
      { label: "soft-deleted", engineId: () => seedLLMEngine({ deletedAt: new Date(0) }), reason: "engine_deleted" },
      { label: "wrong kind", engineId: () => seedLLMEngine({ kind: "image" }), reason: "engine_not_llm" },
      { label: "wrong provider", engineId: () => seedLLMEngine({ provider: "fal" }), reason: "engine_not_openai" },
    ];
    for (const c of cases) {
      const id = await c.engineId();
      await setConfiguredEngineId(id);
      const s = await resolveFactEnrichmentLLMSettings();
      assert.equal(s.model, undefined, `${c.label}: no model override on fallback`);
      assert.equal(s.temperature, FACT_ENRICHMENT_TEMPERATURE, `${c.label}: temp`);
      assert.equal(s.maxTokens, FACT_ENRICHMENT_MAX_TOKENS, `${c.label}: maxTokens`);
      assert.equal(s.resolvedEngineId, null, `${c.label}: no resolved engine`);
      assert.equal(s.fallbackReason, c.reason, `${c.label}: reason`);
    }
  });

  it("seeds fact_enrichment_engine_id to the default enricher", async () => {
    await db.execute(sql`DELETE FROM admin_config WHERE key = ${FACT_ENRICHMENT_CONFIG_KEYS.engineId}`);
    bustConfigCache();
    await seedFactEnrichmentConfig();
    bustConfigCache();
    assert.equal(await getFactEnrichmentEngineId(), DEFAULT_FACT_ENRICHMENT_ENGINE_ID);
  });
});
