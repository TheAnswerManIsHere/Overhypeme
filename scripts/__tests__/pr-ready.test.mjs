import { test } from "node:test";
import assert from "node:assert/strict";

import { assertSnapshot, checkCi, checkCodex, checkThreads, evaluate, CODEX_BOT } from "../pr-ready.mjs";

// ---------------------------------------------------------------------------
// Item 1: CI.
//
// This is the only item that was ever actually checked on PR #487, which is
// why the other two carry the interesting tests. It still needs its own: a
// "green" reading that counts a queued job as passing is how a merge lands
// mid-run.
// ---------------------------------------------------------------------------

const run = (name, status, conclusion) => ({ name, status, conclusion });

test("CI: all completed and successful passes", () => {
  assert.equal(checkCi([run("build", "completed", "success")]).pass, true);
});

test("CI: skipped and neutral are passes, not failures", () => {
  // This repo's CI classifier skips whole jobs for inert paths by design.
  // Treating a skip as a failure would make every docs-only PR un-mergeable.
  const res = checkCi([run("build", "completed", "skipped"), run("e2e", "completed", "neutral")]);
  assert.equal(res.pass, true);
});

test("CI: a queued or in-progress run is not green", () => {
  const res = checkCi([run("build", "completed", "success"), run("e2e", "in_progress", null)]);
  assert.equal(res.pass, false);
  assert.match(res.detail, /still running/);
});

test("CI: a failure is named, not just counted", () => {
  const res = checkCi([run("build", "completed", "failure")]);
  assert.equal(res.pass, false);
  assert.match(res.detail, /build \(failure\)/);
});

test("CI: cancelled and timed_out are failures, not neutral outcomes", () => {
  assert.equal(checkCi([run("build", "completed", "cancelled")]).pass, false);
  assert.equal(checkCi([run("build", "completed", "timed_out")]).pass, false);
});

test("CI: no runs at all is not green -- it is CI that has not started", () => {
  // An empty array would otherwise satisfy `every()` and read as a pass.
  assert.equal(checkCi([]).pass, false);
});

// ---------------------------------------------------------------------------
// Item 2: Codex convergence. Both live failures live here.
// ---------------------------------------------------------------------------

const comment = (login, body, at) => ({ user: { login }, body, created_at: at });
const review = (login, at) => ({ user: { login }, state: "COMMENTED", submitted_at: at });

test("Codex: a request answered by a later review converges", () => {
  const res = checkCodex(
    [comment("me", "@codex review\n\nRound 1.", "2026-08-17T04:00:00Z")],
    [review(CODEX_BOT, "2026-08-17T04:10:00Z")],
  );
  assert.equal(res.pass, true);
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
    [review(CODEX_BOT, "2026-08-17T04:30:00Z")],
  );
  assert.equal(res.pass, false);
  assert.match(res.detail, /has not been answered/);
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

test("Codex: a genuine bot comment (not the bounce) does count as a response", () => {
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, "Codex Review: no findings.", "2026-08-17T04:05:00Z"),
    ],
    [],
  );
  assert.equal(res.pass, true);
});

test("Codex: the bot's own comments never count as review requests", () => {
  // Codex quotes the trigger phrase in its own "About Codex" footer, which
  // would otherwise register as a request nobody answered.
  const res = checkCodex(
    [
      comment("me", "@codex review", "2026-08-17T04:00:00Z"),
      comment(CODEX_BOT, 'Reviews are triggered when you comment "@codex review".', "2026-08-17T04:05:00Z"),
    ],
    [review(CODEX_BOT, "2026-08-17T04:05:00Z")],
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

const goodSnapshot = () => ({
  pr: { number: 500, head: { sha: "a".repeat(40), ref: "claude/x" } },
  checkRuns: [run("build", "completed", "success")],
  reviewThreads: [],
  issueComments: [comment("me", "@codex review", "2026-08-17T04:00:00Z")],
  reviews: [review(CODEX_BOT, "2026-08-17T04:10:00Z")],
  complete: { checkRuns: true, reviewThreads: true, issueComments: true, reviews: true },
});

test("snapshot: a well-formed snapshot validates and evaluates READY", () => {
  const snap = goodSnapshot();
  assertSnapshot(snap, 500);
  const receipt = evaluate(snap);
  assert.equal(receipt.verdict, "READY");
  assert.equal(receipt.headSha, "a".repeat(40));
  assert.equal(receipt.branch, "claude/x");
});

test("snapshot: a PR number mismatch is rejected", () => {
  // Guards against validating one PR and merging another.
  assert.throws(() => assertSnapshot(goodSnapshot(), 501), /snapshot is for PR #500/);
});

test("snapshot: a missing head sha is rejected", () => {
  const snap = goodSnapshot();
  delete snap.pr.head.sha;
  assert.throws(() => assertSnapshot(snap, 500), /head\.sha is required/);
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
  assert.throws(() => assertSnapshot(snap, 500), /has no created_at/);
});

test("evaluate: one failing item is enough for NOT READY", () => {
  const snap = goodSnapshot();
  snap.reviewThreads = [{ id: "t1", isResolved: false }];
  const receipt = evaluate(snap);
  assert.equal(receipt.verdict, "NOT READY");
  assert.equal(receipt.items.ci.pass, true);
  assert.equal(receipt.items.threads.pass, false);
});
