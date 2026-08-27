/**
 * Integration tests for lib/featureAccess.ts — the permission chokepoint.
 *
 * These talk to the real test DB and mutate real grid rows, so every test that
 * changes a cell restores it in a `finally`. They deliberately operate on the
 * canonical feature keys rather than synthetic ones: the resolver's map is
 * total over `FEATURE_KEYS`, so a made-up key would never be resolved and a
 * test using one would prove nothing about the real surface.
 *
 * Covers plan tests 1 (union), 2 (own-tier monotonicity / the PR #402
 * regression), 3 (no orphans, no unreachable keys), 4 (fail-closed), 10
 * (row-set completeness), 11 (grid-editor safety + audit), and 20 (migration
 * observability).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import {
  featureFlagsTable,
  tierFeaturePermissionsTable,
  tierFeaturePermissionAuditTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

import {
  FEATURE_KEYS,
  GRID_TIERS,
  ANONYMOUS_PRINCIPAL,
  can,
  getAllTierFeatureMatrix,
  getGridRevision,
  principalFromUser,
  principalFingerprint,
  resolveEntitlements,
  setTierFeature,
  toWireEntitlements,
  UnknownFeatureError,
  UnknownTierError,
  _resetEntitlementCacheForTest,
  type FeatureKey,
  type Principal,
} from "../lib/featureAccess.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Reads a cell straight from the table, bypassing the resolver and its cache. */
async function readCell(tier: string, featureKey: string): Promise<boolean | null> {
  const rows = await db
    .select({ enabled: tierFeaturePermissionsTable.enabled })
    .from(tierFeaturePermissionsTable)
    .where(
      and(
        eq(tierFeaturePermissionsTable.tier, tier),
        eq(tierFeaturePermissionsTable.featureKey, featureKey),
      ),
    )
    .limit(1);
  return rows.length > 0 ? rows[0]!.enabled : null;
}

/** Writes a cell directly, without audit/revision, for test setup only. */
async function writeCellRaw(tier: string, featureKey: string, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await db
      .delete(tierFeaturePermissionsTable)
      .where(
        and(
          eq(tierFeaturePermissionsTable.tier, tier),
          eq(tierFeaturePermissionsTable.featureKey, featureKey),
        ),
      );
  } else {
    await db
      .insert(tierFeaturePermissionsTable)
      .values({ tier, featureKey, enabled })
      .onConflictDoUpdate({
        target: [tierFeaturePermissionsTable.tier, tierFeaturePermissionsTable.featureKey],
        set: { enabled },
      });
  }
  _resetEntitlementCacheForTest();
}

/** Runs `fn` with a cell forced to `enabled`, then restores whatever was there. */
async function withCell(
  tier: string,
  featureKey: string,
  enabled: boolean | null,
  fn: () => Promise<void>,
): Promise<void> {
  const original = await readCell(tier, featureKey);
  await writeCellRaw(tier, featureKey, enabled);
  try {
    await fn();
  } finally {
    await writeCellRaw(tier, featureKey, original);
  }
}

const registered: Principal = { tier: "registered", isAdmin: false };
const legendary: Principal = { tier: "legendary", isAdmin: false };
/** An admin whose own stored tier is `registered` — the common real case. */
const registeredAdmin: Principal = { tier: "registered", isAdmin: true };
/** An admin who also holds a paid entitlement. */
const legendaryAdmin: Principal = { tier: "legendary", isAdmin: true };

before(() => { _resetEntitlementCacheForTest(); });
after(() => { _resetEntitlementCacheForTest(); });
beforeEach(() => { _resetEntitlementCacheForTest(); });

// ── Test 1 — union semantics ─────────────────────────────────────────────────

describe("union semantics", () => {
  it("an admin resolves a superset of what their own tier alone resolves", async () => {
    for (const tier of ["unregistered", "registered", "legendary"] as const) {
      const plain = await resolveEntitlements({ tier, isAdmin: false });
      const asAdmin = await resolveEntitlements({ tier, isAdmin: true });

      for (const key of FEATURE_KEYS) {
        const plainAllowed = plain.entitlements.get(key)!.allowed;
        const adminAllowed = asAdmin.entitlements.get(key)!.allowed;
        assert.ok(
          !plainAllowed || adminAllowed,
          `${tier}/${key}: admin overlay removed an entitlement the tier already had`,
        );
      }
    }
  });

  it("the admin overlay ADDS rather than replaces", async () => {
    // `custom_avatar` is off for registered and on for admin, so a registered
    // admin gets it purely from the overlay.
    assert.equal(await can(registered, "custom_avatar"), false);
    assert.equal(await can(registeredAdmin, "custom_avatar"), true);
  });

  it("turning the admin row off does not remove what the account's own tier grants", async () => {
    await withCell("admin", "meme_private_visibility", false, async () => {
      // The overlay is off, but legendary still grants it on its own.
      assert.equal(await can(legendaryAdmin, "meme_private_visibility"), true);
      // A registered admin has nothing else granting it, so it is now denied —
      // the union working correctly, not a bug.
      assert.equal(await can(registeredAdmin, "meme_private_visibility"), false);
    });
  });
});

// ── Test 2 — the PR #402 regression, generalised ─────────────────────────────

describe("own-tier monotonicity (PR #402)", () => {
  it("being an admin never makes an account worse off, for any key or tier", async () => {
    for (const tier of GRID_TIERS) {
      for (const key of FEATURE_KEYS) {
        const withoutAdmin = await can({ tier, isAdmin: false }, key);
        const withAdmin = await can({ tier, isAdmin: true }, key);
        assert.ok(
          !withoutAdmin || withAdmin,
          `${tier}/${key}: adding the admin overlay revoked an entitlement`,
        );
      }
    }
  });

  it("PR #402 itself: an admin may set a meme private", async () => {
    // The named regression case. The builder offered admins a Private pill and
    // the save path resolved `meme_private_visibility` from the tier column,
    // found `registered`, and coerced the meme public.
    assert.equal(await can(registeredAdmin, "meme_private_visibility"), true);
  });
});

// ── Test 3 — reachability and orphans ────────────────────────────────────────

describe("grid completeness", () => {
  it("every key the resolver consults exists in the grid with a complete four-row set", async () => {
    const { permissions } = await getAllTierFeatureMatrix();
    for (const key of FEATURE_KEYS) {
      const tiers = new Set(
        permissions.filter((p) => p.featureKey === key).map((p) => p.tier),
      );
      for (const tier of GRID_TIERS) {
        assert.ok(tiers.has(tier), `${key} is missing its ${tier} row`);
      }
    }
  });

  it("no grid key is unreachable — every feature except the declared exception is consulted", async () => {
    // This is the test that would have caught `meme_upload_photo`, and it now
    // fails if a future migration reintroduces an unread row.
    const { features } = await getAllTierFeatureMatrix();
    const consulted = new Set<string>(FEATURE_KEYS);
    // `engine_experiments` is the one declared, Plan-3-owned exception.
    const declaredExceptions = new Set(["engine_experiments"]);

    for (const feature of features) {
      if (declaredExceptions.has(feature.key)) continue;
      assert.ok(
        consulted.has(feature.key),
        `${feature.key} is in the grid but no code reads it — either wire it up or retire it`,
      );
    }
  });

  it("meme_upload_photo and its tier rows are gone", async () => {
    // Retired because no code read it AND no user action corresponded to it —
    // its values encoded only the registered-vs-unregistered distinction that
    // authentication already enforces. Re-deleting is a no-op; a second
    // invocation of the backfill is exercised under "migration observability".
    const flags = await db
      .select({ key: featureFlagsTable.key })
      .from(featureFlagsTable)
      .where(eq(featureFlagsTable.key, "meme_upload_photo"));
    assert.equal(flags.length, 0, "meme_upload_photo should have been retired");

    const perms = await db
      .select({ tier: tierFeaturePermissionsTable.tier })
      .from(tierFeaturePermissionsTable)
      .where(eq(tierFeaturePermissionsTable.featureKey, "meme_upload_photo"));
    assert.equal(perms.length, 0, "meme_upload_photo tier rows should have been retired");
  });

  it("meme_ai_background is NOT retired — a dead reader is not a dead capability", async () => {
    // The distinction that nearly cost us this row: its only reader was an
    // unreachable gate in render.ts, which makes it look like a second
    // meme_upload_photo. But the capability is live and user-facing — the AI
    // Background Picker's generate button — and was gated by requireLegendary
    // in memes.ts, which is precisely the inline-role-check category this plan
    // moves INTO the grid.
    const [flag] = await db
      .select({ key: featureFlagsTable.key })
      .from(featureFlagsTable)
      .where(eq(featureFlagsTable.key, "meme_ai_background"));
    assert.ok(flag, "meme_ai_background must remain a real dial");
    assert.ok(
      (FEATURE_KEYS as readonly string[]).includes("meme_ai_background"),
      "and the resolver must consult it",
    );
  });
});

// ── Test 4 — fail-closed ─────────────────────────────────────────────────────

describe("fails closed", () => {
  it("an unknown feature key denies", async () => {
    assert.equal(await can(legendaryAdmin, "no_such_feature"), false);
  });

  it("a missing row denies rather than throwing", async () => {
    await withCell("legendary", "ads_free", null, async () => {
      assert.equal(await can(legendary, "ads_free"), false);
    });
  });

  it("the resolved map is total over FEATURE_KEYS even with rows missing", async () => {
    await withCell("registered", "ads_free", null, async () => {
      const { entitlements } = await resolveEntitlements(registered);
      for (const key of FEATURE_KEYS) {
        assert.ok(entitlements.has(key), `${key} missing from a resolved map`);
      }
      assert.equal(entitlements.get("ads_free")!.allowed, false);
    });
  });

  it("anonymous callers resolve the unregistered row-set, not a crash", async () => {
    const { entitlements } = await resolveEntitlements(ANONYMOUS_PRINCIPAL);
    assert.equal(entitlements.size, FEATURE_KEYS.length);
    for (const key of FEATURE_KEYS) {
      assert.equal(entitlements.get(key)!.allowed, false, `${key} should be denied to anonymous`);
    }
  });
});

// ── Principal normalization ──────────────────────────────────────────────────

describe("principal normalization", () => {
  it("view-as-user normalizes to registered, not to the account's own paid tier", async () => {
    // A legendary-holding admin in preview mode. `membershipTier` is NOT
    // toggle-aware, so the naive read would leave them on `legendary` and every
    // Legendary feature would still resolve.
    const previewing = principalFromUser({
      membershipTier: "legendary",
      isAdmin: false,
      isRealAdmin: true,
    });
    assert.deepEqual(previewing, { tier: "registered", isAdmin: false });
    assert.equal(await can(previewing, "meme_private_visibility"), false);
  });

  it("an admin not previewing keeps their own tier and the overlay", async () => {
    const normal = principalFromUser({
      membershipTier: "legendary",
      isAdmin: true,
      isRealAdmin: true,
    });
    assert.deepEqual(normal, { tier: "legendary", isAdmin: true });
  });

  it("a non-admin is never dropped to registered by a stale preview flag", async () => {
    const plainLegendary = principalFromUser({
      membershipTier: "legendary",
      isAdmin: false,
      isRealAdmin: false,
    });
    assert.deepEqual(plainLegendary, { tier: "legendary", isAdmin: false });
  });

  it("the fingerprint moves when the principal moves, and only then", () => {
    const a = principalFingerprint({ tier: "registered", isAdmin: false }, "u1");
    assert.equal(a, principalFingerprint({ tier: "registered", isAdmin: false }, "u1"));
    assert.notEqual(a, principalFingerprint({ tier: "legendary", isAdmin: false }, "u1"));
    assert.notEqual(a, principalFingerprint({ tier: "registered", isAdmin: true }, "u1"));
    assert.notEqual(a, principalFingerprint({ tier: "registered", isAdmin: false }, "u2"));
    assert.notEqual(a, principalFingerprint({ tier: "registered", isAdmin: false }, null));
  });
});

// ── Test 11 — grid-editor safety and the audit trail ─────────────────────────

describe("grid writes", () => {
  it("rejects an unknown tier and writes nothing", async () => {
    const before = await getGridRevision();
    await assert.rejects(
      () => setTierFeature("not_a_tier", "ads_free", true, null),
      UnknownTierError,
    );
    _resetEntitlementCacheForTest();
    assert.equal(await getGridRevision(), before, "a rejected write must not bump the revision");
  });

  it("rejects an unknown feature and writes nothing", async () => {
    const before = await getGridRevision();
    await assert.rejects(
      () => setTierFeature("registered", "no_such_feature", true, null),
      UnknownFeatureError,
    );
    _resetEntitlementCacheForTest();
    assert.equal(await getGridRevision(), before, "a rejected write must not bump the revision");

    const audit = await db
      .select({ id: tierFeaturePermissionAuditTable.id })
      .from(tierFeaturePermissionAuditTable)
      .where(eq(tierFeaturePermissionAuditTable.featureKey, "no_such_feature"));
    assert.equal(audit.length, 0, "a rejected write must not write an audit row");
  });

  it("a successful change is attributed, records the true prior value, and bumps the revision", async () => {
    const original = await readCell("registered", "ads_free");
    const revisionBefore = await getGridRevision();
    try {
      const result = await setTierFeature("registered", "ads_free", true, null);

      assert.equal(result.enabledBefore, original);
      assert.ok(result.gridRevision > revisionBefore, "the revision must advance");

      const [audit] = await db
        .select()
        .from(tierFeaturePermissionAuditTable)
        .where(
          and(
            eq(tierFeaturePermissionAuditTable.tier, "registered"),
            eq(tierFeaturePermissionAuditTable.featureKey, "ads_free"),
          ),
        )
        .orderBy(sql`id DESC`)
        .limit(1);

      assert.ok(audit, "a successful write must produce an audit row");
      assert.equal(audit.enabledBefore, original);
      assert.equal(audit.enabledAfter, true);

      // The write busts the cache in this process, so the change is visible now.
      assert.equal(await can(registered, "ads_free"), true);
    } finally {
      await writeCellRaw("registered", "ads_free", original);
      await db
        .delete(tierFeaturePermissionAuditTable)
        .where(eq(tierFeaturePermissionAuditTable.featureKey, "ads_free"));
    }
  });

  it("two sequential edits to the same cell record two honest transitions", async () => {
    const original = await readCell("registered", "ads_free");
    try {
      await setTierFeature("registered", "ads_free", true, null);
      const second = await setTierFeature("registered", "ads_free", false, null);
      assert.equal(second.enabledBefore, true, "the second edit must see the first's value");

      const rows = await db
        .select({
          before: tierFeaturePermissionAuditTable.enabledBefore,
          after: tierFeaturePermissionAuditTable.enabledAfter,
        })
        .from(tierFeaturePermissionAuditTable)
        .where(eq(tierFeaturePermissionAuditTable.featureKey, "ads_free"))
        .orderBy(tierFeaturePermissionAuditTable.id);

      assert.equal(rows.length, 2);
      assert.equal(rows[1]!.before, true);
      assert.equal(rows[1]!.after, false);
    } finally {
      await writeCellRaw("registered", "ads_free", original);
      await db
        .delete(tierFeaturePermissionAuditTable)
        .where(eq(tierFeaturePermissionAuditTable.featureKey, "ads_free"));
    }
  });
});

// ── The wire format ──────────────────────────────────────────────────────────

describe("wire format", () => {
  it("serializes to a plain object — a native Map would go out as {}", async () => {
    const { entitlements } = await resolveEntitlements(legendary);
    const wire = toWireEntitlements(entitlements);
    assert.equal(JSON.stringify(new Map([["a", 1]])), "{}", "premise: Maps serialize to {}");
    const parsed = JSON.parse(JSON.stringify(wire)) as Record<string, { allowed: boolean; limit: number | null }>;
    for (const key of FEATURE_KEYS) {
      assert.ok(key in parsed, `${key} missing from the wire payload`);
      assert.equal(typeof parsed[key]!.allowed, "boolean");
      assert.equal(parsed[key]!.limit, null, "every feature in this plan is boolean");
    }
  });
});

// ── Test 20 — migration observability ────────────────────────────────────────

describe("migration observability", () => {
  it("the backfill is idempotent and honours the engine_experiments exception", async () => {
    // Invokes the backfill DIRECTLY, twice — which the hash-tracking migration
    // runner never does on a normal deploy, so idempotency is otherwise
    // unproven. Deliberately does NOT assert on the migration's own log row:
    // test worker databases are cloned structure-plus-reference-data, so run
    // history from the source database is legitimately absent there, and
    // asserting it would test the harness rather than the backfill.
    const runBackfill = async (name: string) => {
      const { rows } = await db.execute<{
        inserted_count: number;
        already_complete_count: number;
        engine_experiments_skipped_count: number;
      }>(sql`SELECT * FROM backfill_feature_permissions(${name})`);
      return rows[0]!;
    };

    try {
      const first = await runBackfill("test-idempotency-1");
      const second = await runBackfill("test-idempotency-2");

      assert.equal(
        Number(second.inserted_count),
        0,
        "a second run must insert nothing — the first run closed every gap",
      );
      assert.equal(
        Number(second.engine_experiments_skipped_count),
        Number(first.engine_experiments_skipped_count),
        "the deliberate exception must be honoured identically on a re-run",
      );
      assert.ok(
        Number(second.already_complete_count) >= Number(first.already_complete_count),
        "already_complete_count RISES on a re-run — the features the first run " +
          "repaired are, by definition, complete on the second. Asserting it " +
          "unchanged would be wrong.",
      );

      // All three counts are recorded durably, because the migration runner
      // discards statement result rows and skips by hash on a re-run.
      const { rows: logged } = await db.execute<{ n: string | number }>(sql`
        SELECT count(*) AS n FROM feature_permissions_migration_log
        WHERE migration_name IN ('test-idempotency-1', 'test-idempotency-2')
      `);
      assert.equal(Number(logged[0]!.n), 2, "each invocation logs its own row");
    } finally {
      await db.execute(sql`
        DELETE FROM feature_permissions_migration_log
        WHERE migration_name IN ('test-idempotency-1', 'test-idempotency-2')
      `);
    }
  });
});
