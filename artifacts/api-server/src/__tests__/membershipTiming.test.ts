/**
 * The relationships between the quantities, not the quantities themselves.
 *
 * Individually every default here is defensible. The defects lived in the pairs:
 * a lease shorter than the request it must outlive, a run TTL shorter than the
 * heartbeat inside it, a fractional bound fighting the absolute cap below a
 * cohort size. So these tests assert the RELATIONSHIPS hold, and that they are
 * enforced from BOTH sides — a relational invariant checked on one side only is
 * not enforced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMBERSHIP_CONFIG_DEFAULTS,
  allowedDowngrades,
  applyBudgetMs,
  backoffSumMs,
  downgradeGuardTrips,
  isMembershipConfigKey,
  minimumLeaseTtlSeconds,
  minimumRunLeaseTtlSeconds,
  retrievalBudgetMs,
  validateMembershipConfigWrite,
  type MembershipConfigKey,
} from "../lib/membershipTiming.js";

const DEFAULTS = { ...MEMBERSHIP_CONFIG_DEFAULTS } as Record<MembershipConfigKey, number>;

/** Assert a write is admissible. */
function accepts(key: MembershipConfigKey, value: number, base = DEFAULTS) {
  const error = validateMembershipConfigWrite(key, value, base);
  assert.equal(error, null, `expected ${key}=${value} to be accepted, got: ${error}`);
}

/** Assert a write is rejected, and that the message names the setting. */
function rejects(key: MembershipConfigKey, value: number, base = DEFAULTS) {
  const error = validateMembershipConfigWrite(key, value, base);
  assert.ok(error, `expected ${key}=${value} to be rejected`);
  return error;
}

describe("budget arithmetic", () => {
  it("sums the backoff sleeps between attempts, not per attempt", () => {
    // Three attempts have two sleeps: 100 then 200.
    assert.equal(backoffSumMs(100, 3), 300);
    assert.equal(backoffSumMs(100, 1), 0);
    assert.equal(backoffSumMs(100, 0), 0);
  });

  it("bounds the retrieval at the request timeout times attempts, plus retry sleep", () => {
    assert.equal(retrievalBudgetMs(), 10_000 * 2 + 2_000);
  });

  it("bounds the apply at the lock timeout times attempts, plus backoff", () => {
    assert.equal(applyBudgetMs(), 3_000 * 3 + 300);
  });

  it("derives a lease floor the 60s default clears — but only just", () => {
    const floor = minimumLeaseTtlSeconds();
    assert.equal(floor, 48);
    assert.ok(
      DEFAULTS.lease_ttl_seconds >= floor,
      "the default lease must satisfy its own derived floor",
    );
    assert.ok(DEFAULTS.lease_ttl_seconds - floor < 20, "and it is not comfortable");
  });

  it("derives a run-lease floor of three heartbeat intervals", () => {
    assert.equal(minimumRunLeaseTtlSeconds(30), 90);
    assert.ok(DEFAULTS.reconcile_run_lease_ttl_seconds >= minimumRunLeaseTtlSeconds(30));
  });
});

describe("validateMembershipConfigWrite — the lease must outlive the request", () => {
  it("accepts the shipped defaults", () => {
    for (const key of Object.keys(DEFAULTS) as MembershipConfigKey[]) {
      accepts(key, DEFAULTS[key]);
    }
  });

  it("rejects a lease below the derived floor, which admin_config's min_value alone allowed", () => {
    // The concrete regression: an operator setting 5s through the supported UI
    // and reintroducing an apply that is always fenced off.
    const error = rejects("lease_ttl_seconds", 5);
    assert.match(error, /lease_ttl_seconds must be at least 48s/);
    accepts("lease_ttl_seconds", minimumLeaseTtlSeconds());
    rejects("lease_ttl_seconds", minimumLeaseTtlSeconds() - 1);
  });

  it("rejects a waiter timeout that outlives the lease it waits for", () => {
    rejects("lease_waiter_timeout_seconds", DEFAULTS.lease_ttl_seconds);
    accepts("lease_waiter_timeout_seconds", DEFAULTS.lease_ttl_seconds - 1);
  });
});

describe("validateMembershipConfigWrite — the run lease must outlive three heartbeats", () => {
  it("rejects a TTL below the relational minimum", () => {
    const error = rejects("reconcile_run_lease_ttl_seconds", 89);
    assert.match(error, /at least 90s/);
    accepts("reconcile_run_lease_ttl_seconds", 90);
  });

  it("enforces it from the OTHER side too — raising the heartbeat is rejected", () => {
    // Enforcing one side only would let the same broken state in through the
    // other: leave the TTL at 120 and push the heartbeat to 60, and the lease no
    // longer survives a missed beat.
    const error = rejects("reconcile_heartbeat_interval_seconds", 60);
    assert.match(error, /at least 180s/);
    accepts("reconcile_heartbeat_interval_seconds", 40); // 3 x 40 = 120, exactly the TTL
    rejects("reconcile_heartbeat_interval_seconds", 41);
  });
});

describe("validateMembershipConfigWrite — the downgrade bounds", () => {
  it("rejects a fraction of exactly 0, which min_value cannot express", () => {
    // admin_config.min_value is an integer column, so the closest it gets to
    // "greater than 0" is ">= 0" — which accepts 0.
    rejects("reconcile_max_downgrade_fraction", 0);
    accepts("reconcile_max_downgrade_fraction", 0.0001);
    accepts("reconcile_max_downgrade_fraction", 1);
    rejects("reconcile_max_downgrade_fraction", 1.5);
  });

  it("rejects an allowance below 1, which disables isolated repair entirely", () => {
    rejects("reconcile_min_downgrade_allowance", 0);
    accepts("reconcile_min_downgrade_allowance", 1);
  });

  it("rejects an allowance above the absolute cap, from both sides", () => {
    rejects("reconcile_min_downgrade_allowance", DEFAULTS.reconcile_max_downgrades_per_run + 1);
    // ...and lowering the cap under the current allowance is the same defect.
    rejects("reconcile_max_downgrades_per_run", DEFAULTS.reconcile_min_downgrade_allowance - 1);
    accepts("reconcile_max_downgrades_per_run", DEFAULTS.reconcile_min_downgrade_allowance);
  });
});

describe("validateMembershipConfigWrite — sweep cadence vs alert", () => {
  it("rejects an alert that fires before the sweep could have run again", () => {
    rejects("grace_sweep_alert_after_seconds", DEFAULTS.grace_sweep_interval_seconds - 1);
    accepts("grace_sweep_alert_after_seconds", DEFAULTS.grace_sweep_interval_seconds);
  });
});

describe("isMembershipConfigKey", () => {
  it("recognises every seeded key and nothing else", () => {
    for (const key of Object.keys(DEFAULTS)) assert.ok(isMembershipConfigKey(key), key);
    assert.equal(isMembershipConfigKey("email_outbox_retention_days"), false);
    // Not fooled by inherited Object properties.
    assert.equal(isMembershipConfigKey("toString"), false);
    assert.equal(isMembershipConfigKey("constructor"), false);
  });
});

describe("allowedDowngrades — monotone in cohort size", () => {
  const cfg = {
    reconcile_max_downgrades_per_run: 50,
    reconcile_max_downgrade_fraction: 0.05,
    reconcile_min_downgrade_allowance: 3,
  };

  it("matches the worked table", () => {
    assert.equal(allowedDowngrades(1, cfg), 3);
    assert.equal(allowedDowngrades(19, cfg), 3);
    assert.equal(allowedDowngrades(100, cfg), 5);
    assert.equal(allowedDowngrades(10_000, cfg), 50);
  });

  it("never decreases as the cohort grows", () => {
    let previous = 0;
    for (let cohort = 0; cohort <= 3000; cohort += 7) {
      const allowed = allowedDowngrades(cohort, cfg);
      assert.ok(allowed >= previous, `allowance dipped at cohort ${cohort}`);
      previous = allowed;
    }
  });

  it("admits an isolated repair at every cohort size, including one", () => {
    for (const cohort of [0, 1, 2, 19, 20, 100, 10_000]) {
      assert.equal(downgradeGuardTrips(1, cohort, cfg), false, `cohort ${cohort}`);
    }
  });

  it("aborts a wipeout of any cohort larger than the allowance", () => {
    assert.equal(downgradeGuardTrips(19, 19, cfg), true);
    assert.equal(downgradeGuardTrips(100, 100, cfg), true);
    assert.equal(downgradeGuardTrips(10_000, 10_000, cfg), true);
    // The case that defeated both bounds when the denominator was users
    // EXAMINED: 40 downgrades out of 10,000 examined is 0.4% and under 50 — but
    // it is 100% of the 40 who currently qualify.
    assert.equal(downgradeGuardTrips(40, 40, cfg), true);
  });

  it("treats max as literal — the bound trips when the count EXCEEDS it", () => {
    assert.equal(downgradeGuardTrips(50, 10_000, cfg), false);
    assert.equal(downgradeGuardTrips(51, 10_000, cfg), true);
  });

  it("does not divide by zero on an empty qualifying population", () => {
    // Nothing to protect and no downgrade possible; the absolute bound still
    // applies. Treating it as a trip would wedge every run on an empty database.
    assert.equal(allowedDowngrades(0, cfg), 3);
    assert.equal(downgradeGuardTrips(0, 0, cfg), false);
  });
});
