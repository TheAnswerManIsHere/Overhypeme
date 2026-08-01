import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countRounds,
  countFindings,
  findingsByRound,
  reviewerPasses,
  reviewInterval,
  classifyCohort,
  artifactSize,
  adjudicationSample,
  derive,
  gh,
  stripHtmlComments,
  parseArgs,
} from "../loop-metrics.mjs";

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

test("a duplicated review record counts as one round, not two", () => {
  // A bad fixture or two overlapping concatenated pages can repeat a review
  // record. The raw array length would overcount; countRounds dedupes by id.
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
  ];
  assert.equal(countRounds(reviews), 1);
});

test("a clean pass posted as an issue comment counts as a round", () => {
  // The undercount half of the pre-2026-08-01 bug. On #286 and #288 a pass
  // that found nothing submitted no review record at all — it posted a plain
  // issue comment — so reading only `reviews` reported fewer rounds than
  // actually ran. #288 lost two rounds this way.
  const reviews = [announced(1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-07-30T01:00:00Z")];
  const issueComments = [cleanPass("bbbbbbbbbb", "2026-07-30T02:00:00Z")];
  assert.equal(countRounds(reviews, issueComments), 2);
  assert.equal(countRounds(reviews), 1); // the old, wrong answer, if you don't pass them
});

test("a bodiless carrier record and its announcement are one pass, not two rounds", () => {
  // The overcount half, from #290 round 3: a bodiless record carrying the
  // inline findings plus the summary record announcing the pass, both against
  // c81d316fe6. Counting records reported 7 rounds for a loop that ran 6
  // finding-bearing passes plus one clean one.
  const reviews = [
    carrier(4815015613, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:34:36Z"),
    announced(4815024115, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:36:14Z"),
  ];
  assert.equal(countRounds(reviews), 1);
  assert.equal(reviewerPasses(reviews)[0].records, 2);
});

test("two ANNOUNCEMENTS on one commit are two genuine passes, not one", () => {
  // #292's records 4823525411 and 4823605230: both full announcements against
  // 66c2780bd0, twelve minutes apart, separated by author replies and no push
  // — a real re-review of the same head. Grouping passes by commit (the design
  // this test's fix replaced) merged them, undercounting that loop by a round.
  const reviews = [
    announced(4823525411, "66c2780bd05e7435382f8afafb7c14b58338fa39", "2026-07-30T21:52:30Z"),
    announced(4823605230, "66c2780bd05e7435382f8afafb7c14b58338fa39", "2026-07-30T22:04:31Z"),
  ];
  assert.equal(countRounds(reviews), 2);
});

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

test("a trailing carrier with no announcement after it stands alone", () => {
  // Its findings must still be attributable, or derive()'s reconciliation
  // check fires on what is really a truncated-capture problem.
  const reviews = [
    announced(1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-07-30T01:00:00Z"),
    carrier(2, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2026-07-30T02:00:00Z"),
  ];
  assert.equal(countRounds(reviews), 2);
});

test("a duplicated clean-pass issue comment counts as one round, not two", () => {
  // Same reasoning as the review-record and root-comment dedup above, applied
  // to issue comments: two overlapping concatenated get_comments pages (or a
  // bad fixture) could otherwise repeat one clean-pass announcement into two
  // phantom rounds, each with zero findings — invisible to derive()'s
  // reconciliation check since a zero-finding round can't disagree with
  // anything.
  const dupe = cleanPass("bbbbbbbbbb", "2026-07-30T02:00:00Z", 42);
  assert.equal(countRounds([], [dupe, { ...dupe }]), 1);
});

test("a reviewer issue comment with no reviewed-commit marker is not a pass", () => {
  // The connector also answers questions and reports actions in issue
  // comments. Only a completed-pass announcement declares a reviewed commit.
  const chatter = [{ user: BOT, created_at: "2026-07-30T02:00:00Z", body: "Working on that now." }];
  assert.equal(countRounds([], chatter), 0);
});

test("an @codex review trigger by the author is never a round", () => {
  // The oldest invariant on this function, restated against the new input:
  // trigger comments live in the same collection the clean passes do now.
  const triggers = [{ user: ME, created_at: "2026-07-30T02:00:00Z", body: "@codex review\n\nFix round 2." }];
  assert.equal(countRounds([], triggers), 0);
});

test("rounds and per-round entries agree once passes replace records", () => {
  // #290's real shape: the split pass must report its findings once, under one
  // round, rather than as two rounds that between them claim the same
  // findings — which would trip derive()'s reconciliation check.
  const reviews = [
    carrier(1, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:34:36Z"),
    announced(2, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:36:14Z"),
  ];
  const comments = [
    { id: 11, user: BOT, pull_request_review_id: 1 },
    { id: 12, user: BOT, pull_request_review_id: 2 },
  ];
  const per = findingsByRound(reviews, comments, [cleanPass("8ff39f24ae", "2026-07-30T04:17:44Z")]);
  assert.equal(per.length, 2);
  assert.deepEqual(
    per.map((p) => [p.round, p.findings, p.source]),
    [
      [1, 2, "review"],
      [2, 0, "comment"],
    ],
  );
  assert.equal(
    per.reduce((n, p) => n + p.findings, 0),
    countFindings(comments),
  );
});

test("review interval runs to a clean pass that posted as an issue comment", () => {
  // #286 measured 0.1h against a true ~2.8h window because its final reviewer
  // engagement was a comment, not a review record — a 28× understatement.
  const pr = { created_at: "2026-07-29T23:24:00Z" };
  const reviews = [announced(1, "c8b6395000000000000000000000000000000000", "2026-07-29T23:30:00Z")];
  const issueComments = [cleanPass("6b04de28e6", "2026-07-30T02:14:20Z")];
  assert.equal(reviewInterval(pr, reviews).hours, 0.1);
  assert.equal(reviewInterval(pr, reviews, issueComments).hours, 2.8);
});

test("derive warns rather than silently undercounting when issue comments are absent", () => {
  // A row derived from a snapshot that cannot see clean passes must not look
  // like a row that could. The ledger's own standard: a number that cannot be
  // trusted is not presented as though it can.
  const base = {
    pr: { number: 1, title: "x", created_at: "2026-07-30T00:00:00Z" },
    reviews: [announced(1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-07-30T01:00:00Z")],
    comments: [],
    files: [{ filename: "a.ts", additions: 1, deletions: 0 }],
  };
  assert.match(derive(base).warnings.join(" "), /issueComments was not supplied/);
  assert.deepEqual(derive({ ...base, issueComments: [] }).warnings, []);
});

test("derive reports an absorbed carrier record instead of merging it silently", () => {
  const out = derive({
    pr: { number: 1, title: "x", created_at: "2026-07-30T00:00:00Z" },
    reviews: [
      carrier(1, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:34:36Z"),
      announced(2, "c81d316fe63800c3c4f0e5fdb9468533528e33cd", "2026-07-30T03:36:14Z"),
    ],
    comments: [],
    files: [{ filename: "a.ts", additions: 1, deletions: 0 }],
    issueComments: [],
  });
  assert.equal(out.rounds, 1);
  assert.match(out.warnings.join(" "), /c81d316fe6×2/);
});

test("records with no body at all keep the old one-pass-per-record count", () => {
  // Fixtures captured before review bodies were retained carry no
  // announcement to key on. With nothing to improve, they must keep their
  // prior counts rather than collapsing to zero passes.
  const reviews = [
    { id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" },
    { id: 2, user: BOT, submitted_at: "2026-07-27T02:00:00Z" },
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

test("findingsByRound dedupes a repeated root comment instead of double-counting it in its round", () => {
  // countFindings collapses a duplicate root to one via its Set; the
  // per-round filter must use the same unique-root semantics, or derive()'s
  // reconciliation check throws over what is really a duplicate-input
  // problem, not a genuine correlation failure.
  const reviews = [{ id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" }];
  const comments = [
    { id: 40, user: BOT, pull_request_review_id: 1 },
    { id: 40, user: BOT, pull_request_review_id: 1 }, // duplicate root
  ];
  assert.deepEqual(
    findingsByRound(reviews, comments).map((r) => [r.round, r.findings]),
    [[1, 1]],
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

test("a ledger-append piggyback does not force a feature/bugfix PR into prose/contract", () => {
  // Per working-modes.md's write-path rule, a closed loop's row is folded
  // into whichever PR is opened next, on ANY subject — so nearly every
  // future PR carries an incidental edit to the ledger file. Counting that
  // alone as prose evidence would misclassify almost every PR going forward.
  assert.equal(
    classifyCohort({ title: "Add thing" }, [
      { filename: "src/a.ts" },
      { filename: ".agents/metrics/loop-ledger.md" },
    ]),
    "feature/code",
  );
  assert.equal(
    classifyCohort({ title: "fix: off-by-one" }, [
      { filename: "src/a.ts" },
      { filename: ".agents/metrics/loop-ledger.md" },
    ]),
    "bugfix",
  );
  // A genuine prose PR that also happens to carry the piggyback still
  // classifies as prose — only the ledger path itself is excluded.
  assert.equal(
    classifyCohort({ title: "Update docs" }, [
      { filename: "docs/real-docs.md" },
      { filename: ".agents/metrics/loop-ledger.md" },
    ]),
    "prose/contract",
  );
});

test("a Fix-prefixed title does not override a populated feature oracle", () => {
  // The title heuristic exists only for pre-template PRs, which have no
  // oracle at all. An approved behavior change titled "Fix checkout
  // semantics" with a real Product intent is feature work — a word in the
  // title must not override the oracle.
  const pr = {
    title: "Fix checkout semantics",
    body: "**Product intent:** Change checkout to charge at confirmation, per the approved plan.\n",
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "feature/code");
});

test("a legacy natural-language Fix title with no body field or label classifies as bugfix", () => {
  // Pre-template bugfix PRs in this repo's history have titles like "Fix
  // test isolation issues..." with neither a **Fix tier:** body field nor a
  // label — exactly the legacy case the title fallback exists for, which a
  // conventional-forms-only regex silently misclassified as feature/code.
  assert.equal(
    classifyCohort({ title: "Fix test isolation issues in the enrichment suite" }, [
      { filename: "src/a.ts" },
    ]),
    "bugfix",
  );
  // Word boundary keeps non-fix words starting with "fix" out.
  assert.equal(
    classifyCohort({ title: "Fixture cleanup for the enrichment suite" }, [
      { filename: "src/a.ts" },
    ]),
    "feature/code",
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

test("a bugfix PR with a natural-language title and no label still classifies as bugfix", () => {
  // working-modes.md never requires a conventional title or a label — only
  // the PR body's required "**Fix tier:**" field. Titles like these are real,
  // present in this repo's history, and the title/label regex alone silently
  // misclassified them as feature/code.
  const pr = {
    title: "Fix test isolation issues in the enrichment suite",
    body: "## What & why\n\n...\n\n**Fix tier:** A — contained, single caller\n",
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "bugfix");
});

test("a Tier C fix-tier field also signals bugfix", () => {
  const pr = { title: "Prevent the crash on empty payload", body: "**Fix tier:** C — trivial schema fix\n" };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "bugfix");
});

test("stripHtmlComments removes a comment span reconstituted by a single pass's removal", () => {
  // CodeQL: "incomplete multi-character sanitization." A single non-looped
  // pass only removes the inner `<!-- hidden -->` (the first `<!--` it
  // finds, closed by the first `-->` after it) — the leftover `<!` (from the
  // prefix) and `--` (from the suffix) then splice into a fresh, fully-formed
  // comment that was never a literal match in the original string.
  const input = "X<!" + "<!-- hidden -->" + "-- real content -->Y";
  assert.equal(stripHtmlComments(input), "XY");
});

test("an unedited Fix tier placeholder left over on a real feature PR does not force bugfix", () => {
  // .github/pull_request_template.md prints "**Fix tier:**" in TWO blocks
  // (Tier A/B, Tier C) unconditionally. A code-only feature PR that filled in
  // the feature oracle but forgot to delete the unused bugfix blocks (the
  // template instructs deletion but doesn't enforce it) would still contain a
  // populated-looking Fix tier value from the Tier C block's un-comment-
  // wrapped default text ("C — trivial schema/migration fix, no plan"), even
  // though this is a genuine feature/code PR with real product intent.
  const pr = {
    title: "Add the loop ledger: track every review loop, count what can be counted",
    body: [
      "## Approved-plan oracle",
      "**Approved-plan source:** Plan-review PR #269, final plan commit `abc123`, approved by David on 2026-07-27.",
      "**Product intent:** Track every review loop's rounds and findings mechanically.",
      "**Must not change:** the existing PR workflow.",
      "**Settled decisions:** 1. Ledger lives at .agents/metrics/loop-ledger.md.",
      "",
      "<!-- Bugfix mode, Tier A/B -->",
      "**Fix tier:** <!-- A or B, PLUS the reason either way -->",
      "**Reported symptom:** <!-- David's report, quoted verbatim -->",
      "",
      "<!-- Bugfix mode, Tier C trivial schema fix -->",
      "**Fix tier:** C — trivial schema/migration fix, no plan",
      "**Reported symptom:** <!-- David's report, quoted verbatim -->",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "feature/code");
});

test("a feature PR with multi-line oracle values (content below the label) does not misclassify as bugfix", () => {
  // Writing a field's content on the line(s) AFTER its label is a natural
  // Markdown layout, not an edge case — this PR's own body does exactly
  // this. A same-line-only regex reads "**Product intent:**" as empty here,
  // and if the unused Tier C block is also left in place, the code-only
  // feature would be misclassified as bugfix.
  const pr = {
    title: "Add the loop ledger: track every review loop, count what can be counted",
    body: [
      "## Approved-plan oracle",
      "**Approved-plan source:**",
      "Plan-review PR #269, final plan commit `abc123`, approved by David on 2026-07-27.",
      "**Product intent:**",
      "Track every review loop's rounds and findings mechanically.",
      "**Must not change:**",
      "The existing PR workflow.",
      "**Settled decisions:**",
      "1. Ledger lives at .agents/metrics/loop-ledger.md.",
      "",
      "<!-- Bugfix mode, Tier C trivial schema fix -->",
      "**Fix tier:** C — trivial schema/migration fix, no plan",
      "**Reported symptom:** <!-- David's report, quoted verbatim -->",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "feature/code");
});

test("a bold sub-label inside a field's value is not misread as the start of a new field", () => {
  // "**Product intent:**" followed by "**Goal:** ..." on the next line is a
  // real, if unusual, way to write the value — a boundary check that treats
  // ANY bold-colon text as a new field would truncate this to empty and,
  // with the unused Tier C block left in place, misclassify the feature as
  // bugfix.
  const pr = {
    title: "Add the loop ledger: track every review loop, count what can be counted",
    body: [
      "**Product intent:**",
      "**Goal:** Track every review loop's rounds and findings mechanically.",
      "**Must not change:**",
      "The existing PR workflow.",
      "",
      "**Fix tier:** C — trivial schema/migration fix, no plan",
      "**Reported symptom:** <!-- David's report, quoted verbatim -->",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "feature/code");
});

test("a quoted example containing oracle-field syntax does not corrupt classification", () => {
  // A bugfix PR body that cites the template (a fenced code block showing
  // what the fields look like) contains a literal "**Product intent:**"
  // that isn't this PR's own oracle — an unanchored match would read it as
  // one and disable the genuine Fix-tier signal.
  const pr = {
    title: "Fix test isolation issues in the enrichment suite",
    body: [
      "**Fix tier:** A — contained, single caller",
      "**Reported symptom:** flaky test order dependency",
      "",
      "For reference, the feature-mode block looks like:",
      "```",
      "**Product intent:** <what the feature does>",
      "**Settled decisions:** <the decisions made>",
      "```",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "bugfix");
});

test("a natural-language bugfix with an unedited, empty feature block still classifies as bugfix", () => {
  // \s* in the field regexes used to cross the newline after an empty
  // "**Product intent:**"/"**Settled decisions:**" straight into the NEXT
  // line's own "**Label:**" text, reading it as this field's value —
  // featureOracleIsPopulated would then see a "populated" feature oracle
  // that is actually just the neighboring field, disabling the genuine
  // Fix-tier signal and misclassifying the PR as feature/code.
  const pr = {
    title: "Fix test isolation issues in the enrichment suite",
    body: [
      "## Approved-plan oracle",
      "**Approved-plan source:**",
      "**Product intent:**",
      "**Must not change:**",
      "**Settled decisions:**",
      "",
      "**Fix tier:** A — contained, single caller",
      "**Reported symptom:** flaky test order dependency",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "bugfix");
});

test("a real Tier C fix classifies as bugfix even with the unused Tier A/B block left in", () => {
  // The inverse of the above: a genuine Tier C fix that deleted the feature
  // block (per the template's own instructions) but left the unused A/B
  // block's comment-only placeholder in place. The first "**Fix tier:**"
  // match is empty (A/B, comment-stripped); the real signal is the second.
  const pr = {
    title: "Prevent the crash on empty payload",
    body: [
      "<!-- Bugfix mode, Tier A/B -->",
      "**Fix tier:** <!-- A or B, PLUS the reason either way -->",
      "",
      "<!-- Bugfix mode, Tier C trivial schema fix -->",
      "**Fix tier:** C — trivial schema/migration fix, no plan",
      "**Reported symptom:** crash on empty payload",
    ].join("\n"),
  };
  assert.equal(classifyCohort(pr, [{ filename: "src/a.ts" }]), "bugfix");
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

test("adjudication covers the full population, with an explicit zero case", () => {
  // Full population, deliberately: the adjudicator is an agent, and the
  // earlier 30%-sample design produced two confirmed selection-bias defects
  // (round-1 oversampling, then a failed round-robin coverage guarantee)
  // before being removed. A clean loop has nothing to adjudicate.
  assert.equal(adjudicationSample(0).size, 0);
  assert.equal(adjudicationSample(1).size, 1);
  assert.equal(adjudicationSample(3).size, 3);
  assert.equal(adjudicationSample(10).size, 10);
  assert.equal(adjudicationSample(40).size, 40);
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

test("derive refuses a row whose per-round findings don't sum to the total", () => {
  // A reviewer-authored root with a `pull_request_review_id` that matches no
  // entry in `reviews` (the shape flattenMcpThreads produces when a comment's
  // created_at precedes every same-author review) is still counted by
  // countFindings but lands in no round via findingsByRound's exact-match
  // filter — a plausible-looking row whose own numbers silently disagree.
  assert.throws(
    () =>
      derive({
        pr: { number: 270, title: "x", created_at: "2026-07-27T00:00:00Z" },
        reviews: [{ id: 1, user: BOT, submitted_at: "2026-07-27T01:00:00Z" }],
        comments: [{ id: 1, user: BOT, pull_request_review_id: 999 }],
        files: [{ filename: "a.md", additions: 1, deletions: 0 }],
      }),
    /findings \(1\) does not equal the sum of per-round findings \(0\)/,
  );
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

import { flattenMcpThreads, fromMcp, assertMcpSnapshotComplete } from "../loop-metrics.mjs";

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

test("an MCP snapshot carrying issue comments must attest to paginating them", () => {
  // Same reasoning as the other three collections: a truncated first page
  // would silently drop the very clean passes the field was added to find.
  // Only enforced when the field is present, so pre-2026-08-01 snapshots that
  // omit it still derive (with derive()'s warning instead).
  const withComments = realSnapshot({ issueComments: [cleanPass("aaaaaaaaaa", "2026-07-30T02:00:00Z")] });
  assert.throws(() => fromMcp(withComments), /complete\.issueComments must be explicitly true/);
  assert.throws(() => fromMcp(withComments), /method:"get_comments"/);

  withComments.complete.issueComments = true;
  assert.equal(fromMcp(withComments).issueComments.length, 1);
});

test("fromMcp preserves an omitted issueComments as undefined, not as an empty array", () => {
  // The distinction derive() warns on: "supplied and empty" is a loop with no
  // clean pass; "not supplied" is a snapshot that cannot answer the question.
  assert.equal(fromMcp(realSnapshot()).issueComments, undefined);
  assert.match(derive(fromMcp(realSnapshot())).warnings.join(" "), /issueComments was not supplied/);
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

test("fromMcp produces derive()-ready findings and rounds for real PR #270 data", () => {
  const row = derive(fromMcp(realSnapshot()));
  assert.equal(row.rounds, 1);
  // Two threads, one reply — one root finding each, the reply excluded.
  assert.equal(row.findings, 2);
});

test("derive(fromMcp(...)) throws when a root comment predates every review by its author", () => {
  // End-to-end version of the flattenMcpThreads unit test above: an unmapped
  // root shouldn't just carry an undefined pull_request_review_id quietly —
  // it should stop the whole row from being produced.
  const earlyThread = {
    ...MCP_THREAD_UNANSWERED,
    comments: [{ ...MCP_THREAD_UNANSWERED.comments[0], created_at: "2020-01-01T00:00:00Z" }],
  };
  assert.throws(
    () => derive(fromMcp(realSnapshot({ reviewThreads: [earlyThread] }))),
    /does not equal the sum of per-round findings/,
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

test("fromMcp refuses a review entry missing user.login", () => {
  // countRounds silently excludes a review with no matching login instead of
  // counting or rejecting it — a credible-looking undercount.
  assert.throws(
    () => fromMcp(realSnapshot({ reviews: [{ id: 1, submitted_at: "2026-07-27T20:15:30Z" }] })),
    /reviews\[0\] must have a stable id .* a string user\.login, and a submitted_at/,
  );
});

test("fromMcp refuses a review entry missing a stable id", () => {
  // countRounds/findingsByRound now dedupe reviews by id — multiple id-less
  // reviews would silently collapse into a single round instead of being
  // rejected, producing a plausible but understated ledger row.
  assert.throws(
    () => fromMcp(realSnapshot({ reviews: [{ user: BOT, submitted_at: "2026-07-27T20:15:30Z" }] })),
    /reviews\[0\] must have a stable id \(number or string\)/,
  );
});

test("fromMcp refuses a pr object missing a parseable created_at", () => {
  // derive() consumes pr.created_at for reviewInterval() — a missing/invalid
  // one produces NaN hours that serializes as a legitimate-looking
  // "hours: null" instead of failing loudly.
  assert.throws(
    () => fromMcp(realSnapshot({ pr: { number: 270, title: "x", created_at: "not-a-date" } })),
    /"pr" must have a numeric number, a string title, and a parseable created_at/,
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

test("fromMcp refuses a comment with neither a parseable discussion_r id nor a stable thread id", () => {
  // flattenMcpThreads falls back to `${thread.id}#${i}` when html_url has no
  // discussion_r match. If thread.id is ALSO missing, every such comment
  // across every such thread collapses to the identical literal id
  // "undefined#0" — countFindings' Set-based dedup then silently merges
  // distinct findings into one.
  const unidentifiableThread = {
    comments: [
      {
        body: "A finding with no way to derive a unique id",
        author: "chatgpt-codex-connector",
        created_at: "2026-07-27T20:15:31Z",
        html_url: "https://github.com/TheAnswerManIsHere/Overhypeme/pull/270",
      },
    ],
  };
  assert.throws(
    () => fromMcp(realSnapshot({ reviewThreads: [unidentifiableThread] })),
    /reviewThreads\[0\]\.comments\[0\] has no parseable discussion_r id/,
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

test("parseArgs accepts a single --pr source", () => {
  assert.deepEqual(parseArgs(["node", "loop-metrics.mjs", "--pr", "270"]), {
    fixture: null,
    mcpSnapshot: null,
    prNumber: "270",
    saveTo: null,
  });
});

test("parseArgs rejects no input source at all", () => {
  assert.throws(() => parseArgs(["node", "loop-metrics.mjs"]), /usage: loop-metrics\.mjs/);
});

test("parseArgs rejects more than one input source", () => {
  // The old precedence chain silently used the first one instead of
  // rejecting the ambiguous invocation — `--fixture stale.json --pr 270`
  // would derive from the stale fixture while appearing to target PR 270.
  assert.throws(
    () => parseArgs(["node", "loop-metrics.mjs", "--fixture", "stale.json", "--pr", "270"]),
    /accepts exactly one of --pr, --fixture, --mcp-snapshot/,
  );
});

test("parseArgs rejects --save-fixture given without a path", () => {
  // A present-but-valueless option used to be treated the same as "not
  // requested" and skipped saving silently — a capture that looks
  // successful but loses the fixture needed to reproduce the calculation.
  assert.throws(
    () => parseArgs(["node", "loop-metrics.mjs", "--pr", "270", "--save-fixture"]),
    /--save-fixture requires a value/,
  );
});

test("parseArgs rejects another option token as a missing value", () => {
  // `--save-fixture --pr 270` used to read "--pr" itself as save-fixture's
  // value and write a file literally named "--pr" instead of reporting the
  // missing path.
  assert.throws(
    () => parseArgs(["node", "loop-metrics.mjs", "--save-fixture", "--pr", "270"]),
    /--save-fixture requires a value/,
  );
});

test("parseArgs rejects the same flag given twice", () => {
  assert.throws(
    () => parseArgs(["node", "loop-metrics.mjs", "--pr", "270", "--pr", "271"]),
    /--pr was given more than once/,
  );
});

test("parseArgs accepts --save-fixture with a path", () => {
  assert.equal(
    parseArgs(["node", "loop-metrics.mjs", "--pr", "270", "--save-fixture", "out.json"]).saveTo,
    "out.json",
  );
});
