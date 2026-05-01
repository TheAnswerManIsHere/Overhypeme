/**
 * Integration tests for lib/tierFeatures.ts.
 *
 * Tests talk to the real test DB. Each test creates feature flags and
 * tier-feature-permission rows prefixed with "t_tf_" and cleans them up
 * in a finally block to avoid polluting shared data.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { featureFlagsTable, tierFeaturePermissionsTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import {
  getTierFeatures,
  hasFeature,
  setTierFeature,
  getAllTierFeatureMatrix,
  bustTierFeaturesCache,
} from "../lib/tierFeatures.js";


const KEY_PREFIX = "t_tf_";
const TIER = "t_tf_tier_test";

async function insertFlag(key: string): Promise<void> {
  await db
    .insert(featureFlagsTable)
    .values({ key, displayName: `Test flag ${key}` })
    .onConflictDoNothing();
}

async function cleanup(): Promise<void> {
  await db
    .delete(tierFeaturePermissionsTable)
    .where(like(tierFeaturePermissionsTable.featureKey, `${KEY_PREFIX}%`));
  await db
    .delete(featureFlagsTable)
    .where(like(featureFlagsTable.key, `${KEY_PREFIX}%`));
}

before(cleanup);
after(cleanup);
beforeEach(() => {
  bustTierFeaturesCache();
});

describe("getTierFeatures", () => {
  it("returns an empty set when the tier has no permissions", async () => {
    await cleanup();
    const features = await getTierFeatures(TIER);
    assert.equal(features.size, 0);
  });

  it("returns enabled feature keys for the tier", async () => {
    await cleanup();
    const key1 = `${KEY_PREFIX}feat_a`;
    const key2 = `${KEY_PREFIX}feat_b`;
    await insertFlag(key1);
    await insertFlag(key2);
    await db.insert(tierFeaturePermissionsTable).values([
      { tier: TIER, featureKey: key1, enabled: true },
      { tier: TIER, featureKey: key2, enabled: true },
    ]);

    const features = await getTierFeatures(TIER);
    assert.ok(features.has(key1), "should contain feat_a");
    assert.ok(features.has(key2), "should contain feat_b");
  });

  it("excludes disabled feature keys", async () => {
    await cleanup();
    const keyEnabled = `${KEY_PREFIX}enabled`;
    const keyDisabled = `${KEY_PREFIX}disabled`;
    await insertFlag(keyEnabled);
    await insertFlag(keyDisabled);
    await db.insert(tierFeaturePermissionsTable).values([
      { tier: TIER, featureKey: keyEnabled, enabled: true },
      { tier: TIER, featureKey: keyDisabled, enabled: false },
    ]);

    const features = await getTierFeatures(TIER);
    assert.ok(features.has(keyEnabled), "enabled key should be present");
    assert.ok(!features.has(keyDisabled), "disabled key should not be present");
  });

  it("returns cached result on second call without re-querying", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}cached`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    const first = await getTierFeatures(TIER);
    // Delete the row in DB — cached call should still return the key
    await db.delete(tierFeaturePermissionsTable);
    const second = await getTierFeatures(TIER);

    assert.ok(first.has(key));
    assert.ok(second.has(key), "cache should still serve the deleted row");
  });

  it("bustTierFeaturesCache invalidates the cache so fresh data is loaded", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}bust`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    await getTierFeatures(TIER); // prime cache
    await db.delete(tierFeaturePermissionsTable); // modify DB while cache is warm
    bustTierFeaturesCache();

    const features = await getTierFeatures(TIER);
    assert.ok(!features.has(key), "cache bust should expose the DB deletion");
  });
});

describe("hasFeature", () => {
  it("returns true when the tier has the feature enabled", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}has_yes`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    assert.equal(await hasFeature(TIER, key), true);
  });

  it("returns false when the feature is disabled", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}has_no`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: false });

    assert.equal(await hasFeature(TIER, key), false);
  });

  it("returns false when the feature key does not exist for the tier", async () => {
    await cleanup();
    assert.equal(await hasFeature(TIER, `${KEY_PREFIX}nonexistent`), false);
  });
});

describe("setTierFeature", () => {
  it("inserts a new permission row", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}set_new`;
    await insertFlag(key);

    await setTierFeature(TIER, key, true);
    bustTierFeaturesCache();

    assert.equal(await hasFeature(TIER, key), true);
  });

  it("updates an existing permission row (upsert)", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}set_upd`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    await setTierFeature(TIER, key, false);
    bustTierFeaturesCache();

    assert.equal(await hasFeature(TIER, key), false);
  });

  it("busts the cache for the affected tier after write", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}set_cache`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    await getTierFeatures(TIER); // prime cache
    await setTierFeature(TIER, key, false); // should bust cache for TIER

    // After setTierFeature the cache for this tier is deleted; next call re-fetches
    assert.equal(await hasFeature(TIER, key), false);
  });
});

describe("getAllTierFeatureMatrix", () => {
  it("returns both features and permissions arrays", async () => {
    await cleanup();
    const key = `${KEY_PREFIX}matrix`;
    await insertFlag(key);
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier: TIER, featureKey: key, enabled: true });

    const matrix = await getAllTierFeatureMatrix();

    const flag = matrix.features.find((f) => f.key === key);
    assert.ok(flag, "inserted feature should appear in matrix.features");
    assert.equal(flag.displayName, `Test flag ${key}`);

    const perm = matrix.permissions.find((p) => p.tier === TIER && p.featureKey === key);
    assert.ok(perm, "inserted permission should appear in matrix.permissions");
    assert.equal(perm.enabled, true);
  });
});
