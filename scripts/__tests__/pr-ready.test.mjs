import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSnapshot,
  checkCapture,
  codeReviewOutage,
  checkCi,
  checkCodex,
  checkAdjudicatedCodex,
  isAncestor,
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

// The one-pass-per-request rule and its head bound are SPLIT OUT of this PR
// (David, 2026-08-17) after three rounds without converging. Their tests
// travel with them, on `claude/receipt-request-counting`.
//
// What the residual is, stated rather than left implicit: two review requests
// on one commit (a stalled round plus `pr-watch`'s permitted retry) cannot be
// told apart by their answers, so a late response to the first can read as an
// answer to the second. Narrower than either failure this file was built for.

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
  pr: {
    number: 500,
    head: { sha: HEAD, ref: "claude/x", repo: "TheAnswerManIsHere/Overhypeme" },
  },
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

test("snapshot: a fork head is refused rather than resolved through origin", () => {
  // `remoteTip` resolves through `origin`, which is the BASE repo. A fork
  // head lives elsewhere, so the lookup either finds nothing (blocking a ready
  // PR forever) or -- when the fork's branch shares a name with one of ours --
  // resolves an unrelated tip. Refused at capture, with a message that says
  // so, rather than surfacing as an unresolvable tip an hour later.
  // (Codex, #490 round 6.)
  const snap = goodSnapshot();
  snap.pr.head.repo = "someone-else/Overhypeme";
  assert.throws(() => assertSnapshot(snap, 500), /head is in someone-else\/Overhypeme/);
});

test("snapshot: a missing head repo is rejected, not assumed to be ours", () => {
  // Assuming would make the fork check pass by absence -- the shape of failure
  // this whole file exists to stop.
  const snap = goodSnapshot();
  delete snap.pr.head.repo;
  assert.throws(() => assertSnapshot(snap, 500), /head\.repo/);
});

test("snapshot: the head repo comparison ignores case", () => {
  // GitHub treats owner and repo names case-insensitively, so a capture that
  // differs only in case is the same repository, not a fork.
  const snap = goodSnapshot();
  snap.pr.head.repo = "theanswermanishere/overhypeme";
  assert.doesNotThrow(() => assertSnapshot(snap, 500));
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

test("capture ordering: a read inside the response's reported second is stale", () => {
  // The two operands have different precision. A review submitted at
  // 04:10:00.900 is REPORTED as 04:10:00.000, so a capture at 04:10:00.500 --
  // genuinely earlier -- compared greater and passed. The boundary has to be
  // the end of the reported second. (Codex, #490 round 5.)
  const snap = goodSnapshot();
  snap.capturedAt.reviewThreads = "2026-08-17T04:10:00.500Z";
  const receipt = evaluate(snap, NOW);
  assert.equal(receipt.verdict, "NOT READY");
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

// ---------------------------------------------------------------------------
// checkAdjudicatedCodex: a closed review-loop adjudication as a fallback for
// item 2, bounded by real git ancestry, a real committed mechanical record,
// and an exact-file diff so it cannot become a standing bypass. Exercised
// against a real temporary git repo -- this is exactly the git-plumbing
// logic this file's own culture insists on testing directly, not trusting by
// inspection (remoteTip elsewhere in this file shells to `git ls-remote` and
// is NOT unit-tested for that reason; this function is more
// security-sensitive, since it's a path around the merge gate, so it gets
// the real-repo treatment instead).
//
// Every fixture below goes through `commit()`, never a bare `writeFileSync`
// left uncommitted -- the function under test reads exclusively from `git
// show`, so an untracked file proves nothing except by the one test that
// deliberately leaves it untracked to prove exactly that.
// ---------------------------------------------------------------------------

const TIER = "product";
const TIER_CAP = 5; // review-budget.mjs's TIERS.product.budget -- kept in sync by the "unknown tier" test below noticing drift

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-ready-adjudication-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  const commit = (files, message) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    run(["add", "-A"]);
    run(["commit", "-q", "-m", message]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  return { dir, run, commit };
}

/**
 * A committed mechanical record satisfying every check
 * `validateAdjudicationRecord` runs, overridable per field. `baseline` is
 * the record's own `sinceLastReview.head` -- the PR head the record's
 * analysis actually covers, and (since Codex #539 round 2) the sole source
 * of the diff baseline this fallback trusts.
 */
function record(pr, seq, {
  passes = TIER_CAP,
  generatedAt = "2026-08-17T04:30:00Z",
  evidenceCapturedAt = "2026-08-17T04:28:00Z",
  generator = "scripts/review-loop-record.mjs",
  recordPr = pr,
  tier = TIER,
  pendingRequest = false,
  ambiguous = false,
  allowanceValue = TIER_CAP,
  extensions = [],
  baseline,
  resolved = true,
} = {}) {
  const path = `.agents/adjudications/${pr}-${seq}.json`;
  const body = JSON.stringify({
    generator,
    pr: recordPr,
    generatedAt,
    evidenceCapturedAt,
    budget: { tier, pendingRequest, ambiguous, allowance: allowanceValue, extensions },
    rounds: { completedReviewerPasses: passes },
    sinceLastReview: { resolved, head: baseline },
  });
  return { path, files: { [path]: body } };
}

function extension(pr, seq, {
  verdict = "ship-with-gaps-recorded",
  recordPath,
  extPr = pr,
  kind = "adjudication",
  decidedAt = "2026-08-17T04:35:00Z",
  reasoning = "test reasoning citing the record's own numbers",
  gaps = [],
  ...rest
} = {}) {
  const path = `.agents/receipts/loop-extension-${pr}-${seq}.json`;
  const body = JSON.stringify({ pr: extPr, kind, verdict, recordPath, decidedAt, reasoning, gaps, ...rest });
  return { path, files: { [path]: body } };
}

/**
 * The common case: commit A is "the reviewed commit" (the record's own
 * baseline), then a second commit adds the record + receipt together --
 * exactly PR #534's own shape, and the shape every "ancestor with only
 * bookkeeping since" test needs.
 */
function closedLoop(commit, pr, { seq = 1, recordOpts = {}, extOpts = {} } = {}) {
  const baseline = commit({ "docs/x.md": "content" }, `c1 -- the reviewed commit for #${pr}`);
  const rec = record(pr, seq, { baseline, ...recordOpts });
  const ext = extension(pr, seq, { recordPath: rec.path, ...extOpts });
  const head = commit({ ...rec.files, ...ext.files }, "c2 -- record + receipt land together");
  return { baseline, head, recordPath: rec.path, extPath: ext.path };
}

test("adjudication: no committed receipts at all", () => {
  const { dir, commit } = tempRepo();
  const sha = commit({ "a.txt": "1" }, "c1");
  const res = checkAdjudicatedCodex(999, sha, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /no committed, canonically-named loop-extension-999-\*\.json/);
});

test("adjudication: an UNTRACKED receipt file does not qualify -- only committed content counts", () => {
  // The vulnerability this whole rewrite closes: a file sitting in the
  // working tree, never committed, must be invisible to this check.
  const { dir, commit } = tempRepo();
  const sha = commit({ "a.txt": "1" }, "c1");
  const untracked = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json" });
  const full = join(dir, untracked.path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Object.values(untracked.files)[0]);
  const res = checkAdjudicatedCodex(999, sha, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /no committed, canonically-named loop-extension-999-\*\.json/);
});

test("adjudication: a committed receipt is read from the COMMIT, not a locally-modified working tree", () => {
  const { dir, commit } = tempRepo();
  const { head, recordPath } = closedLoop(commit, 999);
  // Now locally overwrite the committed receipt on disk with content that
  // would qualify under a different PR number -- if the function reads the
  // filesystem instead of `git show`, this changes the verdict.
  const tampered = extension(999, 1, { recordPath, extPr: 111 });
  writeFileSync(join(dir, tampered.path), Object.values(tampered.files)[0]);
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, true); // the COMMITTED content (pr: 999) still governs
  assert.match(res.detail, /bookkeeping-only/);
});

test("adjudication: a receipt naming a different PR does not qualify", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json", extPr: 111 });
  const head = commit(ext.files, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /names PR 111/);
});

test('adjudication: a "continue" verdict does not qualify -- it grants rounds, it doesn\'t close the loop', () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { verdict: "continue", recordPath: ".agents/adjudications/999-1.json", grant: 2, risk: "x" });
  const head = commit(ext.files, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /not an adjudication ship-with-gaps-recorded/);
});

test('adjudication: "split" and "escalate" don\'t qualify either -- neither means "ready to merge"', () => {
  const { dir, commit } = tempRepo();
  const ext1 = extension(999, 1, { verdict: "split", recordPath: ".agents/adjudications/999-1.json" });
  const ext2 = extension(999, 2, { verdict: "escalate", recordPath: ".agents/adjudications/999-1.json" });
  const head = commit({ ...ext1.files, ...ext2.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
});

// ---------------------------------------------------------------------------
// Canonical receipt discovery (Codex, #539 round 2): only DIRECT children of
// the receipts directory, and only canonically-numbered ones, are ever
// candidates -- matching exactly what review-budget.mjs's own `loadLoop`
// will and won't consume.
// ---------------------------------------------------------------------------

test("adjudication: a receipt nested in a subdirectory is invisible -- the guard's own loadLoop would never consume it", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json" });
  const nested = { ".agents/receipts/subdir/loop-extension-999-1.json": Object.values(ext.files)[0] };
  const head = commit(nested, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /no committed, canonically-named/);
});

test("adjudication: a zero-padded sequence is rejected -- loadLoop treats it as a bad receipt, not a valid one", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json" });
  const zeroPadded = { ".agents/receipts/loop-extension-999-01.json": Object.values(ext.files)[0] };
  const head = commit(zeroPadded, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /no committed, canonically-named/);
});

// ---------------------------------------------------------------------------
// Terminal-decision semantics (Codex, #539 round 1): a second adjudication is
// never valid (review-budget.mjs's own rule), but a `david`-kind extension
// reopening the loop after a ship verdict is -- and this fallback must not
// resurrect a superseded ship verdict.
// ---------------------------------------------------------------------------

test("adjudication: a ship verdict superseded by a later (david) extension is not honored", () => {
  const { dir, commit } = tempRepo();
  closedLoop(commit, 999);
  const reopen = { pr: 999, kind: "david", grant: 2, authorization: "David: reopen it" };
  const head = commit({ ".agents/receipts/loop-extension-999-2.json": JSON.stringify(reopen) }, "c3 -- David reopens after the ship verdict");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /terminal decision is kind="david"/);
});

// ---------------------------------------------------------------------------
// The receipt's own payload must be complete (Codex, #539 round 3) -- the
// adjudicator's documented output schema always returns reasoning and gaps,
// and decidedAt records when the verdict was actually decided (after the
// adjudicator ran), not when its input record was generated (before).
// ---------------------------------------------------------------------------

test("adjudication: a receipt with no reasoning is rejected", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json", reasoning: "" });
  const head = commit(ext.files, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /missing the adjudicator's `reasoning`/);
});

test("adjudication: a receipt with a non-array gaps is rejected", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json", gaps: "not an array" });
  const head = commit(ext.files, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /missing the adjudicator's `gaps` array/);
});

test("adjudication: a receipt with no decidedAt is rejected", () => {
  // `undefined` would just re-trigger extension()'s own default -- built by
  // hand, bypassing the factory, to actually omit the field.
  const { dir, commit } = tempRepo();
  const path = ".agents/receipts/loop-extension-999-1.json";
  const body = JSON.stringify({
    pr: 999,
    kind: "adjudication",
    verdict: "ship-with-gaps-recorded",
    recordPath: ".agents/adjudications/999-1.json",
    reasoning: "test",
    gaps: [],
  });
  const head = commit({ [path]: body }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /missing or unparseable `decidedAt`/);
});

test("adjudication: a decidedAt that predates the cited record's generatedAt is rejected -- the decision can't precede its own input", () => {
  const { dir, commit } = tempRepo();
  const { recordPath, baseline } = closedLoop(commit, 999, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });
  const ext = extension(999, 2, { recordPath, decidedAt: "2026-08-17T04:00:00Z" }); // before generatedAt
  const head = commit(ext.files, "c2 -- a later, badly-timestamped receipt");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /decidedAt .* predates the cited record's own generatedAt/);
  void baseline;
});

// ---------------------------------------------------------------------------
// The receipt must cite, and this file fully validates, a real mechanical
// record (Codex, #539 rounds 1 and 2) -- honoring a receipt here unblocks a
// merge, so this file demands more evidence than review-budget.mjs's own
// write-time schema does.
// ---------------------------------------------------------------------------

test("adjudication: a receipt with no recordPath at all is rejected", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: undefined });
  const head = commit(ext.files, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /not under \.agents\/adjudications\//);
});

test("adjudication: a recordPath outside .agents/adjudications/ is rejected", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: "docs/fake-record.json" });
  const head = commit({ ...ext.files, "docs/fake-record.json": "{}" }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /not under \.agents\/adjudications\//);
});

test("adjudication: a recordPath pointing at a record that was never committed is rejected", () => {
  const { dir, commit } = tempRepo();
  const ext = extension(999, 1, { recordPath: ".agents/adjudications/999-1.json" });
  const head = commit(ext.files, "c1 -- no record committed");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /is not committed at/);
});

test("adjudication: a record from the wrong generator is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { generator: "scripts/some-other-tool.mjs", baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /was not produced by review-loop-record\.mjs/);
});

test("adjudication: a record describing a different PR is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { recordPr: 111, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /describes PR 111/);
});

test("adjudication: a broken budget state (record.budget.problem) is rejected", () => {
  const { dir, commit } = tempRepo();
  const path = ".agents/adjudications/999-1.json";
  const body = JSON.stringify({
    generator: "scripts/review-loop-record.mjs",
    pr: 999,
    generatedAt: "2026-08-17T04:30:00Z",
    budget: { problem: "bad-receipt", detail: "loop-budget-999.json: unreadable" },
    rounds: { completedReviewerPasses: TIER_CAP },
  });
  const ext = extension(999, 1, { recordPath: path });
  const head = commit({ [path]: body, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /broken budget state/);
});

test("adjudication: an unknown tier in the record is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { tier: "not-a-real-tier", baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /unknown tier/);
});

test("adjudication: the SENSITIVE tier is never honored, however clean the record otherwise looks (Codex, #539 round 2)", () => {
  // sensitive.selfServe is false -- its tripwire is a mandatory 🛑 to David,
  // and review-budget.mjs itself rejects every adjudication receipt for this
  // tier. A record or receipt claiming otherwise must never satisfy the
  // merge gate either.
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { tier: "sensitive", passes: 5, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /no self-serve extension/);
});

test("adjudication: a record generated below the loop's active allowance is rejected -- adjudication must follow its tripwire", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { passes: TIER_CAP - 1, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /below the loop's active allowance of 5/);
});

test("adjudication: a David-granted allowance ABOVE the base tier cap is honored -- reaching the base cap alone doesn't mean the tripwire fired (Codex, #539 round 3)", () => {
  // A prior `david` extension can raise the loop's real allowance past the
  // tier's base cap before any adjudication happens. Passing the base cap
  // (3) but not the active allowance (8) must still be rejected; only
  // reaching the ACTIVE allowance qualifies.
  const { dir, commit } = tempRepo();
  const belowActive = record(999, 1, { passes: TIER_CAP + 1, allowanceValue: 8, baseline: "a".repeat(40) });
  const ext1 = extension(999, 1, { recordPath: belowActive.path });
  const head1 = commit({ ...belowActive.files, ...ext1.files }, "c1");
  const res1 = checkAdjudicatedCodex(999, head1, { cwd: dir });
  assert.equal(res1.pass, false);
  assert.match(res1.detail, /below the loop's active allowance of 8/);
});

test("adjudication: a non-finite (uncapped) allowance is rejected, not treated as always-satisfied", () => {
  // JSON has no representation for Infinity -- an uncapped grant serializes
  // as `allowance: null`. That must fail closed, not be read as "any pass
  // count satisfies it".
  const { dir, commit } = tempRepo();
  const path = ".agents/adjudications/999-1.json";
  const body = JSON.stringify({
    generator: "scripts/review-loop-record.mjs",
    pr: 999,
    generatedAt: "2026-08-17T04:30:00Z",
    evidenceCapturedAt: "2026-08-17T04:28:00Z",
    budget: { tier: "product", pendingRequest: false, ambiguous: false, allowance: null, extensions: [] },
    rounds: { completedReviewerPasses: 999 },
    sinceLastReview: { resolved: true, head: "a".repeat(40) },
  });
  const ext = extension(999, 1, { recordPath: path });
  const head = commit({ [path]: body, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /below the loop's active allowance of null/);
});

test("adjudication: a record generated with a request still pending is rejected (Codex, #539 round 2)", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { pendingRequest: true, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /pendingRequest is true/);
});

test("adjudication: a record with an AMBIGUOUS request/pass tie is rejected -- pendingRequest: false alone can't distinguish it from resolved (Codex, #539 round 3)", () => {
  // A trigger comment and the last completed pass sharing the exact same
  // GitHub-reported second makes `pending` read 0 (so pendingRequest is
  // correctly false) while the true ordering is indeterminate. `ambiguous`
  // carries that distinction separately.
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { pendingRequest: false, ambiguous: true, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /budget\.ambiguous is true/);
});

test("adjudication: a record whose own extension history already shows a PRIOR adjudication is rejected (Codex, #539 round 2)", () => {
  // review-budget.mjs's own rule: a second adjudication is never valid. If
  // the record cited by this ship verdict already shows one in its embedded
  // budget.extensions, this receipt cannot legitimately be a fresh one.
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, {
    baseline: "a".repeat(40),
    extensions: [{ kind: "adjudication", verdict: "continue", grant: 2 }],
  });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /already shows a prior adjudication/);
});

test("adjudication: a record with no parseable evidenceCapturedAt is rejected (Codex, #539 round 3)", () => {
  const { dir, commit } = tempRepo();
  const path = ".agents/adjudications/999-1.json";
  const body = JSON.stringify({
    generator: "scripts/review-loop-record.mjs",
    pr: 999,
    generatedAt: "2026-08-17T04:30:00Z",
    // evidenceCapturedAt omitted entirely
    budget: { tier: "product", pendingRequest: false, ambiguous: false, allowance: TIER_CAP, extensions: [] },
    rounds: { completedReviewerPasses: TIER_CAP },
    sinceLastReview: { resolved: true, head: "a".repeat(40) },
  });
  const ext = extension(999, 1, { recordPath: path });
  const head = commit({ [path]: body, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /evidenceCapturedAt is missing or unparseable/);
});

// ---------------------------------------------------------------------------
// The record's own diff baseline (sinceLastReview).
// ---------------------------------------------------------------------------

test("adjudication: sinceLastReview.resolved !== true is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { resolved: false, baseline: "a".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /sinceLastReview\.resolved is not true/);
});

test("adjudication: a malformed or abbreviated sinceLastReview.head is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { baseline: "a".repeat(7) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /full 40-character/);
});

test("adjudication: a sinceLastReview.head that doesn't resolve to a real commit is rejected", () => {
  const { dir, commit } = tempRepo();
  const rec = record(999, 1, { baseline: "f".repeat(40) });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files }, "c1");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /does not resolve to a commit/);
});

// ---------------------------------------------------------------------------
// The ancestor-plus-exact-file bound.
// ---------------------------------------------------------------------------

test("adjudication: a baseline with ONLY its own record + receipt changed since it passes", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 999);
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, true);
  assert.match(res.detail, /bookkeeping-only/);
});

test("adjudication: real content changed since the record's baseline is refused, not waved through", () => {
  // The bound that stops this from being a standing bypass: an adjudication
  // covers the commit its record was generated against, not whatever ships
  // later under its name.
  const { dir, commit } = tempRepo();
  closedLoop(commit, 999);
  const head = commit({ "docs/x.md": "DIFFERENT unreviewed content" }, "c3 -- real change, never reviewed");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /not this adjudication's own receipt or record/);
  assert.match(res.detail, /docs\/x\.md/);
});

test("adjudication: a change to ANOTHER PR's bookkeeping file is not waved through (Codex, #539 round 1)", () => {
  // The old design allowed anything under .agents/receipts/ or
  // .agents/adjudications/, which would also wave through a change to a
  // different PR's own loop-extension file. The exact allowlist closes it.
  const { dir, commit } = tempRepo();
  closedLoop(commit, 999);
  const other = extension(111, 1, { recordPath: ".agents/adjudications/111-1.json" });
  const head = commit(other.files, "c3 -- an unrelated PR's own extension file changes");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /loop-extension-111-1\.json/);
});

test("adjudication: an unrelated file added under .agents/receipts/ (e.g. a README) is not waved through", () => {
  const { dir, commit } = tempRepo();
  closedLoop(commit, 999);
  const head = commit({ ".agents/receipts/README.md": "# notes" }, "c3");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /README\.md/);
});

test("adjudication: a baseline that is NOT an ancestor of the current head (history rewritten) is refused", () => {
  const { dir, commit, run } = tempRepo();
  const baseline = commit({ "a.txt": "1" }, "c1 -- the reviewed commit");
  // A sibling branch, not a descendant -- simulates an amended/rebased branch.
  run(["checkout", "-q", "--orphan", "other"]);
  run(["rm", "-rq", "--cached", "."]);
  const rec = record(999, 1, { baseline });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ "b.txt": "2", ...rec.files, ...ext.files }, "unrelated history");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  assert.match(res.detail, /not an ancestor/);
});

test("adjudication: one real file mixed in with the receipt+record still fails the whole check", () => {
  const { dir, commit } = tempRepo();
  const baseline = commit({ "docs/x.md": "content" }, "c1");
  const rec = record(999, 1, { baseline });
  const ext = extension(999, 1, { recordPath: rec.path });
  const head = commit({ ...rec.files, ...ext.files, "docs/x.md": "content changed too" }, "c2 -- record+receipt AND real content");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir });
  assert.equal(res.pass, false);
  // Confirms it fails on the mixed-content diff specifically, not on a
  // malformed receipt -- a receipt this well-formed would otherwise pass.
  assert.match(res.detail, /not this adjudication's own receipt or record/);
  assert.match(res.detail, /docs\/x\.md/);
});

// ---------------------------------------------------------------------------
// isAncestor: exit-code mapping (Codex, #539 round 1). `merge-base
// --is-ancestor` returns 1 for a confirmed non-ancestor and something else
// (128, "not a valid object") for an operational failure -- only the first
// should ever read as "not an ancestor".
// ---------------------------------------------------------------------------

test("isAncestor: a real ancestor returns true", () => {
  const { dir, commit } = tempRepo();
  const a = commit({ "a.txt": "1" }, "c1");
  const b = commit({ "a.txt": "2" }, "c2");
  assert.equal(isAncestor(a, b, dir), true);
});

test("isAncestor: a confirmed non-ancestor (sibling history) returns false", () => {
  const { dir, commit } = tempRepo();
  const a = commit({ "a.txt": "1" }, "c1");
  execFileSync("git", ["checkout", "-q", "--orphan", "other"], { cwd: dir });
  execFileSync("git", ["rm", "-rq", "--cached", "."], { cwd: dir });
  const b = commit({ "b.txt": "2" }, "unrelated");
  assert.equal(isAncestor(a, b, dir), false);
});

test("isAncestor: an operational failure (unresolvable object) returns null, not false", () => {
  const { dir, commit } = tempRepo();
  const a = commit({ "a.txt": "1" }, "c1");
  assert.equal(isAncestor(a, "f".repeat(40), dir), null);
});

// ---------------------------------------------------------------------------
// A live outage or a newer request always wins (Codex, #539 round 1).
// ---------------------------------------------------------------------------

test("adjudication: a live Codex outage refuses the fallback outright, however clean the receipt is", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 999);
  const res = checkAdjudicatedCodex(999, head, { cwd: dir, codexOutage: true });
  assert.equal(res.pass, false);
  assert.match(res.detail, /outage/);
});

test("adjudication: a @codex review request posted AFTER the record was generated refuses the fallback", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 999, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });
  const afterRecord = Date.parse("2026-08-17T04:45:00Z");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir, latestRequestAt: afterRecord });
  assert.equal(res.pass, false);
  assert.match(res.detail, /a fresh review may have been asked for since the loop closed/);
});

test("adjudication: a @codex review request posted BEFORE the record was generated does not block the fallback", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 999, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });
  const beforeRecord = Date.parse("2026-08-17T04:00:00Z");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir, latestRequestAt: beforeRecord });
  assert.equal(res.pass, true);
});

test("adjudication: a request landing in the SAME SECOND as the record's evidenceCapturedAt fails closed (Codex, #539 round 3)", () => {
  // GitHub comment timestamps round to the second; evidenceCapturedAt
  // carries milliseconds. A request genuinely posted at 04:28:00.900 (after
  // evidence capture at 04:28:00.500) is reported as 04:28:00.000, which
  // compares as EARLIER under a naive strict `>` -- so any request whose
  // rounded timestamp falls in or after evidenceCapturedAt's own second
  // must fail closed. The boundary is evidenceCapturedAt, not generatedAt
  // or decidedAt: it's the earliest of the three, and the only one that
  // bounds how current the record's own DATA actually is.
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 999, { recordOpts: { evidenceCapturedAt: "2026-08-17T04:28:00.500Z" } });
  const sameSecondRoundedDown = Date.parse("2026-08-17T04:28:00.000Z");
  const res = checkAdjudicatedCodex(999, head, { cwd: dir, latestRequestAt: sameSecondRoundedDown });
  assert.equal(res.pass, false);
  assert.match(res.detail, /at or after the record's own evidence capture second/);
});

// ---------------------------------------------------------------------------
// evaluate()-level integration.
// ---------------------------------------------------------------------------

test("evaluate: a failed live Codex check falls back to a qualifying adjudication and reaches READY", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 500, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });

  const snap = goodSnapshot();
  snap.pr.head.sha = head;
  snap.checkRuns = allRequired("completed", "success", head); // must match the new head, not the dummy HEAD constant
  snap.issueComments = []; // no @codex review request at all -- checkCodex fails outright
  snap.reviews = [];
  // All captures after 04:30 (the record's generatedAt) and within the
  // evidence-age window ending at NOW (05:05) -- both bars checkCapture now
  // enforces against the adjudication's own acceptedAt.
  snap.capturedAt = { checkRuns: LATER, reviewThreads: LATER, issueComments: LATER, reviews: LATER };

  const receipt = evaluate(snap, NOW, { cwd: dir });
  assert.equal(receipt.items.codex.pass, true);
  assert.match(receipt.items.codex.detail, /adjudicated ship-with-gaps-recorded/);
  assert.equal(receipt.items.capture.pass, true);
  assert.equal(receipt.verdict, "READY");
});

test("evaluate: reviewThreads captured BEFORE the adjudication's record fails capture ordering, even though codex itself passes", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 500, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });

  const snap = goodSnapshot();
  snap.pr.head.sha = head;
  snap.checkRuns = allRequired("completed", "success", head);
  snap.issueComments = [];
  snap.reviews = [];
  // reviewThreads read at 04:00 -- before the 04:30 adjudication record, so
  // it cannot be shown to reflect the loop's final state.
  snap.capturedAt = { checkRuns: LATER, reviewThreads: "2026-08-17T04:00:00Z", issueComments: LATER, reviews: LATER };

  const receipt = evaluate(snap, NOW, { cwd: dir });
  assert.equal(receipt.items.codex.pass, true);
  assert.equal(receipt.items.capture.pass, false);
  assert.equal(receipt.verdict, "NOT READY");
});

test("evaluate: a failed live Codex check AND a non-qualifying adjudication stays NOT READY, with both failures visible", () => {
  const { dir } = tempRepo();
  // No receipt written at all.
  const snap = goodSnapshot();
  snap.issueComments = [];
  snap.reviews = [];

  const receipt = evaluate(snap, NOW, { cwd: dir });
  assert.equal(receipt.items.codex.pass, false);
  assert.match(receipt.items.codex.detail, /review loop was never started/);
  assert.match(receipt.items.codex.detail, /adjudication fallback also failed/);
  assert.equal(receipt.verdict, "NOT READY");
});

test("evaluate: a PASSING live Codex check never even looks for an adjudication receipt", () => {
  // Confirms the fallback is a fallback -- a normal green PR's evaluate()
  // must not depend on .agents/receipts existing at all, let alone on git
  // ancestry succeeding for an unrelated cwd.
  const snap = goodSnapshot();
  const receipt = evaluate(snap, NOW, { cwd: "/nonexistent" });
  assert.equal(receipt.items.codex.pass, true);
  assert.equal(receipt.verdict, "READY");
});

test("evaluate: a live Codex outage is never overridden by a qualifying adjudication receipt", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 500, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });

  const snap = goodSnapshot();
  snap.pr.head.sha = head;
  snap.checkRuns = allRequired("completed", "success", head);
  snap.issueComments = [
    comment("me", "@codex review", "2026-08-17T04:40:00Z"),
    comment(CODEX_BOT, "You have reached your Codex usage limits for code reviews.", "2026-08-17T04:41:00Z"),
  ];
  snap.reviews = [];
  snap.capturedAt = { checkRuns: LATER, reviewThreads: LATER, issueComments: LATER, reviews: LATER };

  const receipt = evaluate(snap, NOW, { cwd: dir });
  assert.equal(receipt.items.codex.pass, false);
  assert.ok(receipt.items.codex.outage, "directCodex must report an outage");
  assert.equal(receipt.verdict, "BLOCKED -- CODEX UNAVAILABLE");
});

test("evaluate: a fresh @codex review request in the snapshot after adjudication blocks the fallback, even though nothing else changed", () => {
  const { dir, commit } = tempRepo();
  const { head } = closedLoop(commit, 500, { recordOpts: { generatedAt: "2026-08-17T04:30:00Z" } });

  const snap = goodSnapshot();
  snap.pr.head.sha = head;
  snap.checkRuns = allRequired("completed", "success", head);
  // A NEW request posted after the record's generatedAt (04:30) -- nobody's answered it yet.
  snap.issueComments = [comment("me", "@codex review", "2026-08-17T04:45:00Z")];
  snap.reviews = [];
  snap.capturedAt = { checkRuns: LATER, reviewThreads: LATER, issueComments: LATER, reviews: LATER };

  const receipt = evaluate(snap, NOW, { cwd: dir });
  assert.equal(receipt.items.codex.pass, false);
  assert.match(receipt.items.codex.detail, /a fresh review may have been asked for since the loop closed/);
  assert.equal(receipt.verdict, "NOT READY");
});
