/**
 * The reference-research system prompt's one-time content migration: a stored
 * row that still holds the unmodified legacy default (which named the retired
 * web_search_preview tool) is promoted to the current default on seed; a row an
 * admin has customized is left alone.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  seedReferenceResearchConfig,
  REFERENCE_RESEARCH_CONFIG_KEYS,
  REFERENCE_RESEARCH_SYSTEM_DEFAULT,
  REFERENCE_RESEARCH_SYSTEM_LEGACY_DEFAULT,
} from "../lib/referenceResearchConfig";

const KEY = REFERENCE_RESEARCH_CONFIG_KEYS.system;

async function storedValue(): Promise<string> {
  const r = await db.execute(sql`SELECT value FROM admin_config WHERE key = ${KEY}`);
  const row = (r.rows ?? (r as unknown as { value: string }[]))[0] as { value: string };
  return row.value;
}

async function setStored(value: string): Promise<void> {
  await db.execute(sql`UPDATE admin_config SET value = ${value} WHERE key = ${KEY}`);
}

describe("reference-research system prompt migration", () => {
  before(seedReferenceResearchConfig);
  after(() => setStored(REFERENCE_RESEARCH_SYSTEM_DEFAULT));

  it("the legacy default differs from the current one only by the tool name", () => {
    assert.match(REFERENCE_RESEARCH_SYSTEM_LEGACY_DEFAULT, /web_search_preview/);
    assert.doesNotMatch(REFERENCE_RESEARCH_SYSTEM_DEFAULT, /web_search_preview/);
    assert.equal(
      REFERENCE_RESEARCH_SYSTEM_LEGACY_DEFAULT.replace("web_search_preview", "web_search"),
      REFERENCE_RESEARCH_SYSTEM_DEFAULT,
    );
  });

  it("promotes an unmodified legacy row to the current default", async () => {
    await setStored(REFERENCE_RESEARCH_SYSTEM_LEGACY_DEFAULT);
    await seedReferenceResearchConfig();
    assert.equal(await storedValue(), REFERENCE_RESEARCH_SYSTEM_DEFAULT);
  });

  it("leaves a customized row untouched, even one naming the old tool", async () => {
    const custom = "custom research prompt — use web_search_preview";
    await setStored(custom);
    await seedReferenceResearchConfig();
    assert.equal(await storedValue(), custom);
  });

  it("is a no-op on a row already at the current default", async () => {
    await setStored(REFERENCE_RESEARCH_SYSTEM_DEFAULT);
    await seedReferenceResearchConfig();
    assert.equal(await storedValue(), REFERENCE_RESEARCH_SYSTEM_DEFAULT);
  });
});
