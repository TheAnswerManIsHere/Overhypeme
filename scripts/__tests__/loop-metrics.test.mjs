import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countRounds,
  countFindings,
  findingsByRound,
  reviewInterval,
  classifyCohort,
  artifactSize,
  adjudicationSample,
  derive,
} from "../loop-metrics.mjs";

const BOT = { login: "chatgpt-codex-connector[bot]" };
const ME = { login: "TheAnswerManIsHere" };

test("a round is a reviewer review event, not an @codex review comment", () => {
  // The connector auto-reviews on open with no trigger comment, so counting
  // triggers undercounts by one. Two reviewer events = two rounds regardless
  // of how many trigger comments exist.
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
    { id: 2, user: ME, submitted_at: "2026-07-27T01:10:00Z" }, // my reply-review
    { id: 3, user: BOT, submitted_at: "2026-07-27T02:00:00Z" },
  ];
  assert.equal(countRounds(reviews), 2);
});

test("author replies never count as findings", () => {
  // Our workflow mandates a reply per thread, which roughly doubles a naive
  // comment count. PR #269: 31 comments, ~23 findings.
  const comments = [
    { id: 10, user: BOT },
    { id: 11, user: ME, in_reply_to_id: 10 },
    { id: 12, user: BOT },
    { id: 13, user: ME, in_reply_to_id: 12 },
  ];
  assert.equal(countFindings(comments), 2);
});

test("a reviewer reply on an existing thread is not a new finding", () => {
  const comments = [
    { id: 20, user: BOT },
    { id: 21, user: BOT, in_reply_to_id: 20 },
  ];
  assert.equal(countFindings(comments), 1);
});

test("re-raised findings ARE counted mechanically and left to judgment", () => {
  // Deliberate: "Reconciliation" has no machine-readable marker
  // (plan-review-contract.md names it in prose; code-review.md has no such
  // category at all), so excluding it by regex would be a guess presented as a
  // measurement. It is counted here and separated in the judgment column.
  const comments = [
    { id: 30, user: BOT, body: "**Reconciliation (6.1 — Still Open)** ..." },
    { id: 31, user: BOT, body: "New finding" },
  ];
  assert.equal(countFindings(comments), 2);
});

test("findings are attributed to the round that produced them", () => {
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
    { id: 2, user: BOT, submitted_at: "2026-07-27T02:00:00Z" },
  ];
  const comments = [
    { id: 40, user: BOT, pull_request_review_id: 1 },
    { id: 41, user: BOT, pull_request_review_id: 1 },
    { id: 42, user: BOT, pull_request_review_id: 2 },
    { id: 43, user: ME, in_reply_to_id: 40, pull_request_review_id: 1 },
  ];
  assert.deepEqual(
    findingsByRound(reviews, comments).map((r) => [r.round, r.findings]),
    [
      [1, 2],
      [2, 1],
    ],
  );
});

test("review interval is one window, never a sum", () => {
  // An earlier design summed preflight duration with this window, which
  // double-counts every preflight occurring after the PR opened.
  const pr = { created_at: "2026-07-27T00:00:00Z" };
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T02:00:00Z" },
    { id: 2, user: BOT, submitted_at: "2026-07-27T06:00:00Z" },
    { id: 3, user: ME, submitted_at: "2026-07-27T09:00:00Z" }, // mine, ignored
  ];
  assert.equal(reviewInterval(pr, reviews).hours, 6);
});

test("review interval is null when the reviewer never reviewed", () => {
  assert.equal(reviewInterval({ created_at: "2026-07-27T00:00:00Z" }, []), null);
});

test("cohort precedence is top-down, first match wins", () => {
  const plan = { title: "[PLAN REVIEW] whatever — DO NOT MERGE" };
  assert.equal(classifyCohort(plan, [{ filename: "src/a.ts" }]), "plan-review");

  // Mixed code/prose lands in prose — stricter obligations, measured risk.
  assert.equal(
    classifyCohort({ title: "Add thing" }, [
      { filename: "src/a.ts" },
      { filename: "docs/b.md" },
    ]),
    "prose/contract",
  );

  assert.equal(
    classifyCohort({ title: "Add thing" }, [{ filename: "src/a.ts" }]),
    "feature/code",
  );
  assert.equal(
    classifyCohort({ title: "fix: off-by-one" }, [{ filename: "src/a.ts" }]),
    "bugfix",
  );
});

test("a skill file counts as prose", () => {
  assert.equal(
    classifyCohort({ title: "x" }, [{ filename: ".claude/skills/bugfix/SKILL.md" }]),
    "prose/contract",
  );
});

test("artifact size keeps both dimensions", () => {
  const size = artifactSize([
    { filename: "a.md", additions: 100, deletions: 5 },
    { filename: "b.md", additions: 300, deletions: 0 },
  ]);
  assert.deepEqual(size, { files: 2, added: 400, removed: 5 });
});

test("adjudication sample is defined for small and clean loops", () => {
  // "random 30%" is undefined exactly where most loops live.
  assert.equal(adjudicationSample(0).size, 0);
  assert.equal(adjudicationSample(1).size, 1);
  assert.equal(adjudicationSample(3).size, 1);
  assert.equal(adjudicationSample(10).size, 3);
  assert.equal(adjudicationSample(40).size, 12);
});

test("derive leaves every judgment column null rather than guessing", () => {
  const row = derive({
    pr: { number: 1, title: "x", created_at: "2026-07-27T00:00:00Z" },
    reviews: [{ id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" }],
    comments: [{ id: 1, user: BOT, pull_request_review_id: 1 }],
    files: [{ filename: "a.md", additions: 1, deletions: 0 }],
  });
  assert.equal(row.rounds, 1);
  assert.equal(row.findings, 1);
  for (const v of Object.values(row.judgment)) assert.equal(v, null);
});
