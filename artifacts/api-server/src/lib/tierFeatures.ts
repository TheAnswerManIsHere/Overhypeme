import { db } from "@workspace/db";
import { featureFlagsTable, tierFeaturePermissionsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const CACHE_TTL_MS = 60_000;

interface FeatureCacheEntry {
  features: Set<string>;
  fetchedAt: number;
}

const cache = new Map<string, FeatureCacheEntry>();

export function bustTierFeaturesCache(): void {
  cache.clear();
}

export async function getTierFeatures(tier: string): Promise<Set<string>> {
  const entry = cache.get(tier);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.features;
  }

  const rows = await db
    .select({ featureKey: tierFeaturePermissionsTable.featureKey })
    .from(tierFeaturePermissionsTable)
    .where(
      and(
        eq(tierFeaturePermissionsTable.tier, tier),
        eq(tierFeaturePermissionsTable.enabled, true),
      ),
    );

  const features = new Set(rows.map((r) => r.featureKey));
  cache.set(tier, { features, fetchedAt: Date.now() });
  return features;
}

export async function hasFeature(tier: string, featureKey: string): Promise<boolean> {
  const features = await getTierFeatures(tier);
  return features.has(featureKey);
}

export async function getAllTierFeatureMatrix(): Promise<{
  features: Array<{ key: string; displayName: string; description: string | null }>;
  permissions: Array<{ tier: string; featureKey: string; enabled: boolean }>;
}> {
  const [features, permissions] = await Promise.all([
    db.select().from(featureFlagsTable).orderBy(featureFlagsTable.key),
    db.select().from(tierFeaturePermissionsTable).orderBy(tierFeaturePermissionsTable.tier),
  ]);

  return {
    features: features.map((f) => ({
      key: f.key,
      displayName: f.displayName,
      description: f.description ?? null,
    })),
    permissions: permissions.map((p) => ({
      tier: p.tier,
      featureKey: p.featureKey,
      enabled: p.enabled,
    })),
  };
}

export async function setTierFeature(tier: string, featureKey: string, enabled: boolean): Promise<void> {
  await db
    .insert(tierFeaturePermissionsTable)
    .values({ tier, featureKey, enabled })
    .onConflictDoUpdate({
      target: [tierFeaturePermissionsTable.tier, tierFeaturePermissionsTable.featureKey],
      set: { enabled, updatedAt: new Date() },
    });

  cache.delete(tier);
}
