/**
 * Unit tests for the membership derivation.
 *
 * Pure — no database, no Stripe. `deriveEffectiveMembership` and
 * `effectiveTierForRow` are the two halves of the policy, and both are
 * time-parameterised so every boundary is asserted by moving a bound clock
 * rather than by waiting.
 *
 * The cases here are the plan's acceptance criteria, not a sample of them. In
 * particular: an active NON-allowlisted subscription must not carry the tier
 * either alone or alongside a valid source (encoding only the lifecycle term
 * would make every active subscription qualify), and a lost chargeback must
 * survive a refresh that reports the subscription `active`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveEffectiveMembership,
  effectiveTierForRow,
  qualifySource,
  GRACE_WINDOW_DAYS,
  type EntitlementSourceSnapshot,
} from "../lib/membershipState";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const DAY = 24 * 60 * 60 * 1000;

let nextId = 1;

function source(over: Partial<EntitlementSourceSnapshot> = {}): EntitlementSourceSnapshot {
  return {
    id: nextId++,
    sourceType: "stripe_subscription",
    isMembershipProduct: true,
    lifecycleStatus: "active",
    graceExpiresAt: null,
    disputeLossRevokedAt: null,
    hasOpenDispute: false,
    ...over,
  };
}

const lifetime = (over: Partial<EntitlementSourceSnapshot> = {}) =>
  source({ sourceType: "stripe_lifetime_payment", lifecycleStatus: "active", ...over });

const adminGrant = (over: Partial<EntitlementSourceSnapshot> = {}) =>
  source({
    sourceType: "admin_grant",
    isMembershipProduct: null,
    lifecycleStatus: "active",
    ...over,
  });

describe("qualifySource — the four-term conjunction", () => {
  it("requires the allowlist for both Stripe source types", () => {
    for (const sourceType of ["stripe_subscription", "stripe_lifetime_payment"] as const) {
      const result = qualifySource(
        source({ sourceType, isMembershipProduct: false, lifecycleStatus: "active" }),
        NOW,
      );
      assert.equal(result.qualifies, false, `${sourceType} outside the allowlist`);
      assert.equal(result.reason, "not_membership_product");
    }
  });

  it("qualifies an admin grant without an allowlist answer — W1b authorizes it", () => {
    assert.equal(qualifySource(adminGrant(), NOW).qualifies, true);
  });

  it("holds access while a non-terminal dispute exists, on any source type", () => {
    for (const built of [source(), lifetime(), adminGrant()]) {
      const result = qualifySource({ ...built, hasOpenDispute: true }, NOW);
      assert.equal(result.qualifies, false);
      assert.equal(result.reason, "access_hold");
    }
  });

  it("disqualifies permanently on a lost chargeback, even when the provider says active", () => {
    // The case an earlier revision would have failed: the refresh reports the
    // subscription `active`, and the revocation must still hold.
    const result = qualifySource(
      source({ lifecycleStatus: "active", disputeLossRevokedAt: at(-DAY) }),
      NOW,
    );
    assert.equal(result.qualifies, false);
    assert.equal(result.reason, "dispute_loss");
  });

  it("ranks the terms so the first failure is the reported reason", () => {
    // A source failing several terms at once reports the allowlist, which is the
    // outermost boundary — not the dispute, which is incidental to a source that
    // was never eligible.
    const result = qualifySource(
      source({
        isMembershipProduct: false,
        hasOpenDispute: true,
        disputeLossRevokedAt: at(-DAY),
        lifecycleStatus: "canceled",
      }),
      NOW,
    );
    assert.equal(result.reason, "not_membership_product");
  });
});

describe("qualifySource — subscription lifecycle", () => {
  it("qualifies active and trialing outright, with no horizon", () => {
    for (const lifecycleStatus of ["active", "trialing"]) {
      const result = qualifySource(source({ lifecycleStatus }), NOW);
      assert.equal(result.qualifies, true, lifecycleStatus);
      assert.equal(result.validUntil, null);
    }
  });

  it("does not qualify unpaid, canceled, incomplete, incomplete_expired or paused", () => {
    for (const lifecycleStatus of [
      "unpaid",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "paused",
    ]) {
      const result = qualifySource(source({ lifecycleStatus }), NOW);
      assert.equal(result.qualifies, false, lifecycleStatus);
      assert.equal(result.reason, "lifecycle");
    }
  });

  it("qualifies past_due strictly inside the grace window and not on the deadline", () => {
    const deadline = at(DAY);
    const pastDue = source({ lifecycleStatus: "past_due", graceExpiresAt: deadline });

    const inside = qualifySource(pastDue, at(DAY - 1));
    assert.equal(inside.qualifies, true);
    assert.deepEqual(inside.validUntil, deadline);

    // At the deadline, not after it: the horizon is the last moment it qualifies.
    assert.equal(qualifySource(pastDue, deadline).qualifies, false);
    assert.equal(qualifySource(pastDue, deadline).reason, "grace_expired");
    assert.equal(qualifySource(pastDue, at(DAY + 1)).qualifies, false);
  });

  it("keeps a past_due source qualifying when the first attempt was unresolvable", () => {
    // No deadline is derived rather than a guessed one: a guessed start can only
    // be early, and early means revoking a paying customer. The case is reported
    // by the caller; the derivation must not revoke.
    const unresolvable = source({ lifecycleStatus: "past_due", graceExpiresAt: null });
    const result = qualifySource(unresolvable, at(365 * DAY));
    assert.equal(result.qualifies, true);
    assert.equal(result.validUntil, null);
  });

  it("bounds grace at 14 days", () => {
    assert.equal(GRACE_WINDOW_DAYS, 14);
  });
});

describe("deriveEffectiveMembership — set union, not priority", () => {
  it("is non-qualifying with no sources at all", () => {
    const derived = deriveEffectiveMembership([], NOW);
    assert.equal(derived.tier, "registered");
    assert.deepEqual(derived.qualifyingSourceIds, []);
    assert.equal(derived.validUntil, null);
  });

  it("never returns unregistered — that is an auth state, not an entitlement one", () => {
    assert.equal(deriveEffectiveMembership([source({ lifecycleStatus: "canceled" })], NOW).tier, "registered");
  });

  it("qualifies on any one source, regardless of the others", () => {
    const good = lifetime();
    const derived = deriveEffectiveMembership(
      [source({ lifecycleStatus: "canceled" }), good, adminGrant({ lifecycleStatus: "revoked" })],
      NOW,
    );
    assert.equal(derived.tier, "legendary");
    assert.deepEqual(derived.qualifyingSourceIds, [good.id]);
  });

  it("does NOT qualify on an active non-allowlisted subscription, alone", () => {
    const derived = deriveEffectiveMembership(
      [source({ isMembershipProduct: false, lifecycleStatus: "active" })],
      NOW,
    );
    assert.equal(derived.tier, "registered");
  });

  it("does NOT let an active non-allowlisted subscription carry the tier alongside a valid source", () => {
    const valid = lifetime();
    const bogus = source({ isMembershipProduct: false, lifecycleStatus: "active" });

    const withBoth = deriveEffectiveMembership([valid, bogus], NOW);
    assert.equal(withBoth.tier, "legendary");
    assert.deepEqual(withBoth.qualifyingSourceIds, [valid.id], "only the valid source carries it");

    // Removing the valid one drops the user — the bogus source never carried it.
    assert.equal(deriveEffectiveMembership([bogus], NOW).tier, "registered");
  });

  it("holds only the disputed source, not the user's other entitlement", () => {
    const disputed = source({ hasOpenDispute: true });
    const clean = lifetime();
    const derived = deriveEffectiveMembership([disputed, clean], NOW);
    assert.equal(derived.tier, "legendary");
    assert.deepEqual(derived.qualifyingSourceIds, [clean.id]);
    assert.equal(derived.reasons.get(disputed.id), "access_hold");
  });
});

describe("deriveEffectiveMembership — the horizon over the whole qualifying set", () => {
  it("is null when any qualifying source is indefinitely valid", () => {
    // The concrete coexistence case: a lifetime entitlement alongside a past-due
    // subscription. Writing the subscription's deadline would revoke a user who
    // holds a source that never expires.
    const derived = deriveEffectiveMembership(
      [lifetime(), source({ lifecycleStatus: "past_due", graceExpiresAt: at(DAY) })],
      NOW,
    );
    assert.equal(derived.tier, "legendary");
    assert.equal(derived.validUntil, null);
    assert.equal(derived.qualifyingSourceIds.length, 2);
  });

  it("keeps a lifetime + past-due user Legendary past the subscription deadline", () => {
    const sources = [
      lifetime(),
      source({ lifecycleStatus: "past_due", graceExpiresAt: at(DAY) }),
    ];
    const after = deriveEffectiveMembership(sources, at(30 * DAY));
    assert.equal(after.tier, "legendary");
    assert.equal(after.validUntil, null);
  });

  it("takes the LATER of two grace deadlines, not the earlier", () => {
    const early = at(DAY);
    const late = at(5 * DAY);
    const derived = deriveEffectiveMembership(
      [
        source({ lifecycleStatus: "past_due", graceExpiresAt: early }),
        source({ lifecycleStatus: "past_due", graceExpiresAt: late }),
      ],
      NOW,
    );
    assert.equal(derived.tier, "legendary");
    assert.deepEqual(derived.validUntil, late);
  });

  it("expires two past-due subscriptions at the later of the two", () => {
    const sources = [
      source({ lifecycleStatus: "past_due", graceExpiresAt: at(DAY) }),
      source({ lifecycleStatus: "past_due", graceExpiresAt: at(5 * DAY) }),
    ];
    // Past the first deadline, still Legendary on the second.
    const between = deriveEffectiveMembership(sources, at(2 * DAY));
    assert.equal(between.tier, "legendary");
    assert.deepEqual(between.validUntil, at(5 * DAY));

    // Past both, dropped.
    assert.equal(deriveEffectiveMembership(sources, at(6 * DAY)).tier, "registered");
  });

  it("is null when nothing qualifies, even with grace timestamps present", () => {
    const derived = deriveEffectiveMembership(
      [source({ lifecycleStatus: "past_due", graceExpiresAt: at(-DAY) })],
      NOW,
    );
    assert.equal(derived.tier, "registered");
    assert.equal(derived.validUntil, null);
  });
});

describe("effectiveTierForRow — expiry may only demote, and only from legendary", () => {
  it("demotes a lapsed legendary to registered", () => {
    assert.equal(
      effectiveTierForRow({ membershipTier: "legendary", membershipValidUntil: at(-1) }, NOW),
      "registered",
    );
  });

  it("demotes exactly at the horizon, not a moment later", () => {
    const row = { membershipTier: "legendary" as const, membershipValidUntil: NOW };
    assert.equal(effectiveTierForRow(row, at(-1)), "legendary");
    assert.equal(effectiveTierForRow(row, NOW), "registered");
  });

  it("leaves a legendary row with no horizon alone", () => {
    assert.equal(
      effectiveTierForRow({ membershipTier: "legendary", membershipValidUntil: null }, NOW),
      "legendary",
    );
  });

  it("never PROMOTES an unregistered row carrying a stale horizon", () => {
    // Without the `membership_tier = 'legendary'` conjunct this would silently
    // read as `registered`.
    assert.equal(
      effectiveTierForRow({ membershipTier: "unregistered", membershipValidUntil: at(-DAY) }, NOW),
      "unregistered",
    );
  });

  it("leaves a registered row alone in both directions", () => {
    assert.equal(
      effectiveTierForRow({ membershipTier: "registered", membershipValidUntil: at(-DAY) }, NOW),
      "registered",
    );
    assert.equal(
      effectiveTierForRow({ membershipTier: "registered", membershipValidUntil: at(DAY) }, NOW),
      "registered",
    );
  });
});
