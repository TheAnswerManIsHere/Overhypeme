/**
 * NCMEC eligibility and waiting-state classification — phase 3 of the CyberTipline plan.
 *
 * Pure functions, no database, no network, no clock. Phase 5 adds the worker and
 * reconciler to this file's suite; what is here now is the pair of predicates those
 * components and the admin surface will share.
 *
 * There is deliberately no backlog-audit coverage here. The ceremony was dropped on
 * 2026-08-07 (pre-activation rows are test artifacts the activation runbook deletes, not
 * a backlog to review), so a test that exercised an `unaudited_backlog` branch would be
 * asserting behavior the product must not have.
 *
 * The two properties worth more than any individual case are asserted as invariants over
 * a generated matrix rather than as hand-picked examples:
 *
 *   1. `classifyWaitingState` is **exhaustive and disjoint** over non-final rows — it
 *      returns exactly one of the seven labels for every combination, including the
 *      overlapping ones (disabled *and* test mode) that made an earlier
 *      independent-predicate design unsatisfiable.
 *   2. The classifier and `isSubmittable` **agree**: a row is classified as active work
 *      (`in_flight` / `awaiting_reconciliation`) if and only if `isSubmittable` accepts
 *      it. Two functions encoding the same eligibility, drifting apart silently, is the
 *      failure this phase exists to prevent by having one of each.
 *
 * A per-case table would pass while those two properties were false, because a table only
 * checks the cases somebody thought to write down.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RECOVER_STUCK_CUTOFF_MIN } from "../lib/asyncJobs.js";
import {
  NCMEC_SEQUENCE_DEADLINE_MS,
  NCMEC_WAITING_ON_A_PERSON,
  NCMEC_WAITING_STATES,
  type NcmecEligibilityConfig,
  type NcmecSubmitJobState,
  type NcmecWaitingState,
  type NcmecWaitingStateRow,
  classifyWaitingState,
  isIdentityUnresolved,
  isSubmittable,
} from "../lib/moderation/ncmecWorker.js";

/** A zeroed tally over every declared waiting state, so a missed branch shows as 0. */
function zeroedCounts(): Record<NcmecWaitingState, number> {
  return Object.fromEntries(NCMEC_WAITING_STATES.map((s) => [s, 0])) as Record<
    NcmecWaitingState,
    number
  >;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Enabled, production — the configuration in which reports actually file. */
const LIVE: NcmecEligibilityConfig = {
  submissionEnabled: true,
  environment: "production",
};

/** A row with nothing standing in its way: an uploader snapshot, no test attempt. */
function eligibleRow(overrides: Partial<NcmecWaitingStateRow> = {}): NcmecWaitingStateRow {
  return {
    submissionStatus: "pending",
    reporterSnapshot: { userId: "u_1", email: "someone@example.com" },
    userId: "u_1",
    testSubmissionStartedAt: null,
    testReportId: null,
    testSubmittedAt: null,
    ...overrides,
  };
}

const LIVE_JOB: NcmecSubmitJobState = { status: "pending" };

// ─── isIdentityUnresolved ───────────────────────────────────────────────────

describe("isIdentityUnresolved", () => {
  it("matches a row with an account attached but no snapshot — a capture defect", () => {
    assert.equal(isIdentityUnresolved({ reporterSnapshot: null, userId: "u_1" }), true);
  });

  it("does not match an anonymous row — there is no identity to capture", () => {
    assert.equal(isIdentityUnresolved({ reporterSnapshot: null, userId: null }), false);
  });

  it("does not match a row that has a snapshot", () => {
    assert.equal(
      isIdentityUnresolved({ reporterSnapshot: { userId: "u_1" }, userId: "u_1" }),
      false,
    );
  });
});

// ─── isSubmittable ──────────────────────────────────────────────────────────

describe("isSubmittable", () => {
  it("accepts an identity-resolved row in enabled production", () => {
    assert.deepEqual(isSubmittable(eligibleRow(), LIVE), { submittable: true });
  });

  it("accepts an anonymous row — honest omission is the correct filing for it", () => {
    assert.deepEqual(
      isSubmittable(eligibleRow({ reporterSnapshot: null, userId: null }), LIVE),
      { submittable: true },
    );
  });

  it("refuses a disabled deployment reversibly, so the row keeps its place", () => {
    const result = isSubmittable(eligibleRow(), { ...LIVE, submissionEnabled: false });
    assert.equal(result.submittable, false);
    assert.equal(result.refusal.class, "reversible");
    assert.equal(result.refusal.code, "submission_disabled");
  });

  it("refuses a non-production environment reversibly", () => {
    const result = isSubmittable(eligibleRow(), { ...LIVE, environment: "test" });
    assert.equal(result.submittable, false);
    assert.equal(result.refusal.class, "reversible");
    assert.equal(result.refusal.code, "environment_not_production");
  });

  it("refuses a capture-defect row REVERSIBLY — parked for a human, never auto-filed (G5)", () => {
    // Classed terminal, phase 5's worker would finalize this row `failed` — an alert fired
    // for a report that was never in trouble, over a defect in our own capture code.
    const result = isSubmittable(eligibleRow({ reporterSnapshot: null }), LIVE);
    assert.equal(result.submittable, false);
    assert.equal(result.refusal.class, "reversible");
    assert.equal(result.refusal.code, "identity_unresolved");
  });

  it("refuses every final status terminally, each with its own code", () => {
    const expected = [
      ["submitted", "already_submitted"],
      ["filed_manually", "filed_manually"],
      ["not_reportable", "not_reportable"],
      ["failed", "already_failed"],
    ] as const;

    for (const [status, code] of expected) {
      const result = isSubmittable(eligibleRow({ submissionStatus: status }), LIVE);
      assert.equal(result.submittable, false, `${status} must be refused`);
      assert.equal(result.refusal.class, "terminal", `${status} must be terminal`);
      assert.equal(result.refusal.code, code);
    }
  });

  it("accepts an in_progress row — it is non-final and mid-attempt, not resolved", () => {
    assert.deepEqual(isSubmittable(eligibleRow({ submissionStatus: "in_progress" }), LIVE), {
      submittable: true,
    });
  });

  it("gives every refusal operator-facing prose distinct from its code", () => {
    // The admin surface renders `reason`; nothing branches on it. An empty or duplicated
    // string would leave an operator told only that something was refused.
    const seen = new Set<string>();
    for (const [row, config] of REFUSAL_CASES) {
      const result = isSubmittable(row, config);
      assert.equal(result.submittable, false);
      assert.ok(result.refusal.reason.length >= 10, "refusal prose must say something");
      assert.notEqual(result.refusal.reason, result.refusal.code);
      seen.add(result.refusal.reason);
    }
    assert.equal(seen.size, REFUSAL_CASES.length, "each refusal explains itself distinctly");
  });

  /**
   * Known gap G5, as a property rather than an example.
   *
   * A terminal refusal is the answer that says "this row's future is spent". If any refusal
   * that a later action could clear were classed terminal, phase 5's worker would finalize
   * a row `failed` that a config flip or an operator action would have rescued — and
   * invariant 8's promise that such rows are parked and counted would be false exactly for
   * the rows it was written to protect.
   */
  it("classes a refusal terminal only when the row is already final (G5)", () => {
    for (const { row, config } of matrix()) {
      const result = isSubmittable(row, config);
      if (result.submittable) continue;
      // Every row the matrix produces is non-final, so nothing in it may refuse terminally.
      assert.equal(
        result.refusal.class,
        "reversible",
        `a non-final row must never be refused terminally (got ${result.refusal.code})`,
      );
    }

    // And the converse: a row that IS already final is exactly what terminal reports.
    for (const status of ["submitted", "filed_manually", "failed", "not_reportable"] as const) {
      const result = isSubmittable(eligibleRow({ submissionStatus: status }), LIVE);
      assert.equal(result.submittable, false);
      assert.equal(result.refusal.class, "terminal");
    }
  });

  it("reports the per-row blocker ahead of a config switch, matching the waiting-state order", () => {
    // The two functions must tell an operator the same story about the same row: a retry
    // refused as `identity_unresolved` is the row the admin table counts under
    // `identity_unresolved`, not one it counts under `submission_disabled`.
    const off: NcmecEligibilityConfig = { submissionEnabled: false, environment: "test" };
    const result = isSubmittable(eligibleRow({ reporterSnapshot: null }), off);
    assert.equal(result.submittable, false);
    assert.equal(result.refusal.code, "identity_unresolved");
  });
});

const REFUSAL_CASES: ReadonlyArray<[NcmecWaitingStateRow, NcmecEligibilityConfig]> = [
  [eligibleRow(), { ...LIVE, submissionEnabled: false }],
  [eligibleRow(), { ...LIVE, environment: "test" }],
  [eligibleRow({ submissionStatus: "submitted" }), LIVE],
  [eligibleRow({ submissionStatus: "filed_manually" }), LIVE],
  [eligibleRow({ submissionStatus: "not_reportable" }), LIVE],
  [eligibleRow({ submissionStatus: "failed" }), LIVE],
  [eligibleRow({ reporterSnapshot: null }), LIVE],
];

// ─── classifyWaitingState ───────────────────────────────────────────────────

describe("classifyWaitingState", () => {
  it("reports the capture defect for a snapshot-less row with an account attached", () => {
    assert.equal(
      classifyWaitingState(eligibleRow({ reporterSnapshot: null }), null, LIVE),
      "identity_unresolved",
    );
  });

  it("reports portal inspection for a crashed send-to-test, above both test-mode branches", () => {
    // A crashed `send-to-test` leaves the start stamp with no id. Absorbed into the
    // test-mode branch it would read as "waiting for a send-to-test" — inviting exactly the
    // blind re-submission the admin surface must not encourage. It is waiting on somebody
    // looking at exttest.
    const crashed = eligibleRow({ testSubmissionStartedAt: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(
      classifyWaitingState(crashed, null, { ...LIVE, environment: "test" }),
      "test_attempt_uncertain",
    );
    assert.equal(
      classifyWaitingState(crashed, null, { environment: "test", submissionEnabled: false }),
      "test_attempt_uncertain",
    );
  });

  it("does not report portal inspection once the test attempt resolved to an id", () => {
    const resolved = eligibleRow({
      testSubmissionStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      testReportId: "T-123",
      testSubmittedAt: new Date("2026-08-02T00:01:00.000Z"),
    });
    assert.equal(
      classifyWaitingState(resolved, null, { ...LIVE, environment: "test" }),
      "test_mode_submitted",
    );
  });

  it("separates the two test-mode branches on whether a test submission happened", () => {
    const testConfig: NcmecEligibilityConfig = { ...LIVE, environment: "test" };
    assert.equal(classifyWaitingState(eligibleRow(), null, testConfig), "test_mode_not_submitted");
    assert.equal(
      classifyWaitingState(
        eligibleRow({ testSubmittedAt: new Date("2026-08-02T00:00:00.000Z") }),
        null,
        testConfig,
      ),
      "test_mode_submitted",
    );
  });

  it("reports the master switch only once the per-row blocker is clear", () => {
    const off: NcmecEligibilityConfig = { ...LIVE, submissionEnabled: false };
    assert.equal(classifyWaitingState(eligibleRow(), null, off), "submission_disabled");

    // Turning submission on does not release a per-row blocker, so a row that has one is
    // never reported as waiting on activation. Telling an operator a row waits on a switch
    // when it waits on a capture defect is the misdirection this ordering prevents.
    assert.equal(
      classifyWaitingState(eligibleRow({ reporterSnapshot: null }), null, off),
      "identity_unresolved",
    );
  });

  it("distinguishes a missing job from a live one — the row alone cannot", () => {
    const row = eligibleRow();
    assert.equal(classifyWaitingState(row, LIVE_JOB, LIVE), "in_flight");
    assert.equal(classifyWaitingState(row, { status: "processing" }, LIVE), "in_flight");
    assert.equal(classifyWaitingState(row, null, LIVE), "awaiting_reconciliation");
  });

  it("treats a terminal job as no job at all", () => {
    // An eligible row whose only job is `done` or `failed` is not being worked on. Reporting
    // it as queued or running would display the exact condition the reconciler exists to
    // repair as though the system were already handling it.
    const row = eligibleRow();
    assert.equal(classifyWaitingState(row, { status: "done" }, LIVE), "awaiting_reconciliation");
    assert.equal(classifyWaitingState(row, { status: "failed" }, LIVE), "awaiting_reconciliation");
  });

  it("throws on a final row rather than inventing a state for it", () => {
    // Returning a sentinel would let a final row vanish from counts that are supposed to be
    // exhaustive — the failure that looks like success from every surface.
    for (const status of ["submitted", "filed_manually", "failed", "not_reportable"] as const) {
      assert.throws(
        () => classifyWaitingState(eligibleRow({ submissionStatus: status }), null, LIVE),
        /only pending and in_progress rows have a waiting state/,
      );
    }
  });

  it("classifies in_progress rows, not only pending ones", () => {
    assert.equal(
      classifyWaitingState(eligibleRow({ submissionStatus: "in_progress" }), LIVE_JOB, LIVE),
      "in_flight",
    );
  });
});

// ─── The invariants the counts rest on ──────────────────────────────────────

/**
 * Every combination of the inputs the classification depends on, over both non-final
 * statuses: 2 statuses × 3 identity states × 3 test-attempt states × 2 switch states ×
 * 2 environments × 3 job states.
 */
function* matrix(): Generator<{
  row: NcmecWaitingStateRow;
  job: NcmecSubmitJobState | null;
  config: NcmecEligibilityConfig;
}> {
  const identities: Partial<NcmecWaitingStateRow>[] = [
    { reporterSnapshot: { userId: "u_1" }, userId: "u_1" },
    { reporterSnapshot: null, userId: "u_1" },
    { reporterSnapshot: null, userId: null },
  ];
  const testAttempts: Partial<NcmecWaitingStateRow>[] = [
    { testSubmissionStartedAt: null, testReportId: null, testSubmittedAt: null },
    { testSubmissionStartedAt: new Date("2026-08-02T00:00:00.000Z"), testReportId: null },
    {
      testSubmissionStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      testReportId: "T-9",
      testSubmittedAt: new Date("2026-08-02T00:01:00.000Z"),
    },
  ];
  const jobs: (NcmecSubmitJobState | null)[] = [null, { status: "pending" }, { status: "done" }];

  for (const status of ["pending", "in_progress"] as const) {
    for (const identity of identities) {
      for (const testAttempt of testAttempts) {
        for (const submissionEnabled of [true, false]) {
          for (const environment of ["production", "test"] as const) {
            for (const job of jobs) {
              yield {
                row: eligibleRow({ submissionStatus: status, ...identity, ...testAttempt }),
                job,
                config: { submissionEnabled, environment },
              };
            }
          }
        }
      }
    }
  }
}

describe("waiting-state invariants", () => {
  it("returns exactly one known label for every non-final row", () => {
    const counts = zeroedCounts();
    let total = 0;

    for (const { row, job, config } of matrix()) {
      const state = classifyWaitingState(row, job, config);
      assert.ok(
        NCMEC_WAITING_STATES.includes(state),
        `unknown waiting state ${String(state)}`,
      );
      counts[state] += 1;
      total += 1;
    }

    // Exhaustive: every case landed somewhere. Disjoint: the per-state counts sum back to
    // the case count, which they cannot do if any case were counted twice.
    assert.equal(
      Object.values(counts).reduce((a, b) => a + b, 0),
      total,
    );

    // Every branch is reachable. A branch no fixture can reach is a branch no test covers,
    // and the sum above would still balance without it.
    for (const state of NCMEC_WAITING_STATES) {
      assert.ok(counts[state] > 0, `no case reached ${state}`);
    }
  });

  it("agrees with isSubmittable, branch for branch", () => {
    // Two functions encoding the same eligibility is the drift this phase exists to
    // prevent, so the correspondence is asserted as an exact mapping rather than by
    // re-listing the branches. `test_attempt_uncertain` is the one deliberate asymmetry:
    // it is a fact about a past test attempt, not about eligibility, so a row can sit in
    // it while being perfectly submittable.
    const EXPECTED_REFUSAL: Partial<Record<NcmecWaitingState, string>> = {
      identity_unresolved: "identity_unresolved",
      submission_disabled: "submission_disabled",
      test_mode_not_submitted: "environment_not_production",
      test_mode_submitted: "environment_not_production",
    };

    for (const { row, job, config } of matrix()) {
      const state = classifyWaitingState(row, job, config);
      const verdict = isSubmittable(row, config);

      if (state === "in_flight" || state === "awaiting_reconciliation") {
        assert.equal(verdict.submittable, true, `${state} must imply submittable`);
        continue;
      }

      if (state === "test_attempt_uncertain") continue;

      assert.equal(verdict.submittable, false, `${state} must imply a refusal`);
      assert.equal(
        verdict.submittable === false && verdict.refusal.code,
        EXPECTED_REFUSAL[state],
        `waiting state ${state} must correspond to its own refusal`,
      );
    }
  });

  it("never reports a submittable row as waiting on a person", () => {
    for (const { row, job, config } of matrix()) {
      if (!isSubmittable(row, config).submittable) continue;
      const state = classifyWaitingState(row, job, config);
      assert.ok(
        state === "in_flight" ||
          state === "awaiting_reconciliation" ||
          state === "test_attempt_uncertain",
        `a submittable row must not be reported as waiting on somebody (got ${state})`,
      );
    }
  });

  it("always reports a refused non-final row as waiting on a person", () => {
    for (const { row, job, config } of matrix()) {
      if (isSubmittable(row, config).submittable) continue;
      const state = classifyWaitingState(row, job, config);
      assert.ok(
        (NCMEC_WAITING_ON_A_PERSON as readonly NcmecWaitingState[]).includes(state),
        `a refused row must be reported as waiting on somebody, got ${state}`,
      );
    }
  });
});

// ─── Known gap G11 — the sequence deadline's coupling to the queue ──────────

describe("NCMEC_SEQUENCE_DEADLINE_MS", () => {
  it("stays strictly below the queue's stuck-row reclaim cutoff", () => {
    // The deadline is only safe while the queue cannot reclaim a row mid-sequence: two
    // workers running the same sequence would file the same report to a federal
    // clearinghouse twice. The cutoff has already moved once (10 -> 30 min, PR #283) and is
    // slated to stop being load-bearing when fenced finalizes land, so a future lowering is
    // plausible — and without this assertion nothing would notice it re-opening the race.
    assert.ok(
      NCMEC_SEQUENCE_DEADLINE_MS < RECOVER_STUCK_CUTOFF_MIN * 60_000,
      `the ISPWS sequence deadline (${NCMEC_SEQUENCE_DEADLINE_MS}ms) must stay strictly ` +
        `below the queue's reclaim cutoff (${RECOVER_STUCK_CUTOFF_MIN} min); lowering the ` +
        "cutoff re-opens the mid-sequence reclaim race that allows a duplicate filing",
    );
  });
});
