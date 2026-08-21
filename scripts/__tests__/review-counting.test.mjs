// Tests for the review-counting library -- the counting functions that stayed
// on the enforcement path (review-budget.mjs, review-loop-record.mjs) when the
// loop ledger was deleted (2026-08-20). Recovered from the deleted
// loop-metrics.test.mjs; tests for the ledger's own deleted derivation are
// gone with it. (Codex, #543 round 3.)
import { test } from "node:test";
import assert from "node:assert/strict";

const BOT = { login: "chatgpt-codex-connector[bot]" };
const ME = { login: "TheAnswerManIsHere" };

/**
 * The connector's clean-pass announcement, verbatim in shape from this repo's
 * PR #286/#288/#290 — a plain ISSUE comment (not a review record) whose only
 * stable machine-readable content is the reviewed-commit line. The sentiment
 * suffix varies ("Delightful!" / "Swish!" / ":+1:"), which is exactly why
 * detection keys on the marker and not the prose.
 */
let cleanPassAutoId = 900000;
const cleanPass = (sha, at, id = ++cleanPassAutoId, flourish = "Delightful!") => ({
  id,
  user: BOT,
  created_at: at,
  body: `Codex Review: Didn't find any major issues. ${flourish}\n\n**Reviewed commit:** \`${sha}\`\n`,
});

/** A review record that ANNOUNCES a completed pass — the found-something shape. */
const announced = (id, sha, at) => ({
  id,
  user: BOT,
  commit_id: sha,
  submitted_at: at,
  body: `\n### 💡 Codex Review\n\nHere are some automated review suggestions.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n`,
});

/** A bodiless review record — the inline-comment carrier half of one pass. */
const carrier = (id, sha, at) => ({ id, user: BOT, commit_id: sha, submitted_at: at });


test("a carrier attaches to a same-commit announcement over an earlier unrelated one", () => {
  // With two announcements following a carrier, the one on its own commit is
  // the pass it belongs to — otherwise its findings land in the wrong round.
  const reviews = [
    carrier(1, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2026-07-30T01:00:00Z"),
    announced(2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-07-30T01:01:00Z"),
    announced(3, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2026-07-30T01:02:00Z"),
  ];
  const passes = reviewerPasses(reviews);
  assert.equal(passes.length, 2);
  assert.deepEqual(passes.find((p) => p.commit.startsWith("bbb")).reviewIds.sort(), [1, 3]);
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

test("findingsByRound dedupes a repeated review record instead of double-mapping its findings", () => {
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" }, // duplicate record
  ];
  const comments = [{ id: 40, user: BOT, pull_request_review_id: 1 }];
  assert.deepEqual(
    findingsByRound(reviews, comments).map((r) => [r.round, r.findings]),
    [[1, 1]],
  );
});


test("artifact size keeps both dimensions", () => {
  const size = artifactSize([
    { filename: "a.md", additions: 100, deletions: 5 },
    { filename: "b.md", additions: 300, deletions: 0 },
  ]);
  assert.deepEqual(size, { files: 2, added: 400, removed: 5 });
});

test("artifact size dedupes a repeated file record instead of double-counting it", () => {
  // A bad fixture or two overlapping concatenated pages can repeat a file
  // entry, which would otherwise inflate every dimension of a number this
  // ledger persists as mechanically authoritative.
  const size = artifactSize([
    { filename: "a.md", additions: 100, deletions: 5 },
    { filename: "a.md", additions: 100, deletions: 5 },
  ]);
  assert.deepEqual(size, { files: 1, added: 100, removed: 5 });
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


// ---------------------------------------------------------------------------
// MCP adapter. Fixtures below are drawn verbatim from real `pull_request_read`
// output against this repo's own PR #270 (2026-07-27) — not hand-imagined
// shapes. That's the whole point: a plausible-looking mapping is not the same
// as one checked against a real response.
// ---------------------------------------------------------------------------

import {
  countFindings,
  findingsByRound,
  reviewerPasses,
  artifactSize,
  flattenMcpThreads,
  fromMcp,
  assertMcpSnapshotComplete,
  normalizeLogin,
} from "../review-counting.mjs";

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


test("fromMcp refuses an issue comment missing the fields pass detection reads", () => {
  const bad = realSnapshot({
    issueComments: [{ id: 1, user: { login: "chatgpt-codex-connector[bot]" }, created_at: "2026-07-30T02:00:00Z" }],
    complete: { reviews: true, files: true, reviewThreads: true, issueComments: true },
  });
  assert.throws(() => fromMcp(bad), /issueComments\[0\] must have a stable id.*a string body/);
});

test("fromMcp refuses an issue comment with no stable id", () => {
  // reviewerPasses dedupes issue comments by id; an id-less comment would
  // either collide with every other id-less comment or, left unvalidated,
  // could repeat across concatenated pages and fabricate a phantom round.
  const bad = realSnapshot({
    issueComments: [cleanPass("aaaaaaaaaa", "2026-07-30T02:00:00Z")],
    complete: { reviews: true, files: true, reviewThreads: true, issueComments: true },
  });
  delete bad.issueComments[0].id;
  assert.throws(() => fromMcp(bad), /issueComments\[0\] must have a stable id/);
});

test("flattenMcpThreads assigns no review id when the comment predates every review by that author", () => {
  const earlyComment = {
    ...MCP_THREAD_UNANSWERED,
    comments: [{ ...MCP_THREAD_UNANSWERED.comments[0], created_at: "2020-01-01T00:00:00Z" }],
  };
  const [c] = flattenMcpThreads([earlyComment], [MCP_REVIEW]);
  assert.equal(c.pull_request_review_id, undefined);
});

function realSnapshot(overrides = {}) {
  return {
    pr: {
      number: 270,
      title: "Add the loop ledger: track every review loop, count what can be counted",
      created_at: "2026-07-27T20:07:03Z",
      closed_at: "2026-07-29T18:41:12Z",
    },
    reviews: [MCP_REVIEW],
    files: [{ filename: "scripts/loop-metrics.mjs", additions: 100, deletions: 0 }],
    reviewThreads: [MCP_THREAD_UNANSWERED, MCP_THREAD_WITH_REPLY],
    complete: { reviews: true, files: true, reviewThreads: true },
    ...overrides,
  };
}

test("fromMcp refuses a snapshot with no completeness attestation at all", () => {
  // PR #279's loop — 32 rounds, 166 findings, our worst case, and exactly the
  // shape this adapter is for — will paginate at least one collection.
  // Deriving from an unmarked partial snapshot silently undercounts precisely
  // there.
  const { complete: _drop, ...noAttestation } = realSnapshot();
  assert.throws(() => fromMcp(noAttestation), /complete\.reviews/);
});

for (const key of ["reviews", "files", "reviewThreads"]) {
  test(`fromMcp refuses a snapshot where complete.${key} is explicitly false`, () => {
    assert.throws(
      () => fromMcp(realSnapshot({ complete: { reviews: true, files: true, reviewThreads: true, [key]: false } })),
      new RegExp(`complete\\.${key}`),
    );
  });
}

test("assertMcpSnapshotComplete passes silently when all three are true", () => {
  assert.doesNotThrow(() => assertMcpSnapshotComplete(realSnapshot()));
});

test("fromMcp refuses complete:true attesting to a collection that is not actually present", () => {
  // The attestation only proves a claim was made — it says nothing about
  // whether the data behind it exists. Without this check, complete.reviewThreads
  // true plus a missing reviewThreads field would fall through flattenMcpThreads'
  // ?? [] default and silently report zero findings: indistinguishable from a
  // genuinely clean loop.
  const { reviewThreads: _drop, ...malformed } = realSnapshot();
  assert.throws(() => fromMcp(malformed), /"reviewThreads" must be an array/);
});

for (const key of ["reviews", "files", "reviewThreads"]) {
  test(`fromMcp refuses ${key} when it is present but not an array`, () => {
    assert.throws(() => fromMcp(realSnapshot({ [key]: "not-an-array" })), new RegExp(`"${key}" must be an array`));
  });
}

test("fromMcp refuses a thread whose comments field is missing", () => {
  const threadWithNoComments = { id: "PRRT_broken" };
  assert.throws(
    () => fromMcp(realSnapshot({ reviewThreads: [threadWithNoComments] })),
    /reviewThreads\[0\] \(id PRRT_broken\) has no comments array/,
  );
});


test("fromMcp refuses a files entry missing additions/deletions", () => {
  // A files entry with only a filename is a valid array element, so the
  // container-level check alone would pass this through and let
  // artifactSize() silently substitute zero for both dimensions.
  assert.throws(
    () => fromMcp(realSnapshot({ files: [{ filename: "src/x.ts" }] })),
    /files\[0\] must have a string filename and numeric additions\/deletions/,
  );
});


test("fromMcp refuses a pr object missing a title", () => {
  assert.throws(
    () => fromMcp(realSnapshot({ pr: { number: 270, created_at: "2026-07-27T20:07:03Z" } })),
    /"pr" must have a numeric number, a string title, and a parseable created_at/,
  );
});

test("fromMcp refuses a thread comment missing a body, author, or created_at", () => {
  const brokenThread = {
    id: "PRRT_broken2",
    comments: [{ path: "scripts/loop-metrics.mjs", author: "chatgpt-codex-connector" }],
  };
  assert.throws(
    () => fromMcp(realSnapshot({ reviewThreads: [brokenThread] })),
    /reviewThreads\[0\]\.comments\[0\] must have a body, an author or user\.login, and a created_at/,
  );
});


test("fromMcp accepts a comment with a stable thread id even without a discussion_r html_url", () => {
  const threadWithStableId = {
    id: "PRRT_stable_but_no_url",
    comments: [
      {
        body: "A finding identified by thread id alone",
        author: "chatgpt-codex-connector",
        created_at: "2026-07-27T20:15:31Z",
        html_url: "https://github.com/TheAnswerManIsHere/Overhypeme/pull/270",
      },
    ],
  };
  assert.doesNotThrow(() => fromMcp(realSnapshot({ reviewThreads: [threadWithStableId] })));
});

// ---------------------------------------------------------------------------
// CLI argument parsing/validation.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The per-loop metrics store: projection, scaffold, cohort weighting
// ---------------------------------------------------------------------------


