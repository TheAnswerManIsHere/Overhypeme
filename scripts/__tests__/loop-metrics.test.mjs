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
  gh,
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

test("scoped conventional-commit fix titles are recognized as bugfix", () => {
  // These exact forms appear repeatedly in this repo's history (#265, #246)
  // and carry no label — the unscoped-only regex silently misclassified them.
  assert.equal(
    classifyCohort({ title: "fix(test): stabilize flaky assertion" }, [
      { filename: "src/a.ts" },
    ]),
    "bugfix",
  );
  assert.equal(
    classifyCohort({ title: "fix(security): close auth bypass" }, [
      { filename: "src/a.ts" },
    ]),
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

// ---------------------------------------------------------------------------
// Transport. The live API is unreachable from the dev container (the token
// there is proxy-scoped), so pagination and error handling are tested with an
// injected fetch rather than left unverified — an untested wrapper would
// undercount rounds on exactly the large loops this ledger exists to measure.
// ---------------------------------------------------------------------------

function stub(pages) {
  let i = 0;
  return async () => {
    const p = pages[i++];
    return {
      ok: p.ok ?? true,
      status: p.status ?? 200,
      statusText: p.statusText ?? "OK",
      json: async () => p.body,
      headers: { get: (h) => (h.toLowerCase() === "link" ? (p.link ?? null) : null) },
    };
  };
}

test("gh follows Link rel=next across pages", async () => {
  // #268 ran 18 rounds; a wrapper that stopped at page one would report far
  // fewer and look plausible doing it.
  const fetchImpl = stub([
    { body: [{ id: 1 }, { id: 2 }], link: '<https://api.github.com/x?page=2>; rel="next"' },
    { body: [{ id: 3 }], link: null },
  ]);
  const out = await gh("/x", { token: "t", fetchImpl });
  assert.deepEqual(
    out.map((o) => o.id),
    [1, 2, 3],
  );
});

test("gh ignores rel=prev/last and stops when there is no next", async () => {
  const fetchImpl = stub([
    { body: [{ id: 1 }], link: '<https://api.github.com/x?page=9>; rel="last"' },
  ]);
  assert.equal((await gh("/x", { token: "t", fetchImpl })).length, 1);
});

test("gh wraps a single-object response", async () => {
  // /pulls/{n} returns an object, not an array.
  const fetchImpl = stub([{ body: { number: 268 } }]);
  const out = await gh("/repos/o/r/pulls/268", { token: "t", fetchImpl });
  assert.deepEqual(out, [{ number: 268 }]);
});

test("gh throws on a non-ok response instead of returning partial data", async () => {
  const fetchImpl = stub([{ ok: false, status: 401, statusText: "Unauthorized", body: {} }]);
  await assert.rejects(() => gh("/x", { token: "t", fetchImpl }), /401 Unauthorized/);
});

test("gh detects a pagination cycle rather than looping forever", async () => {
  const self = '<https://api.github.com/x?per_page=100>; rel="next"';
  const fetchImpl = stub([
    { body: [{ id: 1 }], link: self },
    { body: [{ id: 1 }], link: self },
  ]);
  await assert.rejects(() => gh("/x", { token: "t", fetchImpl }), /pagination loop/);
});

test("gh requires a token", async () => {
  await assert.rejects(
    () => gh("/x", { token: "", fetchImpl: stub([{ body: [] }]) }),
    /GITHUB_TOKEN/,
  );
});

// ---------------------------------------------------------------------------
// MCP adapter. Fixtures below are drawn verbatim from real `pull_request_read`
// output against this repo's own PR #270 (2026-07-27) — not hand-imagined
// shapes. That's the whole point: a plausible-looking mapping is not the same
// as one checked against a real response.
// ---------------------------------------------------------------------------

import { flattenMcpThreads, fromMcp } from "../loop-metrics.mjs";

const MCP_REVIEW = {
  id: 4791129869,
  user: { login: "chatgpt-codex-connector[bot]" },
  submitted_at: "2026-07-27T20:15:30Z",
};

// Real shape from get_review_comments against PR #270: comments grouped by
// thread, `author` as a bare string, no `id`/`in_reply_to_id`/
// `pull_request_review_id` — id only recoverable from html_url.
const MCP_THREAD_UNANSWERED = {
  id: "PRRT_kwDOR3LTYs6UMcPj",
  comments: [
    {
      body: "Provide a usable API transport in the agent environment",
      path: "scripts/loop-metrics.mjs",
      line: 205,
      author: "chatgpt-codex-connector",
      created_at: "2026-07-27T20:15:31Z",
      html_url:
        "https://github.com/TheAnswerManIsHere/Overhypeme/pull/270#discussion_r3660595551",
    },
  ],
};

const MCP_THREAD_WITH_REPLY = {
  id: "PRRT_kwDOR3LTYs6UMcPm",
  comments: [
    {
      body: "Recognize scoped fix titles as bugfixes",
      author: "chatgpt-codex-connector",
      created_at: "2026-07-27T20:15:31Z",
      html_url:
        "https://github.com/TheAnswerManIsHere/Overhypeme/pull/270#discussion_r3660595556",
    },
    {
      body: "Fixed — broadened the regex.",
      author: "TheAnswerManIsHere",
      created_at: "2026-07-27T20:30:00Z",
      html_url:
        "https://github.com/TheAnswerManIsHere/Overhypeme/pull/270#discussion_r3660777777",
    },
  ],
};

test("flattenMcpThreads recovers the numeric id from html_url", () => {
  const [c] = flattenMcpThreads([MCP_THREAD_UNANSWERED], [MCP_REVIEW]);
  assert.equal(c.id, 3660595551);
});

test("flattenMcpThreads wraps the bare author string as user.login", () => {
  const [c] = flattenMcpThreads([MCP_THREAD_UNANSWERED], [MCP_REVIEW]);
  assert.equal(c.user.login, "chatgpt-codex-connector");
});

test("flattenMcpThreads: first comment in a thread is the root, not a reply", () => {
  const [root] = flattenMcpThreads([MCP_THREAD_WITH_REPLY], [MCP_REVIEW]);
  assert.equal(root.in_reply_to_id, undefined);
});

test("flattenMcpThreads: later comments reply to the thread's root id", () => {
  const [root, reply] = flattenMcpThreads([MCP_THREAD_WITH_REPLY], [MCP_REVIEW]);
  assert.equal(reply.in_reply_to_id, root.id);
});

test("flattenMcpThreads infers pull_request_review_id across the bot's two login spellings", () => {
  // MCP_REVIEW.user.login is "chatgpt-codex-connector[bot]" (from
  // get_reviews); the comment's author is "chatgpt-codex-connector" (from
  // get_review_comments, no [bot] suffix). An exact-match lookup between the
  // two would silently find nothing here — this failed before normalizeLogin.
  const [c] = flattenMcpThreads([MCP_THREAD_UNANSWERED], [MCP_REVIEW]);
  assert.equal(c.pull_request_review_id, MCP_REVIEW.id);
});

test("flattenMcpThreads assigns no review id when the comment predates every review by that author", () => {
  const earlyComment = {
    ...MCP_THREAD_UNANSWERED,
    comments: [{ ...MCP_THREAD_UNANSWERED.comments[0], created_at: "2020-01-01T00:00:00Z" }],
  };
  const [c] = flattenMcpThreads([earlyComment], [MCP_REVIEW]);
  assert.equal(c.pull_request_review_id, undefined);
});

test("fromMcp produces derive()-ready findings and rounds for real PR #270 data", () => {
  const snapshot = {
    pr: {
      number: 270,
      title: "Add the loop ledger: track every review loop, count what can be counted",
      created_at: "2026-07-27T20:07:03Z",
    },
    reviews: [MCP_REVIEW],
    files: [{ filename: "scripts/loop-metrics.mjs", additions: 100, deletions: 0 }],
    reviewThreads: [MCP_THREAD_UNANSWERED, MCP_THREAD_WITH_REPLY],
  };
  const row = derive(fromMcp(snapshot));
  assert.equal(row.rounds, 1);
  // Two threads, one reply — one root finding each, the reply excluded.
  assert.equal(row.findings, 2);
});
