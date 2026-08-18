/**
 * Plan 1a tests 13 and 14 — the custom-avatar gate and the effective-avatar
 * projection.
 *
 * Two distinct claims are under test and they are easy to conflate:
 *
 *   • The GATE is at the display selection, never at the photo upload. Storing
 *     a photo stays entitlement-free, because the upload routes are the shared
 *     onboarding flow and the stored image is the identity photo PuLID meme and
 *     video generation consume.
 *   • The PROJECTION decides which image is public, live, for the SUBJECT's
 *     entitlement — so a lapsed account and a legacy row both revert to the
 *     generated icon with no data migration.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, tierFeaturePermissionsTable } from "@workspace/db/schema";
import { and, eq, like } from "drizzle-orm";

import {
  effectiveAvatarUrl,
  effectiveAvatarUrls,
  generatedIconUrl,
  type AvatarSubject,
} from "../lib/effectiveAvatar.js";
import { _resetEntitlementCacheForTest } from "../lib/featureAccess.js";

const PREFIX = "tavatar-";
const PHOTO = "/api/storage/objects/uploads/identity-photo.jpg";

function subject(overrides: Partial<AvatarSubject> & { id: string }): AvatarSubject {
  return {
    profileImageUrl: null,
    avatarSource: "avatar",
    avatarStyle: "bottts",
    membershipTier: "registered",
    isRealAdmin: false,
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(cleanup);
after(cleanup);
beforeEach(() => { _resetEntitlementCacheForTest(); });

// ── Test 14 — the projection ─────────────────────────────────────────────────

describe("the effective-avatar projection", () => {
  it("shows an entitled user's selected photo", async () => {
    const url = await effectiveAvatarUrl(
      subject({ id: "u1", profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "legendary" }),
    );
    assert.equal(url, PHOTO);
  });

  it("shows the generated icon for a stored photo that was never selected", async () => {
    // The pre-existing facts.ts leak: `avatarSource` was ignored entirely, so
    // an identity photo uploaded for meme generation appeared publicly.
    const url = await effectiveAvatarUrl(
      subject({ id: "u2", profileImageUrl: PHOTO, avatarSource: "avatar", membershipTier: "legendary" }),
    );
    assert.equal(url, generatedIconUrl("bottts", "u2"));
  });

  it("shows the generated icon for a selected photo without the entitlement", async () => {
    // A legacy row from today's ungated writes.
    const url = await effectiveAvatarUrl(
      subject({ id: "u3", profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "registered" }),
    );
    assert.equal(url, generatedIconUrl("bottts", "u3"));
  });

  it("reverts a lapsed account to the generated icon with no migration", async () => {
    // Identical row to the entitled case above; only the tier moved.
    const lapsed = subject({
      id: "u4",
      profileImageUrl: PHOTO,
      avatarSource: "photo",
      membershipTier: "registered",
    });
    assert.equal(await effectiveAvatarUrl(lapsed), generatedIconUrl("bottts", "u4"));
  });

  it("resolves the SUBJECT's entitlement — an admin subject gets the overlay", async () => {
    const url = await effectiveAvatarUrl(
      subject({
        id: "u5",
        profileImageUrl: PHOTO,
        avatarSource: "photo",
        membershipTier: "registered",
        isRealAdmin: true,
      }),
    );
    assert.equal(url, PHOTO, "the admin row grants custom_avatar via the union");
  });

  it("falls back to the generated icon when avatarSource is photo but no photo is stored", async () => {
    const url = await effectiveAvatarUrl(
      subject({ id: "u6", profileImageUrl: null, avatarSource: "photo", membershipTier: "legendary" }),
    );
    assert.equal(url, generatedIconUrl("bottts", "u6"));
  });

  it("honours the chosen avatar style, and defaults when unset", async () => {
    assert.equal(
      await effectiveAvatarUrl(subject({ id: "u7", avatarStyle: "adventurer" })),
      generatedIconUrl("adventurer", "u7"),
    );
    assert.equal(
      await effectiveAvatarUrl(subject({ id: "u8", avatarStyle: null })),
      generatedIconUrl("bottts", "u8"),
    );
  });

  it("batches over a set of subjects, resolving each independently", async () => {
    const map = await effectiveAvatarUrls([
      subject({ id: "b1", profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "legendary" }),
      subject({ id: "b2", profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "registered" }),
      subject({ id: "b3", profileImageUrl: PHOTO, avatarSource: "avatar", membershipTier: "legendary" }),
    ]);
    assert.equal(map.get("b1"), PHOTO);
    assert.equal(map.get("b2"), generatedIconUrl("bottts", "b2"));
    assert.equal(map.get("b3"), generatedIconUrl("bottts", "b3"));
  });

  it("falls closed when the grid denies — a revoked custom_avatar hides the photo", async () => {
    const original = await db
      .select({ enabled: tierFeaturePermissionsTable.enabled })
      .from(tierFeaturePermissionsTable)
      .where(
        and(
          eq(tierFeaturePermissionsTable.tier, "legendary"),
          eq(tierFeaturePermissionsTable.featureKey, "custom_avatar"),
        ),
      )
      .limit(1);

    try {
      await db
        .update(tierFeaturePermissionsTable)
        .set({ enabled: false })
        .where(
          and(
            eq(tierFeaturePermissionsTable.tier, "legendary"),
            eq(tierFeaturePermissionsTable.featureKey, "custom_avatar"),
          ),
        );
      _resetEntitlementCacheForTest();

      const url = await effectiveAvatarUrl(
        subject({ id: "u9", profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "legendary" }),
      );
      assert.equal(url, generatedIconUrl("bottts", "u9"), "revoking the row must hide the photo live");
    } finally {
      await db
        .update(tierFeaturePermissionsTable)
        .set({ enabled: original[0]?.enabled ?? true })
        .where(
          and(
            eq(tierFeaturePermissionsTable.tier, "legendary"),
            eq(tierFeaturePermissionsTable.featureKey, "custom_avatar"),
          ),
        );
      _resetEntitlementCacheForTest();
    }
  });
});

// ── The identity photo stays available to the studio ─────────────────────────

describe("profileImageUrl remains a private field", () => {
  it("the stored photo is untouched by the projection", async () => {
    const id = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@example.test`,
      profileImageUrl: PHOTO,
      avatarSource: "photo",
      membershipTier: "registered",
    });

    // Unentitled, so the public projection hides it...
    assert.equal(
      await effectiveAvatarUrl(
        subject({ id, profileImageUrl: PHOTO, avatarSource: "photo", membershipTier: "registered" }),
      ),
      generatedIconUrl("bottts", id),
    );

    // ...but the row the studio and PuLID paths read is unchanged. Gating the
    // DISPLAY must never remove the identity photo those pipelines consume.
    const [row] = await db
      .select({ profileImageUrl: usersTable.profileImageUrl })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    assert.equal(row!.profileImageUrl, PHOTO);
  });
});
