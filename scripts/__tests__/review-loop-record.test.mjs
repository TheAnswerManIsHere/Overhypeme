import { test } from "node:test";
import assert from "node:assert/strict";

import { assertAdjudicationSnapshot, buildRecord } from "../review-loop-record.mjs";

// ---------------------------------------------------------------------------
// assertAdjudicationSnapshot: the evidence-freshness gate added in PR #539
// round 3 -- a record's own analysis is only as current as the issueComments
// it actually read, so that capture time must be present and parseable
// before anything downstream trusts it.
// ---------------------------------------------------------------------------

const validSnapshot = () => ({
  pr: { number: 500 },
  repo: "TheAnswerManIsHere/Overhypeme",
  issueComments: [],
  complete: { issueComments: true },
  capturedAt: { issueComments: "2026-08-19T21:00:00Z" },
});

test("assertAdjudicationSnapshot: a snapshot with no capturedAt.issueComments is rejected", () => {
  const snap = validSnapshot();
  delete snap.capturedAt;
  assert.throws(() => assertAdjudicationSnapshot(500, snap), /parseable capturedAt\.issueComments/);
});

test("assertAdjudicationSnapshot: an unparseable capturedAt.issueComments is rejected", () => {
  const snap = validSnapshot();
  snap.capturedAt.issueComments = "not a date";
  assert.throws(() => assertAdjudicationSnapshot(500, snap), /parseable capturedAt\.issueComments/);
});

test("assertAdjudicationSnapshot: a well-formed snapshot passes", () => {
  assert.doesNotThrow(() => assertAdjudicationSnapshot(500, validSnapshot()));
});

// ---------------------------------------------------------------------------
// buildRecord: evidenceCapturedAt and budget.ambiguous, exercised end to end
// against a minimal but real MCP snapshot shape (review-counting.mjs's own
// assertions run inside fromMcp -- constructing a fixture that satisfies
// them for real is worth more than hand-guessing the shape).
// ---------------------------------------------------------------------------

const minimalSnapshot = ({ issueComments = [], reviews = [] } = {}) => ({
  pr: { number: 500, title: "test", created_at: "2026-08-01T00:00:00Z", closed_at: null, head: { sha: null } },
  repo: "TheAnswerManIsHere/Overhypeme",
  reviews,
  files: [],
  reviewThreads: [],
  issueComments,
  complete: { reviews: true, files: true, reviewThreads: true, issueComments: true },
  capturedAt: { issueComments: "2026-08-19T21:00:00Z" },
});

// `loadLoop` needs a real io/filesystem; buildRecord only needs its RETURN
// shape, so a minimal valid budgetState is constructed directly rather than
// exercising the guard's own file discovery here (that's review-budget.test.mjs's job).
const minimalBudgetState = () => ({
  tier: "product",
  budget: { budget: 3, criticality: 10, artifact: "x" },
  extensions: [],
  nextSeq: 1,
});

test("buildRecord: evidenceCapturedAt is the snapshot's own issueComments capture time, not generatedAt", () => {
  const snapshot = minimalSnapshot();
  const record = buildRecord({
    pr: 500,
    snapshot,
    derived: { pr: snapshot.pr, reviews: [], files: [], comments: [], issueComments: [] },
    budgetState: minimalBudgetState(),
    changes: { resolved: false, reason: "test -- no diff needed for this assertion" },
    now: "2026-08-19T22:00:00Z", // deliberately LATER than the snapshot's capture time
  });
  assert.equal(record.evidenceCapturedAt, "2026-08-19T21:00:00Z");
  assert.equal(record.generatedAt, "2026-08-19T22:00:00Z");
  assert.notEqual(record.evidenceCapturedAt, record.generatedAt);
});

test("buildRecord: budget.ambiguous is threaded through from countRounds, not silently dropped", () => {
  // A trigger comment and the last completed pass sharing the exact same
  // second is what countRounds flags ambiguous -- construct that shape
  // directly via issueComments/reviews rather than re-deriving countRounds'
  // own logic here.
  const tie = "2026-08-19T20:00:00Z";
  const snapshot = minimalSnapshot({
    issueComments: [{ user: { login: "someone" }, body: "@codex review", created_at: tie }],
    reviews: [
      {
        user: { login: "chatgpt-codex-connector" },
        body: "**Reviewed commit:** `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
        submitted_at: tie,
      },
    ],
  });
  const record = buildRecord({
    pr: 500,
    snapshot,
    derived: {
      pr: snapshot.pr,
      reviews: snapshot.reviews,
      files: [],
      comments: [],
      issueComments: snapshot.issueComments,
    },
    budgetState: minimalBudgetState(),
    changes: { resolved: false, reason: "test -- no diff needed for this assertion" },
    now: "2026-08-19T22:00:00Z",
  });
  assert.equal(record.budget.ambiguous, true);
  // And the non-ambiguous case doesn't regress: a request answered well
  // before generation reports ambiguous: false.
  const clean = buildRecord({
    pr: 500,
    snapshot: minimalSnapshot(),
    derived: { pr: snapshot.pr, reviews: [], files: [], comments: [], issueComments: [] },
    budgetState: minimalBudgetState(),
    changes: { resolved: false, reason: "test" },
    now: "2026-08-19T22:00:00Z",
  });
  assert.equal(clean.budget.ambiguous, false);
});
