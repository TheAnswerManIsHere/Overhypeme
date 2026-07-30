/**
 * The relationships between the quantities, not the quantities themselves.
 *
 * Individually every default here is defensible. The defect lived in a PAIR: a
 * lease shorter than the retrieval it must outlive. So these tests assert the
 * RELATIONSHIPS hold, and that they are enforced from BOTH sides — a relational
 * invariant checked on one side only is not enforced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMBERSHIP_CONFIG_DEFAULTS,
  RETRIEVAL_PHASE_BUDGET_MS,
  RetrievalBudgetExceededError,
  applyBudgetMs,
  backoffSumMs,
  isMembershipConfigKey,
  minimumLeaseTtlSeconds,
  retrievalBudgetMs,
  singleRequestBudgetMs,
  startRetrievalDeadline,
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

  it("bounds ONE request at the request timeout, with no retry to make it unprovable", () => {
    // Retries are off precisely so this number is derivable: with them on, the
    // SDK honours a server `Retry-After` of up to 60s that no local constant
    // bounds, so a "22s" request could really run ~80s.
    assert.equal(singleRequestBudgetMs(), 10_000);
  });

  it("budgets the retrieval PHASE, not one request — the lease outlives the phase", () => {
    // The distinction that matters: a prepare issues many requests under one
    // lease (subscription + paginated items + a product per item, and for
    // past_due three more lists), so a per-request number was never the thing
    // the lease had to clear.
    assert.equal(retrievalBudgetMs(), RETRIEVAL_PHASE_BUDGET_MS);
    assert.ok(
      retrievalBudgetMs() > singleRequestBudgetMs(),
      "a phase budget that could not fit even two requests would be the same bug again",
    );
  });

  it("bounds the apply at the lock timeout times attempts, plus backoff", () => {
    assert.equal(applyBudgetMs(), 3_000 * 3 + 300);
  });

  it("derives a lease floor the default clears — but only just", () => {
    const floor = minimumLeaseTtlSeconds();
    // (45s phase + 9.3s apply) -> 55s rounded up, x1.5 margin.
    assert.equal(floor, 83);
    assert.ok(
      DEFAULTS.lease_ttl_seconds >= floor,
      "the default lease must satisfy its own derived floor",
    );
    assert.ok(DEFAULTS.lease_ttl_seconds - floor < 20, "and it is not comfortable");
  });
});

describe("the retrieval deadline — what makes the phase budget true rather than claimed", () => {
  it("permits requests while a FULL single-request budget remains", () => {
    const deadline = startRetrievalDeadline(Date.now());
    assert.doesNotThrow(() => deadline.assertCanIssue("first"));
  });

  it("refuses once too little remains for one request to finish inside the budget", () => {
    // The load-bearing case. At this instant there is still time on the clock —
    // a naive "is any time left" check would wave the request through, and that
    // request could then run a further 22s and put the phase outside the number
    // the lease TTL was derived from.
    const remaining = singleRequestBudgetMs() - 1;
    const startedAt = Date.now() - (RETRIEVAL_PHASE_BUDGET_MS - remaining);
    const deadline = startRetrievalDeadline(startedAt);

    assert.ok(deadline.remainingMs() > 0, "time is left on the clock");
    assert.throws(() => deadline.assertCanIssue("charges.list"), RetrievalBudgetExceededError);
  });

  it("names the step it died on, so an exhausted phase is diagnosable", () => {
    const deadline = startRetrievalDeadline(Date.now() - RETRIEVAL_PHASE_BUDGET_MS);
    assert.throws(
      () => deadline.assertCanIssue("subscriptionItems.list"),
      /subscriptionItems\.list/,
    );
  });

  it("cannot report negative remaining time once spent", () => {
    const deadline = startRetrievalDeadline(Date.now() - RETRIEVAL_PHASE_BUDGET_MS * 3);
    assert.equal(deadline.remainingMs(), 0);
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
    assert.match(error, /lease_ttl_seconds must be at least 83s/);
    accepts("lease_ttl_seconds", minimumLeaseTtlSeconds());
    rejects("lease_ttl_seconds", minimumLeaseTtlSeconds() - 1);
  });

  it("rejects a waiter timeout that outlives the lease it waits for", () => {
    rejects("lease_waiter_timeout_seconds", DEFAULTS.lease_ttl_seconds);
    accepts("lease_waiter_timeout_seconds", DEFAULTS.lease_ttl_seconds - 1);
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

