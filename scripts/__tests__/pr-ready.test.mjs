import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertSnapshot,
  checkCapture,
  codeReviewOutage,
  checkCi,
  checkCodex,
  checkThreads,
  evaluate,
  staleReason,
  CODEX_BOT,
} from "../pr-ready.mjs";

// ---------------------------------------------------------------------------
// Item 1: CI.
//
// This is the only item that was ever actually checked on PR #487, which is
// why the other two carry the interesting tests. It still needs its own: a
// "green" reading that counts a queued job as passing is how a merge lands
// mid-run.
// ---------------------------------------------------------------------------

const HEAD = "a".repeat(40);
const STARTED = "2026-08-17T03:30:00Z";
const run = (name, status, conclusion, head_sha = HEAD, started_at = STARTED) => ({ name, status, conclusion, head_sha, started_at });

/**
 * The repo's mandatory jobs. Present-ness is its own check: `Test` depends on
 * `Classify changed paths`, so a snapshot can hold a complete green set while a
 * required job has not been created yet. (Codex, #490.)
 */
const REQUIRED = ["Classify changed paths", "Build", "Test", "Frontend Test", "E2E Smoke"];
const allRequired = (status = "completed", conclusion = "success", head_sha = HEAD) =>
  REQUIRED.map((n) => run(n, status, conclusion, head_sha));

test("CI: all completed and successful passes", () => {
  assert.equal(checkCi(allRequired()).pass, true);
});

test("CI: skipped and neutral are passes, not failures", () => {
  // This repo's CI classifier skips whole jobs for inert paths by design.
  // Treating a skip as a failure would make every docs-only PR un-mergeable.
  const res = checkCi([...allRequired("completed", "skipped"), run("e2e", "completed", "neutral")]);
  assert.equal(res.pass, true);
});

test("CI: a queued or in-progress run is not green", () => {
  const res = checkCi([...allRequired(), run("e2e", "in_progress", null)]);
  assert.equal(res.pass, false);
  assert.match(res.detail, /still running/);
});

test("CI: a failure is named, not just counted", () => {
  const res = checkCi([...allRequired(), run("e2e", "completed", "failure")]);
  assert.equal(res.pass, false);
  assert.match(res.detail, /e2e \(failure\)/);
});

test("CI: cancelled and timed_out are failures, not neutral outcomes", () => {
  assert.equal(checkCi([...allRequired(), run("e2e", "completed", "cancelled")]).pass, false);
  assert.equal(checkCi([...allRequired(), run("e2e", "completed", "timed_out")]).pass, false);
});

test("CI: a green set missing a MANDATORY job is not green", () => {
  // The bar is not "some checks exist and none failed". A snapshot taken after
  // Classify succeeds but before Test is created reports exactly that, and the
  // receipt it mints stays usable for an hour. (Codex, #490.)
  const res = checkCi([run("Classify changed paths", "completed", "success"), run("Build", "completed", "success")], HEAD);
  assert.equal(res.pass, false);
  assert.match(res.detail, /absent from the check runs/);
});

test("CI: every classifier-dependent job is required, not just Test", () => {
  // Round 3's follow-on: `Test`, `Frontend Test` and `E2E Smoke` all carry
  // `needs: changes` in build.yml, so all three appear late for the same
  // reason. Naming only the one whose absence was demonstrated left two jobs
  // that could still turn up — and fail — after a receipt was minted.
  // (Codex, #490.)
  for (const missing of ["Frontend Test", "E2E Smoke"]) {
    const res = checkCi(allRequired().filter((r) => r.name !== missing), HEAD);
    assert.equal(res.pass, false, `${missing} must be required`);
    assert.match(res.detail, new RegExp(`${missing} is absent`));
  }
});

test("CI: no runs at all is not green -- it is CI that has not started", () => {
  // An empty array would otherwise satisfy `every()` and read as a pass.
  assert.equal(checkCi([]).pass, false);
});

test("CI: green checks from ANOTHER commit do not count", () => {
  // Four collections, four calls, no ordering between them: checks read before
  // a push with the PR metadata read after it would bind a receipt to the new
  // commit while its CI item described the old one -- and the branch-tip
  // comparison would agree, because it too sees the new commit. (Codex, #490.)
  const res = checkCi([run("build", "completed", "success", "b".repeat(40))], HEAD);
  assert.equal(res.pass, false);
  assert.match(res.detail, /belong to another commit/);
});

test("CI: a run with no head_sha cannot be tied to the head", () => {
  const res = checkCi([{ name: "build", status: "completed", conclusion: "success", started_at: STARTED }], HEAD);
  assert.equal(res.pass, false);
  assert.match(res.detail, /no head_sha/);
});

test("CI: runs on the head commit pass the binding", () => {
  assert.equal(checkCi(allRequired(), HEAD).pass, true);
});

// ---------------------------------------------------------------------------
// Item 2: Codex convergence. Both live failures live here.
// ---------------------------------------------------------------------------

const comment = (login, body, at, reactions) => ({ user: { login }, body, created_at: at, reactions });
/** A completed pass announces the commit it reviewed -- the measured signal. */
const pass = (at, sha) => ({
  user: { login: CODEX_BOT },
  state: "COMMENTED",
  body: `### Codex Review\n\n**Reviewed commit:** \`${sha}\``,
  submitted_at: at,
});

test("Codex: a request answered by a pass on the head commit converges", () => {
  const res = checkCodex(
    [comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z")],
    [pass("2026-08-17T04:10:00Z", HEAD)],
    HEAD,
  );
  assert.equal(res.pass, true);
});

test("Codex: a clean pass posted as a plain issue comment counts", () => {
  // #288 lost two rounds to this shape: a pass that finds nothing does not
  // always submit a review record at all -- it posts the announcement as an
  // ordinary issue comment, invisible to anything reading only `reviews`.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `" + HEAD + "`", "2026-08-17T04:10:00Z"),
    ],
    [],
    HEAD,
  );
  assert.equal(res.pass, true);
});

test("Codex: a thumbs-up alone is NOT proof the review returned", () => {
  // Deliberately narrowed in #490 round 2. A reaction is delivered as a count:
  // no identity, no timestamp. So it can show neither that the pass came from
  // Codex nor that it covers this commit rather than the one the request was
  // originally posted for -- and a push between request and reaction is
  // exactly what breaks the second. The detail has to say so, because the
  // failure otherwise looks like Codex simply being slow.
  const res = checkCodex(
    [comment("me", "@codex review", "2026-08-17T04:00:00Z", { "+1": 1 })],
    [],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /reaction carries\s+neither identity nor time/);
});

test("Codex: a pass on an EARLIER commit does not cover the head", () => {
  // "We never merge until that review is returned" means returned for the diff
  // that would merge. A push after the review needs a new round.
  const res = checkCodex(
    [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
    [pass("2026-08-17T04:10:00Z", "b".repeat(40))],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /no completed\s+pass both postdates it and covers/);
});

test("Codex: ordering and coverage must hold of the SAME pass", () => {
  // The finding this rewrite came from. With overlapping rounds, an OLD pass
  // covering the current head satisfied coverage while a LATER pass for a
  // different commit satisfied ordering -- and neither was a pass on this
  // diff. Requiring one qualifying element makes the combination impossible.
  // (Codex, #490.)
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment("me", "@codex review\n\nRound 2.", "2026-08-17T05:00:00Z"),
    ],
    [
      pass("2026-08-17T04:10:00Z", HEAD), // covers head, predates round 2
      pass("2026-08-17T05:10:00Z", "b".repeat(40)), // postdates round 2, wrong commit
    ],
    HEAD,
  );
  assert.equal(res.pass, false);
});

test("Codex: two requests on one head need two passes -- the stall-and-retry shape", () => {
  // `pr-watch` permits one retry when a round produces no review, and that
  // retry needs no push, so both requests name the same commit. A late
  // response to the FIRST then postdates the retry AND matches the head, and
  // nothing in GitHub's data tells the two apart. This fails closed rather
  // than guess — it is the PR #458 failure arriving through a new door.
  // (Codex, #490 round 3.)
  const headStarted = Date.parse("2026-08-17T03:30:00Z");
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment("me", "@codex review\n\nRound 1, retry.", "2026-08-17T04:20:00Z"),
    ],
    [pass("2026-08-17T04:30:00Z", HEAD)],
    HEAD,
    headStarted,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /2 review requests on .* but only 1 completed pass/);
});

test("Codex: a request posted BEFORE CI starts still counts against this head", () => {
  // The bound must not postdate the head's appearance. Deriving it from the
  // earliest check run's `started_at` was too late: a request posted right
  // after the push but before CI began fell outside it, so a retry plus one
  // late pass read as complete while the excluded request was outstanding.
  // The commit's committer date necessarily precedes the push. (Codex, #490
  // round 4.)
  const bornAt = Date.parse("2026-08-17T04:00:00Z"); // commit created
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:01:00Z"), // before CI started
      comment("me", "@codex review\n\nRound 1, retry.", "2026-08-17T04:20:00Z"),
    ],
    [pass("2026-08-17T04:30:00Z", HEAD)],
    HEAD,
    bornAt,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /2 review requests/);
});

test("Codex: the ordering boundary is the LATEST qualifying pass", () => {
  // With two passes on one head, threads captured between them satisfied a
  // boundary set at the first while missing the second pass's unresolved
  // findings. (Codex, #490 round 4.)
  const bornAt = Date.parse("2026-08-17T03:30:00Z");
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment("me", "@codex review\n\nRound 2.", "2026-08-17T04:05:00Z"),
    ],
    [pass("2026-08-17T04:10:00Z", HEAD), pass("2026-08-17T04:40:00Z", HEAD)],
    HEAD,
    bornAt,
  );
  assert.equal(res.pass, true);
  assert.equal(res.acceptedAt, Date.parse("2026-08-17T04:40:00Z"));
});

test("Codex: a request from BEFORE this head does not demand a pass on it", () => {
  // The mirror. A round that stalled, then a push, then one request answered
  // by one pass, is convergence — counting the pre-push request would leave
  // the PR permanently unmergeable.
  const headStarted = Date.parse("2026-08-17T04:10:00Z");
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1 (stalled, older commit).", "2026-08-17T04:00:00Z"),
      comment("me", "@codex review\n\nRound 2.", "2026-08-17T04:20:00Z"),
    ],
    [pass("2026-08-17T04:30:00Z", HEAD)],
    HEAD,
    headStarted,
  );
  assert.equal(res.pass, true);
});

test("outage: a same-second limit notice is not attributed to the retry", () => {
  // Second resolution makes the order unknowable, and mis-attributing the
  // previous attempt's notice escalates an ordinary unanswered round into a
  // development stop. (Codex, #490 round 3.)
  const at = "2026-08-17T04:20:00Z";
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", at),
      comment("me", "@codex review\n\nRound 2.", at),
    ],
    [],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.equal(res.outage, undefined);
});

test("Codex: a review object with a commit_id but no marker is not a pass", () => {
  // GitHub sets commit_id on every review object, including status and error
  // ones, so using it as a fallback for the announcement promoted non-passes
  // into the accepted set. (Codex, #490.)
  const res = checkCodex(
    [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
    [{ user: { login: CODEX_BOT }, body: "Reviewing...", submitted_at: "2026-08-17T04:10:00Z", commit_id: HEAD }],
    HEAD,
  );
  assert.equal(res.pass, false);
});

test("Codex: an abbreviated announced sha still matches the full head", () => {
  // The connector announces a 10-character prefix.
  const res = checkCodex(
    [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
    [pass("2026-08-17T04:10:00Z", HEAD.slice(0, 10))],
    HEAD,
  );
  assert.equal(res.pass, true);
});

test("Codex: a bot comment with no announcement is not a completed pass", () => {
  // Chatter -- an "About Codex" footer, an acknowledgement -- is not a review
  // coming back. Only the announcement (or a 👍) is.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "Working on it.", "2026-08-17T04:05:00Z"),
    ],
    [],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /no completed\s+pass both postdates it/);
});

test("Codex: no request at all fails -- the PR #487 shape", () => {
  // #487 was reported ready having never had `@codex review` posted on it.
  // "Codex has said nothing" is indistinguishable from "Codex is happy" unless
  // the absence of a request is itself a failure.
  const res = checkCodex([comment("me", "Opening this for review.", "2026-08-17T04:00:00Z")], []);
  assert.equal(res.pass, false);
  assert.match(res.detail, /never started/);
});

test("Codex: a request newer than the last response fails -- the PR #458 shape", () => {
  // #458 merged with a round outstanding; seven findings landed 47 seconds
  // later. A naive "has Codex ever reviewed this?" check passes here.
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment("me", "@codex review\n\nRound 2.", "2026-08-17T05:00:00Z"),
    ],
    [pass("2026-08-17T04:30:00Z", HEAD)],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /no completed\s+pass both postdates it/);
});

test("Codex: a security-review usage bounce is not a response", () => {
  // Codex meters security reviews and code reviews separately. Counting the
  // bounce as a response converts an outstanding round into a false green.
  const res = checkCodex(
    [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
    [],
  );
  assert.equal(res.pass, false);
  const withBounce = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "You have reached your Codex usage limits for security reviews.", "2026-08-17T04:01:00Z"),
    ],
    [],
  );
  assert.equal(withBounce.pass, false);
  assert.match(withBounce.detail, /metered separately/);
});

test("outage: a code-review usage limit is a STOP, not a wait", () => {
  // David, 2026-08-17: a code-review outage halts development and goes to him
  // as a 🛑 banner. The receipt has to make that distinguishable from an
  // ordinary "no pass yet" at a glance.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", "2026-08-17T04:01:00Z"),
    ],
    [],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /^STOP --/);
  assert.ok(res.outage);
});

test("outage: the SECURITY bounce is not an outage", () => {
  // The two limits are metered separately. Treating the security bounce as an
  // outage would let independent noise halt development indefinitely -- the
  // mirror of the error that let it mask a real review round.
  assert.equal(
    codeReviewOutage(
      [comment(CODEX_BOT, "You have reached your Codex usage limits for security reviews.", "2026-08-17T04:01:00Z")],
      [],
    ),
    null,
  );
});

test("outage: a delivered review is unaffected by an earlier limit notice", () => {
  // The outage branch is reached only when NO pass has come back, so a limit
  // notice followed by a real review still converges.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "You have reached your Codex usage limits.", "2026-08-17T04:01:00Z"),
    ],
    [pass("2026-08-17T04:10:00Z", HEAD)],
    HEAD,
  );
  assert.equal(res.pass, true);
});

test("outage: the receipt verdict names it, not a generic NOT READY", () => {
  const snap = goodSnapshot();
  snap.reviews = [];
  snap.issueComments = [
    comment("me", "@codex review", "2026-08-17T04:00:00Z"),
    comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", "2026-08-17T04:01:00Z"),
  ];
  assert.equal(evaluate(snap, NOW).verdict, "BLOCKED -- CODEX UNAVAILABLE");
});

test("Codex: the bot's own comments never count as review requests", () => {
  // Codex quotes the trigger phrase in its own "About Codex" footer, which
  // would otherwise register as a request nobody answered.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, 'Reviews are triggered when you comment "@codex review".', "2026-08-17T04:05:00Z"),
    ],
    [pass("2026-08-17T04:05:00Z", HEAD)],
    HEAD,
  );
  assert.equal(res.pass, true);
});

// ---------------------------------------------------------------------------
// Item 3: threads.
// ---------------------------------------------------------------------------

test("threads: all resolved passes", () => {
  assert.equal(checkThreads([{ id: "t1", isResolved: true }]).pass, true);
});

test("threads: an unresolved thread fails and is named", () => {
  const res = checkThreads([{ id: "t1", isResolved: true }, { id: "t2", isResolved: false }]);
  assert.equal(res.pass, false);
  assert.match(res.detail, /t2/);
});

// ---------------------------------------------------------------------------
// Snapshot validation. Every rejection here is a shape that would otherwise
// produce a credible-looking pass from absent data.
// ---------------------------------------------------------------------------

const LATER = "2026-08-17T05:00:00Z";
/** Evaluation time. Fixed, because the evidence window is measured against it. */
const NOW = Date.parse("2026-08-17T05:05:00Z");
const goodSnapshot = () => ({
  repo: "TheAnswerManIsHere/Overhypeme",
  pr: { number: 500, head: { sha: HEAD, ref: "claude/x", committedAt: "2026-08-17T03:30:00Z" } },
  capturedAt: { checkRuns: LATER, reviewThreads: LATER, issueComments: LATER, reviews: LATER },
  checkRuns: allRequired(),
  reviewThreads: [],
  issueComments: [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
  reviews: [pass("2026-08-17T04:10:00Z", HEAD)],
  complete: { checkRuns: true, reviewThreads: true, issueComments: true, reviews: true },
});

test("snapshot: a well-formed snapshot validates and evaluates READY", () => {
  const snap = goodSnapshot();
  assertSnapshot(snap, 500);
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "READY");
  assert.equal(receipt.headSha, HEAD);
  assert.equal(receipt.branch, "claude/x");
  assert.equal(receipt.repo, "TheAnswerManIsHere/Overhypeme");
  assert.equal(Date.parse(receipt.evidenceAt), Date.parse(LATER));
});

test("snapshot: a missing or malformed repo is rejected", () => {
  // A PR number is not an identity -- every repository has a #490, and the
  // merge gate keys receipts by number. (Codex, #490.)
  const snap = goodSnapshot();
  delete snap.repo;
  assert.throws(() => assertSnapshot(snap, 500), /snapshot\.repo must be "owner\/name"/);
  const bare = goodSnapshot();
  bare.repo = "Overhypeme";
  assert.throws(() => assertSnapshot(bare, 500), /snapshot\.repo must be "owner\/name"/);
});

test("snapshot: a PR number mismatch is rejected", () => {
  // Guards against validating one PR and merging another.
  assert.throws(() => assertSnapshot(goodSnapshot(), 501), /snapshot is for PR #500/);
});

test("snapshot: a missing or abbreviated head sha is rejected", () => {
  const snap = goodSnapshot();
  delete snap.pr.head.sha;
  assert.throws(() => assertSnapshot(snap, 500), /full 40-character sha/);
  const short = goodSnapshot();
  short.pr.head.sha = "abc1234";
  assert.throws(() => assertSnapshot(short, 500), /full 40-character sha/);
});

test("snapshot: a missing head committedAt is rejected", () => {
  // It is the only bound available that cannot postdate the head, and a bound
  // that is too late silently drops review requests from the count.
  // (Codex, #490 round 4.)
  const snap = goodSnapshot();
  delete snap.pr.head.committedAt;
  assert.throws(() => assertSnapshot(snap, 500), /committedAt/);
});

test("snapshot: a missing head ref is rejected", () => {
  // Without it the receipt emitted `branch: null` and the merge gate skipped
  // the tip comparison entirely, so a push could move the head under a
  // still-fresh receipt. (Codex, #490.)
  const snap = goodSnapshot();
  delete snap.pr.head.ref;
  assert.throws(() => assertSnapshot(snap, 500), /head\.ref is required/);
});

test("snapshot: a missing capture time is rejected", () => {
  const snap = goodSnapshot();
  delete snap.capturedAt.reviewThreads;
  assert.throws(() => assertSnapshot(snap, 500), /capturedAt\.reviewThreads/);
});

test("snapshot: an unattested collection is rejected", () => {
  // A truncated first page of reviewThreads drops unresolved threads, turning
  // item 3 into a rubber stamp on exactly the busy PRs where it matters.
  const snap = goodSnapshot();
  snap.complete.reviewThreads = false;
  assert.throws(() => assertSnapshot(snap, 500), /complete\.reviewThreads must be explicitly true/);
});

test("snapshot: a missing collection is rejected even when attested", () => {
  const snap = goodSnapshot();
  delete snap.checkRuns;
  assert.throws(() => assertSnapshot(snap, 500), /snapshot\.checkRuns must be an array/);
});

test("snapshot: a thread with no isResolved flag is rejected, not read as resolved", () => {
  const snap = goodSnapshot();
  snap.reviewThreads = [{ id: "t1" }];
  assert.throws(() => assertSnapshot(snap, 500), /no boolean isResolved/);
});

test("snapshot: a comment with no timestamp is rejected", () => {
  // The convergence check is an ordering comparison; an undated comment would
  // silently sort as the epoch and could make an outstanding round look old.
  const snap = goodSnapshot();
  snap.issueComments = [{ user: { login: "me" }, body: "@codex review" }];
  assert.throws(() => assertSnapshot(snap, 500), /missing or unparseable/);
});

test("snapshot: a non-empty but UNPARSEABLE timestamp is rejected", () => {
  // A truthiness check passed this, after which timeOf maps it to epoch zero
  // and any older valid response appears to answer it. (Codex, #490.)
  const snap = goodSnapshot();
  snap.issueComments[0].created_at = "sometime tuesday";
  assert.throws(() => assertSnapshot(snap, 500), /missing or unparseable/);
});

test("capture ordering: threads read BEFORE the accepted response fail", () => {
  // Threads at 10:00, a review with findings at 10:01, reviews read at 10:02:
  // every other item passes and the receipt describes a state that never
  // existed. (Codex, #490.)
  const snap = goodSnapshot();
  snap.capturedAt.reviewThreads = "2026-08-17T04:09:00Z"; // before the 04:10 pass
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
  assert.equal(receipt.items.threads.pass, true);
  assert.match(receipt.items.capture.detail, /read before the Codex response/);
});

test("capture ordering: a SAME-SECOND read is stale, not fresh", () => {
  // GitHub event timestamps have second resolution, so a collection read in
  // the same second as the response cannot be shown to postdate it -- and this
  // file already treats an exact request/response tie as unanswered for that
  // reason. (Codex, #490.)
  const snap = goodSnapshot();
  snap.capturedAt.reviewThreads = "2026-08-17T04:10:00Z"; // exactly the pass time
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
  assert.match(receipt.items.capture.detail, /read before the Codex response/);
});

test("capture recency: a saved snapshot cannot mint a fresh receipt", () => {
  // `generatedAt` is reset every run, so re-running a days-old snapshot
  // produced a receipt that looked current; the merge gate then accepted it
  // for an hour as long as the branch tip had not moved -- past a reopened
  // thread or a re-run that went red. (Codex, #490.)
  const snap = goodSnapshot();
  const receipt = evaluate(snap, NOW + 3 * 60 * 60 * 1000);
  assert.equal(receipt.verdict, "NOT READY");
  assert.match(receipt.items.capture.detail, /outside the 60-minute window/);
});

test("capture recency: ONE future timestamp is enough to reject", () => {
  // Checking only the oldest capture let a future-dated collection ride along
  // beside valid recent ones — and if that collection were reviewThreads or
  // checkRuns, the future value would also satisfy the ordering comparison
  // while the read had actually happened first. (Codex, #490 round 3.)
  const snap = goodSnapshot();
  snap.capturedAt.reviewThreads = new Date(NOW + 60 * 60 * 1000).toISOString();
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
  assert.match(receipt.items.capture.detail, /is in the future/);
});

test("capture ordering: the REQUEST SET must also be read after the response", () => {
  // issueComments is where the requests come from. Read before the accepted
  // pass, it can miss a retry posted after that pass was requested — and the
  // one-pass-per-request rule then counts a set it never saw.
  // (Codex, #490 round 3.)
  const snap = goodSnapshot();
  snap.capturedAt.issueComments = "2026-08-17T04:09:00Z"; // before the 04:10 pass
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
  assert.match(receipt.items.capture.detail, /issueComments/);
});

test("--show: a stale stored receipt is not presentable as READY", () => {
  // The manual-merge path: for a PR David merges, quoting this output IS the
  // control, because no hook sees his click. (Codex, #490 round 3.)
  const fresh = { verdict: "READY", evidenceAt: new Date(NOW - 60_000).toISOString() };
  assert.equal(staleReason(fresh, NOW), null);
  const old = { verdict: "READY", evidenceAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() };
  assert.match(staleReason(old, NOW), /no longer current/);
  assert.match(staleReason({ verdict: "READY" }, NOW), /records no evidenceAt/);
});

test("outage: a limit on a LATER round is still a STOP", () => {
  // Round 1 announced, round 2 hit the limit: the outage branch used to be
  // skipped because some announcement existed, so the verdict came back as a
  // generic NOT READY where David's rule requires a full stop. (Codex, #490.)
  const snap = goodSnapshot();
  snap.issueComments = [
    comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
    comment("me", "@codex review\n\nRound 2.", "2026-08-17T04:20:00Z"),
    comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", "2026-08-17T04:21:00Z"),
  ];
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "BLOCKED -- CODEX UNAVAILABLE");
  assert.match(receipt.items.codex.detail, /^STOP --/);
});

test("outage: a limit BEFORE the round being waited on is not this round's", () => {
  // The mirror of the case above. Scoping to the latest request is what makes
  // the outage visible on every round; without a bound in the other direction
  // an old notice would halt development after Codex had recovered.
  const res = checkCodex(
    [
      comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", "2026-08-17T04:01:00Z"),
      comment("me", "@codex review\n\nRound 2.", "2026-08-17T05:00:00Z"),
    ],
    [],
    HEAD,
  );
  assert.equal(res.pass, false);
  assert.equal(res.outage, undefined);
});

test("Codex: an exact timestamp tie reads as unanswered, not answered", () => {
  // GitHub timestamps have second resolution. (Codex, #490.)
  const at = "2026-08-17T04:10:00Z";
  const res = checkCodex([comment("me", "@codex review", at)], [pass(at, HEAD)], HEAD);
  assert.equal(res.pass, false);
  assert.match(res.detail, /no completed\s+pass both postdates it/);
});

test("evaluate: one failing item is enough for NOT READY", () => {
  const snap = goodSnapshot();
  snap.reviewThreads = [{ id: "t1", isResolved: false }];
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
  assert.equal(receipt.items.ci.pass, true);
  assert.equal(receipt.items.threads.pass, false);
});
