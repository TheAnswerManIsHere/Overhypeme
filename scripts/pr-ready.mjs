#!/usr/bin/env node
/**
 * Decide, from real GitHub data, whether a PR actually meets the merge bar --
 * and leave a receipt saying so.
 *
 * CLAUDE.md's bar has three items: **CI green, Codex converged, every review
 * thread resolved.** It has now been broken twice in the same way, and both
 * times the failure was identical in shape: I checked ONE item and reported
 * the bar.
 *
 *   - PR #458 was merged with a review round outstanding. Seven findings
 *     landed on `main` 47 seconds later.
 *   - PR #487 was merged after I told David "green -- all nine checks pass,
 *     ready for your merge whenever", having run `get_check_runs` and nothing
 *     else. I had never posted `@codex review` on that PR at all, so item 2
 *     was not merely unverified -- the loop had never started.
 *
 * The repo's standing rule is that a discipline broken twice becomes a check
 * rather than another undertaking. This is that check. Its whole design
 * premise is that **the verdict comes from data, not from recollection**: the
 * three items are computed from a captured `mcp__github__pull_request_read`
 * snapshot, and the thing I quote to David is this script's output rather than
 * my impression of it. On #487 there would have been nothing to quote.
 *
 * WHY A SNAPSHOT RATHER THAN A FETCH: api.github.com is unreachable from bash
 * in this container (see .agents/memory/github-rest-api-blocked-from-bash.md
 * and the guard rule that now blocks the attempt). A plain Node process
 * therefore cannot call the MCP tools itself. The agent captures the pages and
 * passes them in -- the same adapter shape `review-counting.mjs`
 * already uses, and for the same reason.
 *
 * That means this script cannot stop me from fabricating a snapshot. It is not
 * trying to: fabrication is a different failure from the one that actually
 * happened twice, which was reporting an item I never looked at. Requiring the
 * data to exist, be complete, and be shaped correctly is what closes that.
 *
 * USAGE
 *   node scripts/pr-ready.mjs --pr <N> --snapshot <file>   # verdict + receipt
 *   node scripts/pr-ready.mjs --pr <N> --show              # print the receipt
 *
 * Exit 0 when READY, 1 when NOT READY, 2 on a malformed snapshot.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RECEIPTS_DIR as LOOP_RECEIPTS_DIR,
  TIERS,
  allowance,
  railFor,
  validateBudget,
  validateExtension,
} from "./review-budget.mjs";
import { ADJUDICATIONS_DIR } from "./review-loop-record.mjs";
import { reviewerPasses } from "./review-counting.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECEIPT_DIR = join(HERE, "..", ".agents", "receipts");

export const CODEX_BOT = "chatgpt-codex-connector[bot]";

/**
 * Check-run conclusions that are not failures.
 *
 * `neutral` and `skipped` are genuine passes for this repo's path-classified
 * jobs -- the CI classifier skips whole jobs for inert paths by design, so
 * treating a skip as a failure would make every docs-only PR permanently
 * un-mergeable. `cancelled`, `timed_out`, `action_required`, `stale` and
 * `failure` are all real failures and are deliberately absent.
 */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * The jobs that must be PRESENT, not merely the ones that must pass.
 *
 * "Some checks exist and none failed" is not the bar. `Test` depends on
 * `Classify changed paths`, so a snapshot taken after an early job succeeds but
 * before the dependent job is created reports a complete green set and mints a
 * receipt that stays usable for an hour. (Codex, #490.)
 *
 * These are the `jobs.*.name` values in .github/workflows/build.yml. Renaming a
 * job there without updating this list blocks every merge until someone
 * notices -- the fail-closed direction, and loud rather than silent.
 *
 * The list must contain EVERY `needs: changes` job, not just the one whose
 * absence was first demonstrated: `Test`, `Frontend Test` and `E2E Smoke` all
 * appear late for the same reason, so naming only `Test` left two jobs that
 * could still show up after a receipt was minted. (Codex, #490 round 3 --
 * a follow-on to the same finding, which is why the rule here is now the
 * *scheduling shape* rather than a list of examples.)
 */
const REQUIRED_CHECKS = ["Classify changed paths", "Build", "Test", "Frontend Test", "E2E Smoke"];

/**
 * How stale the underlying evidence may be when a receipt is minted.
 *
 * `generatedAt` is set when the script runs, so it says nothing about when the
 * data was READ: a snapshot saved days ago could be re-run to mint a
 * fresh-looking receipt, and the merge gate would accept it as long as the
 * branch tip had not moved -- past a reopened thread or a re-run that went red.
 * (Codex, #490.) Matches the merge gate's own receipt window, since the two
 * are answering the same question about the same evidence.
 */
const MAX_EVIDENCE_AGE_MS = 60 * 60 * 1000;

const authorOf = (c) => c?.user?.login ?? c?.author?.login ?? c?.author ?? "";
const bodyOf = (c) => c?.body ?? "";
const timeOf = (c) => Date.parse(c?.created_at ?? c?.submitted_at ?? 0) || 0;

/**
 * The Codex comment that is NOT a review, and the one that means STOP.
 *
 * Codex meters security reviews and code reviews separately, so the two
 * bounces mean opposite things and must never be collapsed:
 *
 *   - A **security-review** bounce says nothing whatever about code-review
 *     availability. The response is to ask for the code review. Treating it as
 *     "Codex responded" is how an outstanding round gets mistaken for a
 *     finished one; treating it as an outage would let independent noise mask
 *     a real one indefinitely.
 *   - A **code-review** bounce is a development stop (David, 2026-08-17):
 *     *"I need you to stop what you're doing and let me know that there's an
 *     issue. We'll have to pause our development until the token limit
 *     resets."* Not a wait, not a workaround -- a loud halt.
 *
 * `CODEX_USAGE_LIMIT` is deliberately BROADER than any wording I have actually
 * observed. I have seen the security variant verbatim and have never seen the
 * code-review one, so writing a regex for its exact text would be inventing
 * the very string the check depends on. Instead: any Codex comment about usage
 * limits that is not the known security variant is surfaced as a possible
 * outage. The failure direction is a false alarm that costs one question to
 * David, against a missed outage that leaves me quietly waiting on a review
 * that is never coming.
 */
const SECURITY_BOUNCE = /usage limits for security reviews/i;
const CODEX_USAGE_LIMIT = /usage limits?|rate limit|quota/i;

/**
 * A Codex comment reporting a limit that is NOT the security-review one.
 *
 * `since` scopes the search to the round being waited on. Without it, the
 * outage was only ever reported on a PR that had never had a completed pass:
 * once round 1 announced, a round-2 usage-limit bounce fell past the
 * `announcements.length === 0` branch and came back as a generic "not ready",
 * so `evaluate` emitted NOT READY where David's rule requires a full stop.
 * (Codex, #490.) An outage always postdates the request it is answering, so
 * scoping by the latest request is what makes it visible on every round rather
 * than only the first.
 */
export function codeReviewOutage(issueComments, reviews, since = 0) {
  const hit = [...issueComments, ...reviews].find(
    (c) =>
      authorOf(c) === CODEX_BOT &&
      timeOf(c) >= since &&
      CODEX_USAGE_LIMIT.test(bodyOf(c)) &&
      !SECURITY_BOUNCE.test(bodyOf(c)),
  );
  return hit ? { at: hit.created_at ?? hit.submitted_at ?? null, body: bodyOf(hit).slice(0, 200) } : null;
}

/** A comment that requests a review round. */
const REVIEW_REQUEST = /@codex\s+review/i;

/**
 * The one thing the connector emits exactly ONCE per completed pass.
 *
 * Measured, not assumed: `review-counting.mjs` established this against #286,
 * #288 and #290 -- three PRs whose rounds a human had independently narrated
 * -- and it is the only signal that agreed with all three. A pass that finds
 * something puts the marker in a `pull_request_review` body; a pass that finds
 * nothing posts it as a plain ISSUE comment ("Codex Review: Didn't find any
 * major issues"), which is invisible to anything reading only `reviews`. #288
 * lost two rounds to exactly that blindness.
 *
 * Using it here is what makes "the review came back" mean a completed pass
 * rather than merely some bot comment appearing.
 */
const REVIEWED_COMMIT_MARKER = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;

/** Whether two commit references name the same commit, one possibly abbreviated. */
function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

function fail(message) {
  const err = new Error(message);
  err.malformed = true;
  return err;
}

/**
 * Refuse a snapshot that hasn't been paginated to completion.
 *
 * Same reasoning as `review-counting.mjs`'s equivalent: this process cannot page
 * the MCP tool itself, so the agent must attest that it did. A truncated
 * `reviewThreads` page is the dangerous one -- it drops unresolved threads,
 * which turns item 3 from a check into a rubber stamp on precisely the busy
 * PRs where it matters.
 */
const MCP_METHOD_FOR = {
  checkRuns: "get_check_runs",
  reviewThreads: "get_review_comments",
  issueComments: "get_comments",
  reviews: "get_reviews",
};

export function assertSnapshot(snapshot, prNumber) {
  if (!snapshot || typeof snapshot !== "object") throw fail("snapshot is not an object");

  // A PR number alone does not name a pull request -- every repository has a
  // #490. The merge gate keys receipts by number and resolves shas against
  // THIS checkout's origin, so without the repository recorded, a merge aimed
  // at another repo whose PR number happened to match would be waved through
  // by a locally valid receipt. (Codex, #490.)
  if (typeof snapshot.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(snapshot.repo)) {
    throw fail('snapshot.repo must be "owner/name" -- the receipt is bound to a repository, not just a number');
  }

  const pr = snapshot.pr;
  if (!pr || typeof pr !== "object") throw fail('snapshot is missing "pr"');
  if (pr.number !== prNumber) {
    throw fail(`snapshot is for PR #${pr.number}, but --pr said #${prNumber}`);
  }
  // A FULL sha, not merely a plausible one. The merge gate compares the
  // receipt's sha against the branch tip by exact equality, so an abbreviated
  // value would never match and the binding would be dead weight that still
  // looked present.
  if (typeof pr.head?.sha !== "string" || !/^[0-9a-f]{40}$/i.test(pr.head.sha)) {
    throw fail('snapshot.pr.head.sha must be a full 40-character sha -- the receipt is bound to it');
  }
  // The branch is what the merge gate resolves to get the current tip. Without
  // it the receipt emitted `branch: null`, checkMerge skipped the comparison
  // entirely, and a push could change the head under a still-fresh receipt.
  // (Codex, #490.)
  if (typeof pr.head?.ref !== "string" || pr.head.ref.trim() === "") {
    throw fail('snapshot.pr.head.ref is required -- without it the merge gate cannot bind the receipt to a tip');
  }
  // WHICH repository the head branch lives in. `remoteTip` resolves it through
  // `origin`, which is the BASE repo, so a fork PR's head is somewhere origin
  // cannot see. Two ways that goes wrong and neither announces itself: the
  // lookup usually returns null and blocks a ready PR permanently, and a fork
  // branch sharing a name with one of ours resolves an unrelated tip. So a fork
  // head is refused HERE, at capture, with a message that says what happened.
  // (Codex, #490 round 6.)
  //
  // Refusing rather than resolving is a scope decision, not a limitation I
  // failed to notice: supporting forks means resolving against an arbitrary
  // remote URL, and this gate exists to stop ME merging my own PRs without the
  // bar. Every PR in this repo is a same-repo `claude/*` branch. If that ever
  // changes, this message is where the work starts.
  if (typeof pr.head?.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(pr.head.repo)) {
    throw fail(
      'snapshot.pr.head.repo must be "owner/name" (pull_request_read method:"get", head.repo.full_name) ' +
        "-- it is what distinguishes a same-repo head from a fork's",
    );
  }
  if (pr.head.repo.toLowerCase() !== snapshot.repo.toLowerCase()) {
    throw fail(
      `this PR's head is in ${pr.head.repo}, not ${snapshot.repo}. The merge gate resolves the branch ` +
        "tip through `origin`, which is the base repository, so a fork head cannot be bound to a receipt " +
        "and must not be waved through by one. Fork PRs are outside this gate's scope -- merge one by hand " +
        "after checking the bar, or extend remoteTip to resolve against the head repository.",
    );
  }
  const complete = snapshot.complete ?? {};
  const capturedAt = snapshot.capturedAt ?? {};
  for (const key of Object.keys(MCP_METHOD_FOR)) {
    if (!Array.isArray(snapshot[key])) {
      throw fail(`snapshot.${key} must be an array (pull_request_read method:"${MCP_METHOD_FOR[key]}")`);
    }
    if (complete[key] !== true) {
      throw fail(
        `snapshot incomplete: complete.${key} must be explicitly true. Page through ` +
          `pull_request_read (method:"${MCP_METHOD_FOR[key]}") until it reports no further pages, ` +
          `concatenate every page, then set complete.${key} = true.`,
      );
    }
    // WHEN each collection was read, because the four come from four separate
    // calls and nothing else establishes an order between them. Threads read
    // BEFORE a review landed would show zero unresolved while that review's
    // findings sat open -- a receipt for a state that never existed. (Codex, #490.)
    if (!Number.isFinite(Date.parse(capturedAt[key] ?? ""))) {
      throw fail(
        `snapshot.capturedAt.${key} must be an ISO timestamp saying when that call was made. ` +
          `Capture order matters: read reviewThreads and checkRuns LAST, after the Codex response you ` +
          `intend to accept.`,
      );
    }
  }

  // A thread with no resolution flag would fall through an `!== false` test and
  // read as resolved -- the silent-undercount failure this file exists to stop.
  snapshot.reviewThreads.forEach((t, i) => {
    if (typeof t?.isResolved !== "boolean") {
      throw fail(`snapshot.reviewThreads[${i}] has no boolean isResolved`);
    }
  });
  // Parseable, not merely present. `timeOf` maps an unparseable date to epoch
  // zero, which would silently sort an outstanding request as the oldest event
  // in the snapshot and let a stale response appear to answer it. (Codex, #490.)
  for (const [key, field] of [["issueComments", "created_at"], ["reviews", "submitted_at"]]) {
    snapshot[key].forEach((c, i) => {
      if (!Number.isFinite(Date.parse(c?.[field] ?? ""))) {
        throw fail(`snapshot.${key}[${i}].${field} is missing or unparseable`);
      }
    });
  }
}

/**
 * Item 1: every check run finished on THIS commit, and none of them failed.
 *
 * The head-sha binding is not decoration. The four collections are captured by
 * four separate calls, so green checks read before a push, with the PR metadata
 * read after it, would produce a receipt bound to the new commit whose CI item
 * described the old one -- and the branch-tip comparison would then agree,
 * because it too is looking at the new commit. (Codex, #490.)
 */
export function checkCi(checkRuns, headSha = null) {
  if (checkRuns.length === 0) {
    return { pass: false, detail: "no check runs reported for the head commit -- CI has not started" };
  }
  if (headSha) {
    const foreign = checkRuns.filter((r) => r.head_sha && !sameCommit(r.head_sha, headSha));
    if (foreign.length) {
      return {
        pass: false,
        detail:
          `${foreign.length} check run(s) belong to another commit (${[...new Set(foreign.map((r) => String(r.head_sha).slice(0, 7)))].join(", ")}), ` +
          `not ${headSha.slice(0, 7)} -- re-read get_check_runs after the push`,
      };
    }
    const unbound = checkRuns.filter((r) => !r.head_sha);
    if (unbound.length) {
      return {
        pass: false,
        detail:
          `${unbound.length} check run(s) carry no head_sha, so they cannot be tied to ${headSha.slice(0, 7)} ` +
          `-- capture head_sha with each run`,
      };
    }
  }
  const names = new Set(checkRuns.map((r) => r.name));
  const missing = REQUIRED_CHECKS.filter((n) => !names.has(n));
  if (missing.length) {
    return {
      pass: false,
      detail:
        `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} absent from the check runs. ` +
        `A nonempty set of passing checks is not the bar -- ${names.size} check(s) can all be green ` +
        `while a mandatory job has not been created yet (Test depends on Classify changed paths, so it ` +
        `appears late). Re-read get_check_runs once the workflow has fanned out.`,
    };
  }

  const pending = checkRuns.filter((r) => r.status !== "completed");
  const failed = checkRuns.filter(
    (r) => r.status === "completed" && !PASSING_CONCLUSIONS.has(r.conclusion),
  );
  if (failed.length) {
    return {
      pass: false,
      detail: `${failed.length} failing: ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`,
    };
  }
  if (pending.length) {
    return {
      pass: false,
      detail: `${pending.length} still running: ${pending.map((r) => `${r.name} (${r.status})`).join(", ")}`,
    };
  }
  return { pass: true, detail: `${checkRuns.length} checks on ${headSha ? headSha.slice(0, 7) : "head"}, all passing` };
}

/**
 * Item 2: EVERY PR gets a Codex review, and we never merge before it returns.
 *
 * David, 2026-08-17: *"EVERY PR is going to get a Codex review. It might not
 * have any findings, but we can't merge the PR until that review is returned.
 * If there are no findings, it gives a thumbs up emoji. If there are findings,
 * you respond. We NEVER merge until that happens."*
 *
 * Three things have to hold, and each maps to a way this has actually gone
 * wrong:
 *
 *  1. **A round was requested at all.** PR #487 was reported ready having never
 *     had `@codex review` posted on it. Silence from a reviewer nobody asked is
 *     indistinguishable from approval unless the absence of a request is itself
 *     a failure.
 *  2. **The latest request has come back.** An ordering comparison, not "has
 *     Codex ever reviewed this" -- the latter was true of PR #458 while a round
 *     was still outstanding, and seven findings landed 47 seconds after merge.
 *  3. **What came back covers what would merge.** A pass on an earlier commit
 *     is not a pass on the diff being merged. This is the strict reading of
 *     "we never merge until that review is returned", and it is why every push
 *     after a review needs a new round -- which is already the cumulative-diff
 *     discipline, now enforced rather than remembered.
 *
 * ONE OBJECT HAS TO SATISFY ALL THREE. This is the whole shape of the check,
 * and it is what four separate #490 findings were each an instance of. The
 * previous version computed the predicates independently -- some announcement
 * postdated the request, some announcement matched the head -- so with
 * overlapping rounds an OLD pass covering the current head could satisfy
 * coverage while a LATER pass for a different commit satisfied ordering, and
 * neither was a pass on this diff. Two other findings (a `commit_id` fallback
 * that admitted unmarked review objects, and a thumbs-up path that skipped
 * head correlation entirely) were extra success paths around the same
 * predicate. Requiring a single qualifying element removes the class rather
 * than the instances: there is nothing left to combine across.
 *
 * WHY THE THUMBS-UP PATH IS GONE (deliberate narrowing, #490 round 2). The
 * connector's own footer says a clean pass "will react with 👍", so accepting
 * it looked obligatory. But a reaction is delivered as a COUNT: GitHub's
 * comment payload carries totals, not who reacted or when. That makes it
 * impossible to establish either half of what this item asserts -- that the
 * pass came from Codex, and that it covers *this* commit rather than the one
 * the request was originally posted for. The previous version inferred both,
 * and the inference is exactly what a push between request and reaction
 * breaks.
 *
 * The narrowing is affordable because a clean pass also announces: the
 * `**Reviewed commit:**` marker appears in the plain issue comment Codex posts
 * when it finds nothing ("Codex Review: Didn't find any major issues"), which
 * is the measured signal behind the marker's own note. So the announcement
 * path is expected to cover clean passes too, and a 👍 is treated as a hint in
 * the failure message rather than as proof.
 *
 * FLIP CONDITION, stated so it is checkable rather than assumed: if a clean
 * pass ever arrives as a reaction with NO marker comment, this gate blocks a
 * mergeable PR and the fix is not to re-admit the inference -- it is to ask
 * David, with that observation as the evidence. Fail-closed here costs one
 * blocked merge; fail-open costs the failure this file exists to prevent.
 */
export function checkCodex(issueComments, reviews, headSha = null) {
  const requests = issueComments
    .filter((c) => authorOf(c) !== CODEX_BOT && REVIEW_REQUEST.test(bodyOf(c)))
    .sort((a, b) => timeOf(a) - timeOf(b));

  // A completed pass: connector-authored, carrying the marker, with the sha it
  // reviewed. Computed before the zero-requests branch because the AUTOMATIC
  // pass -- the connector reviews on PR open and on marking a draft ready,
  // with no trigger comment at all -- is a complete round with no request to
  // anchor to. No `commit_id` fallback -- GitHub sets that field on every
  // review object, including status and error ones, so it promoted non-passes
  // into this set. (Codex, #490.)
  const passes = [...reviews, ...issueComments]
    .filter((c) => authorOf(c) === CODEX_BOT && !SECURITY_BOUNCE.test(bodyOf(c)))
    .map((c) => ({ at: timeOf(c), sha: (bodyOf(c).match(REVIEWED_COMMIT_MARKER) ?? [])[1] ?? null }))
    .filter((p) => p.sha);

  if (requests.length === 0) {
    // ZERO REQUESTS IS A LEGITIMATE COMPLETE STATE when the automatic pass
    // covers the exact head (David, 2026-08-21, with the internal review
    // tier): a clean round 1 on an internal PR never posts a trigger, and
    // demanding one manufactured the #551 deadlock -- the guard forbade the
    // request the merge gate demanded. Only the marker binding to THIS head
    // is accepted; a pass on any earlier commit means fixes were pushed on
    // top, and those need a requested round like always. Requires a headSha
    // to bind to -- with none supplied this stays the #487 failure, closed.
    //
    // DELIBERATELY TIER-BLIND (declined finding, #553 round 1): a clean
    // pass covering the head is a complete review for ANY tier -- the
    // budget's job is bounding ROUNDS, and a zero-request loop has none to
    // bound. A product PR merging on a clean automatic pass with no
    // declared budget satisfies the actual close-out bar (CI + review on
    // head + threads), and the exposure is not new: David's own trigger
    // posts were never guard-gated, so a no-budget pass-on-head could
    // already mint READY before this path existed. The declare-before-round-1
    // contract still binds the agent's OWN requests via the guard.
    const automatic = headSha ? passes.filter((p) => sameCommit(p.sha, headSha)) : [];
    if (automatic.length > 0) {
      return {
        pass: true,
        detail: `automatic pass on ${headSha.slice(0, 7)} (no request -- the connector reviews on PR open); nothing pushed past it`,
        acceptedAt: Math.max(...automatic.map((p) => p.at)),
      };
    }
    return {
      pass: false,
      detail: "no `@codex review` request found and no automatic pass covers the head -- the review loop was never started (this is the PR #487 failure)",
    };
  }

  const latestRequest = requests[requests.length - 1];
  const requestedAt = timeOf(latestRequest);
  // Scoped to the round being waited on, so a limit hit on round 2 is a STOP
  // even though round 1 completed normally. (Codex, #490.)
  // Strictly after: a notice created in the same second as the retry request
  // cannot be shown to answer it, and mis-attributing the previous attempt's
  // notice would escalate an ordinary unanswered round into a development
  // stop. Same posture this file takes on every other second-resolution tie.
  // (Codex, #490 round 3.)
  const outage = codeReviewOutage(issueComments, reviews, requestedAt + 1);

  // The single element that must exist. Strict `>` on the ordering: GitHub
  // timestamps have second resolution, so a tie is treated as unanswered.
  const qualifying = passes.filter(
    (p) => p.at > requestedAt && (!headSha || sameCommit(p.sha, headSha)),
  );

  // KNOWN GAP, SPLIT OUT RATHER THAN FIXED HERE (David, 2026-08-17).
  //
  // `pr-watch` permits one retry when a round produces no review, and that
  // retry needs no push -- so two requests can name the same commit, and a
  // late response to the FIRST postdates the retry and matches the head.
  // Nothing GitHub exposes ties a review to the request that triggered it, so
  // this check cannot tell them apart, and it can mint READY with a round
  // still outstanding.
  //
  // A one-pass-per-request rule was written for it and went three review
  // rounds without converging -- the bound on which requests belong to the
  // head was wrong twice, the branch ordering hid the outage stop, and it
  // false-blocked requests that WERE answered in order. That work is on
  // `claude/receipt-request-counting` with its open findings.
  //
  // What ships here is the narrower check that did converge, and it still
  // catches both failures this file was built for: PR #487 (no request at
  // all) and PR #458 (a round requested and not returned). The residual is
  // strictly narrower than either.

  if (qualifying.length === 0) {
    // An outage is not "still waiting". CLAUDE.md requires a full stop and a
    // 🛑 banner to David, so the receipt has to make the two distinguishable
    // at a glance rather than leaving me to notice. (David, 2026-08-17.)
    if (outage) {
      return {
        pass: false,
        outage,
        detail:
          `STOP -- Codex reports a usage limit that is not the security-review one: ` +
          `"${outage.body.replace(/\s+/g, " ").trim()}". Development pauses until the limit resets; ` +
          `raise this with David rather than waiting or working around it.`,
      };
    }

    const thumbsUp = (latestRequest.reactions?.["+1"] ?? 0) > 0;
    const reviewed = [...new Set(passes.map((p) => p.sha.slice(0, 7)))].join(", ") || "none";
    return {
      pass: false,
      detail:
        `round ${requests.length} was requested at ${new Date(requestedAt).toISOString()} and no completed ` +
        `pass both postdates it and covers ${headSha ? headSha.slice(0, 7) : "the head"} ` +
        `(passes seen: ${reviewed}). A pass announces \`**Reviewed commit:**\` -- in a review when it found ` +
        `something, in a plain issue comment when it didn't.` +
        (thumbsUp
          ? " There IS a 👍 on the latest request, which is not accepted on its own: a reaction carries " +
            "neither identity nor time, so it cannot show the pass came from Codex or that it covers this " +
            "commit. Find the marker comment for this round, or request a fresh round on the current head."
          : " A security-review usage bounce is neither -- it is metered separately from code review."),
    };
  }

  // `acceptedAt` is what the capture-ordering check needs: the moment the
  // response being relied on appeared. Threads read before it prove nothing.
  //
  // The LATEST qualifying pass, not the earliest. With two passes on one head,
  // threads captured between them satisfied an ordering boundary set at the
  // first while missing the second pass's unresolved findings entirely --
  // which is the ordering check failing at exactly the moment it is load
  // bearing. (Codex, #490 round 4.)
  const acceptedAt = Math.max(...qualifying.map((p) => p.at));
  return {
    pass: true,
    detail: `${requests.length} round(s); pass on ${qualifying[0].sha.slice(0, 7)} returned after the latest request`,
    acceptedAt,
  };
}

/**
 * Item 2, alternate path: a closed review-loop adjudication can satisfy
 * "Codex returned" when the round-budget guard (`review-budget.mjs`) has
 * permanently closed the loop and no further per-commit pass can ever be
 * requested.
 *
 * WHY THIS EXISTS. The round-budget guard's own rule is "only a `continue`
 * verdict reopens the guard, and only once" -- a `ship-with-gaps-recorded`
 * verdict closes it for good. That guard and this one were built
 * independently and never wired together: this file's `checkCodex` still
 * demands a pass covering the exact head commit, which a closed loop can
 * never produce again. PR #534 hit this directly -- three real review
 * rounds, seven findings fixed, a fresh-context adjudicator returned
 * `ship-with-gaps-recorded` with zero remaining gaps, and the PR was then
 * structurally unmergeable: the guard refused every further `@codex review`
 * request, and this file refused to merge without one. This function closes
 * that gap.
 *
 * ONLY "ship-with-gaps-recorded" QUALIFIES, AND ONLY AS THE LOOP'S TERMINAL
 * DECISION. `split` and `escalate` are not "this is ready" verdicts -- they
 * hand the PR to further human or agent action before anything should merge.
 * `continue` is excluded by construction: it grants more rounds rather than
 * closing the loop. Only the highest-numbered `loop-extension-<pr>-*`
 * receipt is ever HONORED -- a later `david`-kind extension reopening the
 * loop after a ship verdict must not have its superseded verdict
 * resurrected (Codex, #539 round 1) -- but the chain UNDER it is still
 * validated: an adjudication that follows a non-continue adjudication is a
 * chain `loadLoop` rejects ("only a `david`-kind receipt reopens the
 * loop"), and this fallback refuses it too rather than accepting at merge
 * time what the refusal layer forbids. (Codex, #543 round 4.)
 *
 * THE RECEIPT MUST BE COMMITTED, NOT MERELY PRESENT. Every read below goes
 * through `git show <sha>:<path>`, never the filesystem -- an untracked or
 * locally-modified file matching the receipt's name must never be able to
 * mint a merge-ready verdict for a commit it was never actually part of.
 * (Codex, #539 round 1.) Only DIRECT children of `.agents/receipts/` count
 * (`git ls-tree` with no `-r`), matching what `review-budget.mjs`'s own
 * `loadLoop` consumes (Codex, #539 round 2) -- and a NON-CANONICALLY-named
 * extension for this PR (zero-padded, non-round-trip) fails the whole check
 * closed rather than being skipped, because `loadLoop` refuses the whole
 * loop on such a name and a receipt this fallback honors must be one the
 * guard's loop actually closed on. (Codex, #548.)
 *
 * THE DIFF BASELINE IS DERIVED FROM THE CITED RECORD, NEVER FROM A
 * SELF-DECLARED RECEIPT FIELD. The first version of this function had the
 * receipt name its own `headSha` -- an untrusted second source of truth: a
 * receipt can claim ANY later ancestor commit that happens to already
 * contain the cited record, including one carrying real unreviewed changes,
 * and the documented tripwire procedure never actually produces a `headSha`
 * on the verdict it writes in the first place. `sinceLastReview.head` on the
 * record -- the PR head at the moment the record's round-counting analysis
 * was generated -- is source-derived instead, so THAT is the baseline used
 * below. (Codex, #539 round 2.)
 *
 * THE RECEIPT MUST CITE, AND THIS FUNCTION FULLY VALIDATES, A REAL
 * MECHANICAL RECORD -- `review-budget.mjs` now requires `recordPath` on
 * every adjudication verdict, not just `continue` (this file's stakes are
 * different: honoring the receipt is what unblocks a merge). Beyond what
 * `validateRecordReference` checks there (generator, PR, round count against
 * the declared tier's cap), this function also confirms that no request was
 * still pending when the record was generated. Every tier's receipts get
 * this fallback as of the two-tier tripwire (David, 2026-08-26): sensitive
 * and internal loops now write adjudication receipts like product ones.
 *
 * IT DOES NOT COUNT PRIOR ADJUDICATIONS. It did until 2026-08-20, citing
 * `review-budget.mjs`'s rule that a second adjudication is never valid --
 * and that rule is gone: the adjudicator now runs after every round and may
 * grant more than once, bounded by the David-gate leash rather than by a count. The
 * check had to go with its own justification, and nothing was lost, because
 * what makes a ship verdict terminal is the ACTIVE-ALLOWANCE test below
 * (`passes >= record.budget.allowance` -- the tripwire actually fired, at
 * whatever cap the loop had reached including earlier grants), not the
 * absence of earlier adjudications. The anti-bypass property is unchanged and
 * still comes from the ancestor-plus-exact-file bound below.
 *
 * THE ANCESTOR-PLUS-EXACT-FILE BOUND is what keeps this from becoming a
 * standing bypass. The record's baseline must be a real, resolvable ancestor
 * of the commit being merged, and the ONLY files allowed to differ between
 * them are this adjudication's own receipt and its cited record -- not every
 * file under `.agents/receipts/` or `.agents/adjudications/`, which would
 * also wave through a change to another PR's budget or a
 * differently-numbered extension. Rename detection is disabled on the diff
 * (`--no-renames`) so a real file moved into either directory shows up as
 * its original path, not laundered into an allowed one. (Codex, #539
 * round 1.)
 *
 * A LIVE OUTAGE OR A NEWER REQUEST ALWAYS WINS. If Codex is in a reported
 * outage, or a `@codex review` request exists at or after the record's own
 * second -- GitHub's comment timestamps round to the second while the
 * record's `generatedAt` carries milliseconds, so a request that landed
 * later in the same second as generation can round down to look earlier;
 * ties fail closed the same way this file's other ordering checks do --
 * this fallback refuses outright, however clean the receipt is otherwise.
 * (Codex, #539 rounds 1 and 2.)
 *
 * `git` calls are read-only and local (`cat-file -e`, `merge-base
 * --is-ancestor`, `diff --name-only`, `ls-tree`, `show`) -- no network, same
 * posture as `remoteTip` elsewhere in this file, and independently timed out
 * so a hung git process can't hang the merge gate.
 */

// `cwd` is injectable so tests can point this at a throwaway temp repo
// instead of exercising real git plumbing against this checkout -- the
// ancestry/diff logic below is exactly the part this file's own culture
// insists on testing directly rather than trusting by inspection.
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: REMOTE_TIP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `git merge-base --is-ancestor` distinguishes "confirmed not an ancestor"
 * (exit 1) from an operational failure such as a shallow clone missing
 * history (exit 128) -- and only the first is a real answer. The generic
 * `git()` wrapper above collapses both to `null`, which is fine for its
 * other callers but wrong here: this check's negative result is a refusal
 * that permanently sticks, so an error mistaken for "not an ancestor" would
 * refuse forever until someone thinks to fetch more history. Returns
 * `true` / `false` / `null` (unknown). (Codex, #539 round 1.)
 */
export function isAncestor(candidateSha, ofSha, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidateSha, ofSha], {
      cwd,
      timeout: REMOTE_TIP_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (e) {
    return e.status === 1 ? false : null;
  }
}

/** The most recent `@codex review` request across the whole PR, if any (ms epoch). */
function latestReviewRequestAt(issueComments) {
  const requests = (issueComments ?? [])
    .filter((c) => authorOf(c) !== CODEX_BOT && REVIEW_REQUEST.test(bodyOf(c)))
    .map((c) => timeOf(c));
  return requests.length ? Math.max(...requests) : null;
}

/**
 * Reads and fully validates the mechanical record a ship verdict cites,
 * deriving from it everything the old design took as separately
 * self-declared receipt fields: the tier, whether it's self-serve, the round
 * count against its cap, whether a request was still pending at generation,
 * and -- the diff baseline --
 * `sinceLastReview.head`, the PR head at the moment the record's analysis
 * was generated. Reads the record's committed content at the CURRENT head
 * (`headSha`), never a separately-cited commit: like the receipt itself, the
 * record persists forward in git history once committed, so nothing but
 * `headSha` is needed to reach it. Mirrors `review-budget.mjs`'s
 * `validateRecordReference` for the shared checks and extends it for this
 * file's higher stakes. Returns `{ ok: true, generatedAt, baseline }` or
 * `{ ok: false, detail }`.
 */
function validateAdjudicationRecord(prNumber, recordPath, headSha, cwd, { floor = true } = {}) {
  if (typeof recordPath !== "string" || !recordPath.startsWith(`${ADJUDICATIONS_DIR}/`)) {
    return { ok: false, detail: `recordPath ${JSON.stringify(recordPath)} is not under ${ADJUDICATIONS_DIR}/` };
  }
  const raw = git(["show", `${headSha}:${recordPath}`], cwd);
  if (raw === null) {
    return { ok: false, detail: `cited mechanical record ${recordPath} is not committed at ${headSha.slice(0, 7)}` };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return { ok: false, detail: `${recordPath} is unreadable or malformed JSON (${e.message})` };
  }
  if (record.generator !== "scripts/review-loop-record.mjs") {
    return { ok: false, detail: `${recordPath} was not produced by review-loop-record.mjs (generator: ${JSON.stringify(record.generator)})` };
  }
  if (record.pr !== prNumber) return { ok: false, detail: `${recordPath} describes PR ${record.pr}, not ${prNumber}` };

  if (record.budget?.problem) {
    return {
      ok: false,
      detail: `${recordPath} was generated against a broken budget state (${record.budget.problem}: ${record.budget.detail ?? "no detail"})`,
    };
  }
  const tier = record.budget?.tier;
  if (!TIERS[tier]) {
    return { ok: false, detail: `${recordPath} names an unknown tier ${JSON.stringify(tier)}` };
  }
  const passes = record.rounds?.completedReviewerPasses;
  // The ACTIVE allowance, not the tier's base cap: if David granted extra
  // rounds (a `david`-kind extension) before this adjudication ever
  // happened, the base cap can be crossed while the guard's tripwire still
  // hasn't fired -- ordinary rounds remain available up to the grant. The
  // record's own `budget.allowance` already accounts for every extension
  // active at generation time, which `tierCap(tier)` alone cannot.
  // `JSON.stringify` has no representation for `Infinity` (an uncapped
  // grant serializes as `null`), so a missing/non-finite allowance also
  // means "cannot confirm the tripwire fired" and fails closed the same way.
  // (Codex, #539 round 3.)
  const allowanceField = record.budget?.allowance;
  const cap = Number.isFinite(allowanceField) ? allowanceField : Infinity;
  // `floor: false` is the DIRECT-STOP exemption (Codex, #574 round 3): a
  // record cited by David's own grant-0 receipt proves the baseline and the
  // loop's state, not that a tripwire fired -- his stop needs no tripwire
  // and can land mid-stage. Every other caller keeps the floor: an
  // ADJUDICATION must follow the tripwire it answers.
  if (!Number.isInteger(passes) || (floor && passes < cap)) {
    return {
      ok: false,
      detail:
        `${recordPath} was generated with ${JSON.stringify(passes)} completed reviewer passes, below the ` +
        `loop's active allowance of ${cap === Infinity ? JSON.stringify(allowanceField) : cap} -- an adjudication ` +
        "must follow its tripwire, not precede it",
    };
  }
  if (record.budget?.pendingRequest !== false) {
    return {
      ok: false,
      detail:
        `${recordPath}: budget.pendingRequest is ${JSON.stringify(record.budget?.pendingRequest)}, not false -- ` +
        "an in-flight Codex pass had not returned when this record was generated",
    };
  }
  // A trigger comment and the last completed pass sharing the exact same
  // GitHub-reported second is genuinely indeterminate, not "answered" --
  // `pendingRequest: false` alone can't distinguish the two cases, which is
  // why the record carries `ambiguous` separately. (Codex, #539 round 3.)
  if (record.budget?.ambiguous !== false) {
    return {
      ok: false,
      detail:
        `${recordPath}: budget.ambiguous is ${JSON.stringify(record.budget?.ambiguous)}, not false -- a trigger ` +
        "comment and the last completed pass shared the same reported second, which is indeterminate, not resolved",
    };
  }
  const generatedAt = Date.parse(record.generatedAt ?? "");
  if (!Number.isFinite(generatedAt)) {
    return { ok: false, detail: `${recordPath}.generatedAt is missing or unparseable` };
  }
  // The moment the record's UNDERLYING EVIDENCE (issueComments) was actually
  // read -- always <= generatedAt, and the real freshness boundary for
  // "did a request arrive that this record's own analysis couldn't have
  // seen". `generatedAt` alone overstates freshness: it only says when the
  // FILE was written, which is later than when its data was captured.
  // (Codex, #539 round 3.)
  const evidenceCapturedAt = Date.parse(record.evidenceCapturedAt ?? "");
  if (!Number.isFinite(evidenceCapturedAt)) {
    return { ok: false, detail: `${recordPath}.evidenceCapturedAt is missing or unparseable` };
  }

  if (record.sinceLastReview?.resolved !== true) {
    return { ok: false, detail: `${recordPath}: sinceLastReview.resolved is not true -- the record's own diff baseline never resolved` };
  }
  const baseline = record.sinceLastReview.head;
  if (typeof baseline !== "string" || !/^[0-9a-f]{40}$/i.test(baseline)) {
    return { ok: false, detail: `${recordPath}: sinceLastReview.head is not a full 40-character commit sha (got ${JSON.stringify(baseline)})` };
  }
  if (git(["cat-file", "-e", `${baseline}^{commit}`], cwd) === null) {
    return { ok: false, detail: `${recordPath}: sinceLastReview.head ${baseline.slice(0, 7)} does not resolve to a commit in this checkout` };
  }

  return {
    ok: true,
    generatedAt,
    evidenceCapturedAt,
    baseline,
    // The extension history the record was generated against -- loadLoop's
    // own validated chain at generation time, embedded as {kind, verdict,
    // grant}. The fallback's terminal-verdict check reads it alongside the
    // committed receipts so either view of a standing terminal verdict
    // disqualifies a later adjudication candidate.
    extensions: Array.isArray(record.budget?.extensions) ? record.budget.extensions : [],
  };
}

export function checkAdjudicatedCodex(prNumber, headSha, { cwd, codexOutage = false, latestRequestAt = null } = {}) {
  if (codexOutage) {
    return {
      pass: false,
      detail: "a live Codex outage is in effect; a closed-loop adjudication never overrides BLOCKED -- CODEX UNAVAILABLE",
    };
  }
  if (!headSha) {
    return { pass: false, detail: "no head sha supplied to check ancestry against" };
  }

  // Non-recursive: only DIRECT children of the receipts directory ever
  // count, matching review-budget.mjs's own (non-recursive) directory
  // listing -- a receipt nested in a subdirectory is invisible to the
  // guard's `loadLoop` and would never actually have closed its loop.
  //
  // The `<tree>:<path>` colon form is what actually lists a subdirectory's
  // DIRECT children non-recursively -- `ls-tree <tree> -- <path>` (no colon)
  // instead names the pathspec's own tree entry, not its contents (verified
  // empirically; this cost a full round of test failures to catch). The
  // colon form also errors (rather than returning empty) when the directory
  // doesn't exist yet, which is the ordinary "no receipts committed" state,
  // not a real failure -- treated as zero candidates below.
  const lsOutput = git(["ls-tree", "--name-only", `${headSha}:${LOOP_RECEIPTS_DIR}`], cwd) ?? "";
  const prefix = `loop-extension-${prNumber}-`;
  const candidates = [];
  for (const base of lsOutput.split("\n").filter(Boolean)) {
    if (!base.startsWith(prefix) || !base.endsWith(".json")) continue;
    const seqStr = base.slice(prefix.length, base.length - ".json".length);
    // A zero-padded or otherwise non-round-trip sequence is what `loadLoop`
    // rejects as a bad receipt -- rejecting the WHOLE LOOP, not skipping the
    // file. Silently dropping it here would let this fallback honor a chain
    // the guard refuses, so it fails closed instead. (Codex, #548.)
    if (!/^\d+$/.test(seqStr) || String(Number(seqStr)) !== seqStr) {
      return {
        pass: false,
        detail: `${LOOP_RECEIPTS_DIR}/${base} is not a canonical extension name -- the guard refuses this loop outright, so no receipt in it can be honored`,
      };
    }
    candidates.push({ path: `${LOOP_RECEIPTS_DIR}/${base}`, seq: Number(seqStr) });
  }
  candidates.sort((a, b) => b.seq - a.seq);

  if (!candidates.length) {
    return { pass: false, detail: `no committed, canonically-named loop-extension-${prNumber}-*.json receipt at ${headSha.slice(0, 7)}` };
  }

  // The loop's TERMINAL decision (the highest sequence number) anchors the
  // check -- a superseded verdict is never honored. One david-kind shape IS
  // special-cased below, deliberately: a trailing grant-0 stop-endorsement,
  // which does not supersede the gate recommendation beneath it but ratifies
  // it (David, 2026-08-26). Every other david receipt still disqualifies.
  const terminal = candidates[0];
  const raw = git(["show", `${headSha}:${terminal.path}`], cwd);
  if (raw === null) {
    return { pass: false, detail: `${terminal.path} is listed at ${headSha.slice(0, 7)} but its committed content could not be read` };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (e) {
    return { pass: false, detail: `${terminal.path}: unreadable or malformed JSON (${e.message})` };
  }

  if (receipt.pr !== prNumber) {
    return { pass: false, detail: `${terminal.path}: names PR ${receipt.pr}, not ${prNumber}` };
  }

  // A TRAILING DAVID STOP-ENDORSEMENT (kind "david", grant 0) IS TRANSPARENT
  // rather than a disqualifier (Codex, #574 round 1). Grant 0 is David's
  // "reviewed the gate's recommendation, stop here" decision at a David
  // gate, and the two-tier tripwire's documented zero-round path commits it
  // as the loop's last receipt -- which, without this, wedged the PR
  // permanently: the endorsement's own commit moved HEAD past the last
  // reviewed commit while the unchanged allowance refused another Codex
  // pass, so nothing could ever mint READY. So the receipt VALIDATED below
  // becomes the adjudication immediately beneath the endorsement (the gate
  // recommendation David ruled on), and the endorsement itself joins the
  // allowed bookkeeping diff. A `continue` recommendation is acceptable
  // beneath an endorsement -- David's 0 overrides it into a stop, which is
  // exactly the case the gate exists for -- while `split`/`escalate` stay
  // refused: those hand the PR to further action, and shipping over them is
  // a conversation, not a receipt. A David grant ABOVE zero stays a
  // disqualifier: it reopens the loop, so a fresh pass is owed, not honored
  // bookkeeping.
  // A DIRECT DAVID STOP (Codex, #574 round 3): a product-shaped blocker goes
  // to David immediately -- possibly before any adjudication receipt exists,
  // and possibly mid-stage. His grant-0 receipt then cites its OWN mechanical
  // record (`recordPath`), which supplies the source-derived baseline this
  // fallback's diff bound requires; the tripwire floor is waived because his
  // stop needs no tripwire. Committing that pair is what would otherwise
  // wedge the PR: the receipt's own commit moves HEAD past the last reviewed
  // commit while the unchanged allowance opens no round for another pass.
  if (
    receipt.kind === "david" &&
    receipt.grant === 0 &&
    typeof receipt.recordPath === "string" &&
    receipt.recordPath.trim()
  ) {
    const recordCheck = validateAdjudicationRecord(prNumber, receipt.recordPath, headSha, cwd, { floor: false });
    if (!recordCheck.ok) return { pass: false, detail: `${terminal.path}: ${recordCheck.detail}` };
    if (latestRequestAt !== null) {
      const evidenceSecondFloor = Math.floor(recordCheck.evidenceCapturedAt / 1000) * 1000;
      if (latestRequestAt >= evidenceSecondFloor) {
        return {
          pass: false,
          detail:
            `${terminal.path}: a \`@codex review\` request was posted at ${new Date(latestRequestAt).toISOString()}, ` +
            `at or after the cited record's own evidence capture second -- a fresh review may have been asked for ` +
            "since David stopped this loop, and this receipt cannot answer for it",
        };
      }
    }
    const stopAncestor = isAncestor(recordCheck.baseline, headSha, cwd);
    if (stopAncestor !== true) {
      return {
        pass: false,
        detail:
          `${terminal.path}: the cited record's baseline ${recordCheck.baseline.slice(0, 7)} ` +
          (stopAncestor === null
            ? `could not be checked for ancestry of ${headSha.slice(0, 7)} (git merge-base failed)`
            : `is not an ancestor of ${headSha.slice(0, 7)} -- the branch was rewritten since`),
      };
    }
    const stopAllowed = new Set([terminal.path, receipt.recordPath]);
    const stopChanged = git(["diff", "--no-renames", "--name-only", `${recordCheck.baseline}..${headSha}`], cwd);
    if (stopChanged === null) {
      return { pass: false, detail: `${terminal.path}: could not diff ${recordCheck.baseline.slice(0, 7)}..${headSha.slice(0, 7)}` };
    }
    const stopFiles = stopChanged.split("\n").filter(Boolean);
    const stopOutOfScope = stopFiles.filter((f) => !stopAllowed.has(f));
    if (stopOutOfScope.length) {
      return {
        pass: false,
        detail:
          `${terminal.path}: ${stopOutOfScope.length} file(s) changed since the cited record's baseline that are ` +
          `not this direct stop's own receipt or record (${stopOutOfScope.slice(0, 5).join(", ")}` +
          `${stopOutOfScope.length > 5 ? ", ..." : ""}) -- real content changed, so a fresh Codex pass is required`,
      };
    }
    return {
      pass: true,
      detail:
        `David's direct stop (grant 0, ${terminal.path}) citing ${receipt.recordPath}, baseline ` +
        `${recordCheck.baseline.slice(0, 7)}; ${stopFiles.length} bookkeeping-only file(s) changed since ` +
        `(${stopFiles.join(", ") || "none"}), nothing reviewable`,
      acceptedAt: recordCheck.generatedAt,
    };
  }

  let endorsement = null;
  let candidate = terminal;
  if (receipt.kind === "david" && receipt.grant === 0) {
    if (candidates.length < 2) {
      return {
        pass: false,
        detail:
          `${terminal.path}: a David stop-endorsement (grant 0) with no preceding gate adjudication to endorse ` +
          "and no recordPath of its own -- a direct stop must cite the mechanical record generated when David stopped the loop",
      };
    }
    endorsement = terminal;
    candidate = candidates[1];
    const endorsedRaw = git(["show", `${headSha}:${candidate.path}`], cwd);
    if (endorsedRaw === null) {
      return { pass: false, detail: `${candidate.path} is listed at ${headSha.slice(0, 7)} but its committed content could not be read` };
    }
    try {
      receipt = JSON.parse(endorsedRaw);
    } catch (e) {
      return { pass: false, detail: `${candidate.path}: unreadable or malformed JSON (${e.message})` };
    }
    if (receipt.pr !== prNumber) {
      return { pass: false, detail: `${candidate.path}: names PR ${receipt.pr}, not ${prNumber}` };
    }
  }

  const shipEquivalent =
    receipt.verdict === "ship-with-gaps-recorded" || (endorsement !== null && receipt.verdict === "continue");
  if (receipt.kind !== "adjudication" || !shipEquivalent) {
    return {
      pass: false,
      detail:
        `${candidate.path}: the loop's terminal decision is kind=${JSON.stringify(receipt.kind)} ` +
        `verdict=${JSON.stringify(receipt.verdict)}, not an adjudication ship-with-gaps-recorded` +
        (endorsement ? " or a David-endorsed gate recommendation" : "") +
        " -- either a later extension superseded the ship verdict, or none was ever recorded as the loop's last word",
    };
  }
  // The adjudicator's documented output schema always returns `reasoning`
  // and `gaps` -- a receipt carrying only the minimal pr/kind/verdict
  // triple discards the adjudicator's actual justification and, for this
  // verdict specifically, the durable record of what's knowingly left.
  // (Codex, #539 round 3.)
  if (typeof receipt.reasoning !== "string" || !receipt.reasoning.trim()) {
    return { pass: false, detail: `${candidate.path}: missing the adjudicator's \`reasoning\`` };
  }
  if (!Array.isArray(receipt.gaps)) {
    return { pass: false, detail: `${candidate.path}: missing the adjudicator's \`gaps\` array` };
  }
  // `decidedAt` is when THIS receipt was written -- after the adjudicator
  // actually responded, unlike the record's own `generatedAt`, which is
  // written by step 1 of the tripwire procedure BEFORE the adjudicator is
  // even dispatched. This is the boundary the live snapshot's capture times
  // (reviewThreads, checkRuns, issueComments -- read fresh, right before
  // this merge check runs) are ordered against below, via `acceptedAt`.
  // (Codex, #539 round 3.)
  const decidedAt = Date.parse(receipt.decidedAt ?? "");
  if (!Number.isFinite(decidedAt)) {
    return { pass: false, detail: `${candidate.path}: missing or unparseable \`decidedAt\`` };
  }

  const recordCheck = validateAdjudicationRecord(prNumber, receipt.recordPath, headSha, cwd);
  if (!recordCheck.ok) {
    return { pass: false, detail: `${candidate.path}: ${recordCheck.detail}` };
  }

  // THE CHAIN UNDER THE CANDIDATE MUST BE ONE THE GUARD WOULD ACCEPT. Only
  // the highest-sequence receipt is honored, but review-budget.mjs's rule is
  // that after a terminal adjudication verdict ("split", "escalate",
  // "ship-with-gaps-recorded") only a `david`-kind receipt may follow -- so
  // an adjudication ship receipt committed after a standing terminal verdict
  // is a chain `loadLoop` rejects at load, and honoring it here would let
  // the merge gate accept what the refusal layer forbids. Replayed pairwise
  // over the committed preceding receipts, and again over the record's own
  // embedded extension history; either view showing an adjudication that
  // follows a non-continue adjudication disqualifies the candidate.
  // (Codex, #543 round 4, fixed forward post-merge.)
  const preceding = [];
  for (const { path } of [...candidates].sort((a, b) => a.seq - b.seq)) {
    if (path === candidate.path || (endorsement && path === endorsement.path)) continue;
    const precedingRaw = git(["show", `${headSha}:${path}`], cwd);
    if (precedingRaw === null) {
      return { pass: false, detail: `${path} is listed at ${headSha.slice(0, 7)} but its committed content could not be read` };
    }
    try {
      preceding.push(JSON.parse(precedingRaw));
    } catch (e) {
      return { pass: false, detail: `${path}: unreadable or malformed JSON (${e.message}) -- the chain under the terminal receipt cannot be validated` };
    }
  }
  for (const chain of [[...preceding, receipt], [...recordCheck.extensions, receipt]]) {
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1];
      if (chain[i]?.kind === "adjudication" && prev?.kind === "adjudication" && prev?.verdict !== "continue") {
        return {
          pass: false,
          detail:
            `${candidate.path}: a terminal adjudication verdict ("${prev.verdict}") is standing on this loop -- ` +
            `a further adjudication receipt cannot follow it; only a "david"-kind receipt reopens the loop`,
        };
      }
    }
  }
  if (decidedAt < recordCheck.generatedAt) {
    return {
      pass: false,
      detail:
        `${candidate.path}: decidedAt (${new Date(decidedAt).toISOString()}) predates the cited record's own ` +
        `generatedAt (${new Date(recordCheck.generatedAt).toISOString()}) -- the decision cannot have happened ` +
        "before the record it ruled on was generated",
    };
  }

  // Same-second fail-closed (Codex, #539 rounds 2 and 3): treat a request
  // timestamp anywhere in or after the record's OWN EVIDENCE capture second
  // as ambiguous-or-newer, never provably-earlier. `evidenceCapturedAt` --
  // not `generatedAt` or `decidedAt` -- is the right boundary here: it is
  // the earliest of the three, and the only one that describes how current
  // the record's actual DATA (round counts, pendingRequest) is. A request
  // posted after evidence capture but before generation or decision is
  // invisible to the record's own analysis regardless of how much later the
  // file was written or the verdict was decided.
  if (latestRequestAt !== null) {
    const evidenceSecondFloor = Math.floor(recordCheck.evidenceCapturedAt / 1000) * 1000;
    if (latestRequestAt >= evidenceSecondFloor) {
      return {
        pass: false,
        detail:
          `${candidate.path}: a \`@codex review\` request was posted at ${new Date(latestRequestAt).toISOString()}, ` +
          `at or after the record's own evidence capture second (${new Date(recordCheck.evidenceCapturedAt).toISOString()}) -- ` +
          "a fresh review may have been asked for since the loop closed, and this receipt cannot answer for it",
      };
    }
  }

  const ancestor = isAncestor(recordCheck.baseline, headSha, cwd);
  if (ancestor === null) {
    return {
      pass: false,
      detail:
        `${candidate.path}: could not determine whether the record's baseline ${recordCheck.baseline.slice(0, 7)} is ` +
        `an ancestor of ${headSha.slice(0, 7)} (git merge-base failed -- possibly a shallow clone; fetch full history)`,
    };
  }
  if (!ancestor) {
    return {
      pass: false,
      detail:
        `${candidate.path}: the record's baseline ${recordCheck.baseline.slice(0, 7)} is not an ancestor of ` +
        `${headSha.slice(0, 7)} -- the branch was rewritten since the record was generated`,
    };
  }

  const allowedPaths = new Set(
    endorsement ? [candidate.path, receipt.recordPath, endorsement.path] : [candidate.path, receipt.recordPath],
  );
  const changed = git(["diff", "--no-renames", "--name-only", `${recordCheck.baseline}..${headSha}`], cwd);
  if (changed === null) {
    return { pass: false, detail: `${candidate.path}: could not diff ${recordCheck.baseline.slice(0, 7)}..${headSha.slice(0, 7)}` };
  }
  const files = changed.split("\n").filter(Boolean);
  const outOfScope = files.filter((f) => !allowedPaths.has(f));
  if (outOfScope.length) {
    return {
      pass: false,
      detail:
        `${candidate.path}: ${outOfScope.length} file(s) changed since the record's baseline that are not this ` +
        `adjudication's own receipt, its record, or a trailing David stop-endorsement ` +
        `(${outOfScope.slice(0, 5).join(", ")}${outOfScope.length > 5 ? ", ..." : ""}) -- ` +
        "real content changed since the record was generated, so a fresh Codex pass is required, not this receipt",
    };
  }
  return {
    pass: true,
    detail:
      `adjudicated ${receipt.verdict}${endorsement ? ` with David's stop-endorsement (${endorsement.path})` : ""} ` +
      `at ${new Date(decidedAt).toISOString()}, record generated against ` +
      `${recordCheck.baseline.slice(0, 7)}; ${files.length} bookkeeping-only file(s) changed since ` +
      `(${files.join(", ") || "none"}), nothing reviewable`,
    acceptedAt: decidedAt,
  };
}

/** Item 3: no review thread left open. */
export function checkThreads(reviewThreads) {
  const open = reviewThreads.filter((t) => !t.isResolved);
  if (open.length) {
    return {
      pass: false,
      detail: `${open.length} unresolved thread(s): ${open.map((t) => t.id ?? "?").join(", ")}`,
    };
  }
  return { pass: true, detail: `${reviewThreads.length} thread(s), all resolved` };
}

/**
 * Item 4: the evidence was read AFTER the response it is supposed to reflect.
 *
 * The other three items each read a different collection through a different
 * call, and nothing in the data says which call came first. Threads read at
 * 10:00, a review with findings submitted at 10:01, reviews read at 10:02:
 * every item passes, and the receipt describes a state the PR was never in.
 * (Codex, #490.)
 *
 * So the capture times are attested and checked. There is no way for this
 * process to observe them independently -- as with the snapshot itself, the
 * point is that the ordering must be stated and must hold, not that it can be
 * proved from outside.
 */
export function checkCapture(capturedAt, acceptedAt, now = Date.now()) {
  // Age first: an ordering that holds among four stale reads still describes a
  // state that may have moved on. (Codex, #490.)
  const times = Object.values(capturedAt ?? {}).map((v) => Date.parse(v ?? ""));
  const oldest = times.length ? Math.min(...times) : NaN;
  // EVERY capture must be in the past, not merely the oldest one. Checking
  // only `oldest` let a single future-dated collection ride along beside valid
  // recent ones -- and if that collection were reviewThreads or checkRuns, the
  // future value would also satisfy the ordering comparison below while the
  // read had actually happened before the response. (Codex, #490 round 3.)
  const newest = times.length ? Math.max(...times) : NaN;
  if (!Number.isFinite(oldest) || !Number.isFinite(newest) || now - oldest > MAX_EVIDENCE_AGE_MS || newest > now) {
    return {
      pass: false,
      detail:
        newest > now
          ? `a capture time (${new Date(newest).toISOString()}) is in the future -- capture times are ` +
            "attested, so one that cannot have happened invalidates the attestation"
          : `the evidence was captured ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : "at an unreadable time"}, ` +
            `outside the ${MAX_EVIDENCE_AGE_MS / 60000}-minute window ending now. Re-reading a saved snapshot ` +
            "resets generatedAt but not the data -- capture the pages again.",
    };
  }
  if (!acceptedAt) return { pass: true, detail: "no accepted response to order against" };
  // `<=`, not `<`: GitHub timestamps have second resolution, so a collection
  // read in the same second as the response cannot be shown to postdate it --
  // and this file already treats an exact request/response tie as unanswered
  // for that reason. (Codex, #490.)
  //
  // `issueComments` is in the list because the REQUEST SET comes from it: read
  // before the accepted pass, it can miss a retry request posted after that
  // pass was requested, and the one-pass-per-request rule then counts a set it
  // never saw. An early read of the request set is exactly as dangerous as an
  // early read of the threads. (Codex, #490 round 3.)
  //
  // The boundary is the END of the response's reported second, not the second
  // itself. The two operands have different precision: GitHub reports events
  // to the second, while a capture time carries milliseconds. A review
  // actually submitted at 04:10:00.900 is reported as 04:10:00.000, so a
  // collection captured at 04:10:00.500 -- genuinely BEFORE it -- compared
  // greater and passed. (Codex, #490 round 5.)
  const stale = ["reviewThreads", "checkRuns", "issueComments"].filter(
    (key) => Date.parse(capturedAt?.[key] ?? "") <= acceptedAt + 999,
  );
  if (stale.length) {
    return {
      pass: false,
      detail:
        `${stale.join(" and ")} ${stale.length > 1 ? "were" : "was"} read before the Codex response at ` +
        `${new Date(acceptedAt).toISOString()}, so ${stale.length > 1 ? "they describe" : "it describes"} ` +
        "a state that predates it -- re-read after the response lands",
    };
  }
  return { pass: true, detail: "read after the accepted response" };
}

/**
 * Completed reviewer passes in this snapshot, by the guard's own counter --
 * the number `checkRail` binds David's latest grant against. Null (fail
 * closed in the one branch that reads it) when the count cannot be taken,
 * because "could not count" must never read as "still inside the grant".
 */
function countDelivered(snapshot) {
  try {
    return reviewerPasses(snapshot.reviews ?? [], snapshot.issueComments ?? []).length;
  } catch {
    return null;
  }
}

/** The full verdict for a validated snapshot. */
export function evaluate(snapshot, now = Date.now(), adjudicationOpts = {}) {
  const headSha = snapshot.pr.head.sha;
  const directCodex = checkCodex(snapshot.issueComments, snapshot.reviews, headSha);
  // A closed review-loop adjudication (see checkAdjudicatedCodex) is a
  // fallback, never a replacement: it is only even attempted when a live
  // Codex pass didn't satisfy the bar on its own, and its own bound (ancestry
  // + exact-file diff, a live outage, and a newer request all still refuse
  // it) is what keeps it from becoming a standing bypass. On success its
  // `acceptedAt` is the adjudication record's own `generatedAt` -- the
  // moment the decision this receipt reports actually happened -- so
  // `checkCapture` orders the other collections against it exactly as it
  // orders them against a live Codex response.
  const adjudicated = directCodex.pass
    ? null
    : checkAdjudicatedCodex(snapshot.pr.number, headSha, {
        codexOutage: Boolean(directCodex.outage),
        latestRequestAt: latestReviewRequestAt(snapshot.issueComments ?? []),
        ...adjudicationOpts,
      });
  const codex =
    adjudicated?.pass
      ? { pass: true, detail: adjudicated.detail, acceptedAt: adjudicated.acceptedAt }
      : adjudicated
        ? { ...directCodex, detail: `${directCodex.detail} | adjudication fallback also failed: ${adjudicated.detail}` }
        : directCodex;
  const items = {
    ci: checkCi(snapshot.checkRuns, headSha),
    codex,
    threads: checkThreads(snapshot.reviewThreads),
    capture: checkCapture(snapshot.capturedAt, codex.acceptedAt, now),
    rail: checkRail(snapshot.pr.number, headSha, adjudicationOpts.cwd, countDelivered(snapshot)),
  };
  const ready = Object.values(items).every((i) => i.pass);
  const captureTimes = Object.values(snapshot.capturedAt ?? {}).map((v) => Date.parse(v ?? ""));
  const oldest = captureTimes.filter(Number.isFinite);
  return {
    verdict: ready ? "READY" : items.codex.outage ? "BLOCKED -- CODEX UNAVAILABLE" : "NOT READY",
    pr: snapshot.pr.number,
    repo: snapshot.repo,
    headSha,
    branch: snapshot.pr.head.ref,
    generatedAt: new Date(now).toISOString(),
    // When the EVIDENCE was read, which is what the merge gate ages against.
    // `generatedAt` only says when this process ran. (Codex, #490.)
    evidenceAt: oldest.length ? new Date(Math.min(...oldest)).toISOString() : null,
    items,
  };
}

/**
 * The David gate, enforced at merge time (Codex, #543 round 3; re-sited by
 * the two-tier tripwire, David, 2026-08-26).
 *
 * The contract says a loop whose allowance reaches its budget plus the
 * self-serve leash (plus any earlier David grants) goes to David REGARDLESS
 * of the adjudicator's recommendation -- but without this check, a clean
 * final pass (or a terminal ship receipt at gate allowance) satisfies the
 * Codex item and the PR mints READY with David never consulted. Reads the
 * committed budget receipt at the head; no budget (internal work merged on
 * a clean automatic pass, or no loop) means the gate does not apply. When
 * the fully-activated allowance has reached the gate, only a loop whose
 * LAST extension is a `david`-kind receipt is ready -- a grant reopens the
 * loop, a grant of 0 endorses the stop, and either way his consultation is
 * the one thing the gate exists to guarantee.
 */
export function checkRail(prNumber, headSha, cwd, delivered = null) {
  const budgetRaw = git(["show", `${headSha}:${LOOP_RECEIPTS_DIR}/loop-budget-${prNumber}.json`], cwd);
  if (budgetRaw === null) return { pass: true, detail: "no committed round budget -- the David gate does not apply" };
  let budget;
  try {
    budget = JSON.parse(budgetRaw);
  } catch (e) {
    return { pass: false, detail: `committed budget receipt is unreadable (${e.message}) -- cannot rule out the rail` };
  }
  // The guard's own validation, not a bare tier read: an unvalidated budget
  // (wrong PR, tier/number mismatch) must not anchor a rail decision.
  const budgetError = validateBudget(prNumber, budget);
  if (budgetError) {
    return { pass: false, detail: `committed budget receipt is invalid (${budgetError}) -- cannot rule out the rail` };
  }
  const tier = budget.tier;

  const lsOutput = git(["ls-tree", "--name-only", `${headSha}:${LOOP_RECEIPTS_DIR}`], cwd) ?? "";
  const prefix = `loop-extension-${prNumber}-`;
  // A name matching this PR's extension prefix but NOT canonically numbered
  // fails CLOSED, never silently dropped: `loadLoop` refuses the whole loop
  // on such a name, so ignoring it here would let this check pass a chain
  // the guard rejects. (Codex, #548.) Files that don't match the prefix at
  // all (budgets, other PRs' receipts) are simply not this loop's.
  const named = [];
  for (const base of lsOutput.split("\n").filter((b) => b.startsWith(prefix) && b.endsWith(".json"))) {
    const seqStr = base.slice(prefix.length, base.length - ".json".length);
    if (!/^\d+$/.test(seqStr) || String(Number(seqStr)) !== seqStr) {
      return {
        pass: false,
        detail: `${LOOP_RECEIPTS_DIR}/${base} is not a canonical extension name -- the guard refuses this loop outright, so the rail cannot be ruled out`,
      };
    }
    named.push({ seq: Number(seqStr), base });
  }
  const extensionsRaw = named
    .sort((a, b) => a.seq - b.seq)
    .map(({ base }) => {
      const raw = git(["show", `${headSha}:${LOOP_RECEIPTS_DIR}/${base}`], cwd);
      try {
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    });
  if (extensionsRaw.some((e) => e === null)) {
    return { pass: false, detail: "a committed extension receipt is unreadable -- cannot rule out the rail" };
  }

  // EVERY receipt in the chain is validated with the guard's own rules
  // before any arithmetic runs on it. Without this, a malformed receipt like
  // `{"kind":"david"}` -- no grant, no authorization -- fed `allowance()` an
  // `undefined` grant, the total went NaN, `NaN < rail` was false, and the
  // bare last-kind check below then cleared the rail with no actual David
  // authorization on record. Pure-validation mode (`io: null`) checks
  // structure and the terminal-verdict chain rule, which is everything the
  // rail decision rests on. (Codex, #543 round 4, fixed forward post-merge.)
  const extensions = [];
  for (const ext of extensionsRaw) {
    const extError = validateExtension(prNumber, tier, ext, { io: null, ref: null, preceding: extensions });
    if (extError) {
      return { pass: false, detail: `a committed extension receipt is invalid (${extError}) -- cannot rule out the rail` };
    }
    extensions.push(ext);
  }

  // A STANDING "split" OR "escalate" VERDICT BLOCKS READINESS OUTRIGHT,
  // whatever the allowance. Those verdicts hand the PR to further human or
  // agent action -- and this is the one check on evaluate()'s ALWAYS-RUN
  // path, so it is where the rule must live: a live Codex pass posted after
  // the terminal receipt skips `checkAdjudicatedCodex` entirely, and
  // without this a below-rail allowance minted READY with the loop's own
  // last word saying "do not merge yet". `ship-with-gaps-recorded` is
  // deliberately not blocked here -- it IS a "this is ready" verdict, and
  // the fallback path fully validates it. (Codex, #548.)
  const standing = extensions[extensions.length - 1];
  if (standing?.kind === "adjudication" && (standing.verdict === "split" || standing.verdict === "escalate")) {
    return {
      pass: false,
      detail:
        `a terminal adjudication verdict ("${standing.verdict}") is standing on this loop -- readiness cannot ` +
        `be established, with or without a live pass, until a "david"-kind receipt reopens it`,
    };
  }

  // Fully activated: what the allowance becomes once everything is spent.
  const activated = allowance(tier, extensions, Number.MAX_SAFE_INTEGER);
  const rail = railFor(tier, extensions);
  // Validation above makes NaN unreachable; this is the fail-closed backstop
  // so any future gap in it blocks a merge instead of waving one through.
  if (activated !== Infinity && !Number.isFinite(activated)) {
    return { pass: false, detail: "the loop's activated allowance is not a number -- cannot rule out the David gate" };
  }
  if (activated < rail) return { pass: true, detail: `allowance ${activated} is below the ${rail}-round David gate` };
  // The look-through added on 2026-08-21 for a trailing internal terminal
  // receipt is gone with the receipt itself (David, 2026-08-22): under the
  // write-gate rule no tier commits a terminal receipt mid-budget, so
  // nothing can shadow a David authorization at the gate.
  const last = extensions[extensions.length - 1];
  if (last?.kind === "david") {
    // A DAVID RECEIPT CLEARS THE GATE IT ANSWERS, NOT EVERY GATE AFTER IT
    // (Codex, #574 round 2). The gate repeats where his grant runs out, and
    // the guard's refusal only bites on the NEXT review request -- which a
    // loop that stops unconverged at the boundary never posts. Without a
    // round-count binding here, a historically-latest positive grant read
    // as permanently clearing the gate, and a loop could mint READY at the
    // spent boundary without the fresh Fable recommendation and David
    // decision the repeating gate requires. So:
    //   - grant 0 (a stop-endorsement) clears permanently: no further
    //     rounds can run behind it without a NEWER david receipt, which
    //     would then be the latest.
    //   - "uncapped" clears permanently: there is no boundary to respect.
    //   - a positive grant clears only while the delivered pass count is
    //     still BELOW the gate it established -- his rounds are running.
    //     At or past it, the gate stands again, whatever this receipt says.
    //   - an unknown delivered count fails closed: "could not count" must
    //     not read as "still inside the grant".
    if (last.grant === 0) {
      return { pass: true, detail: `David endorsed stopping at the ${rail}-round gate (grant 0) as the loop's latest extension` };
    }
    if (last.grant === "uncapped") {
      return { pass: true, detail: "David's latest authorization is uncapped -- no gate stands" };
    }
    if (!Number.isInteger(delivered) || delivered < 0) {
      return {
        pass: false,
        detail:
          `David's latest grant establishes a gate at ${rail} rounds, but the delivered pass count could not ` +
          "be determined -- refusing rather than assuming his rounds are still running",
      };
    }
    if (delivered < rail) {
      return { pass: true, detail: `inside David's latest grant: ${delivered} of ${rail} authorized rounds delivered` };
    }
    return {
      pass: false,
      detail:
        `David's latest grant is fully spent (${delivered} passes delivered, gate at ${rail}) -- the gate stands ` +
        `again: a fresh Fable recommendation and his decision (a further grant, or a grant-0 stop-endorsement) ` +
        "are required before readiness",
    };
  }
  return {
    pass: false,
    detail:
      `this loop's allowance has reached the David gate (${rail} rounds -- its budget plus the self-serve ` +
      `leash plus any earlier David grants), which goes to David regardless of the adjudicator's ` +
      `recommendation; no "david"-kind receipt is the latest extension, so readiness cannot be self-served`,
  };
}

/**
 * Why a stored receipt can no longer be shown as current, or null if it can.
 *
 * THE merge hook calls this too, rather than keeping its own copy. The
 * previous revision claimed the predicate was shared and only half was:
 * `checkMerge` still had its own constant and its own timestamp arithmetic,
 * so a later change to the window or the field would have made the manual
 * READY surface and the actual merge guard disagree about one receipt --
 * which is exactly the drift the sharing was supposed to remove.
 * (Codex, #490 round 4.)
 */
export function staleReason(receipt, now = Date.now()) {
  if (!receipt?.evidenceAt) {
    return "this receipt records no evidenceAt, so its age describes when the check ran rather than when the PR was read -- re-run with a fresh snapshot";
  }
  const age = now - Date.parse(receipt.evidenceAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_EVIDENCE_AGE_MS) {
    return (
      `this receipt rests on evidence read ${receipt.evidenceAt} and is no longer current ` +
      `(older than ${MAX_EVIDENCE_AGE_MS / 60000} minutes). Reviews land and CI re-runs -- ` +
      "re-run with a fresh snapshot before quoting it"
    );
  }
  return null;
}

export function receiptPath(prNumber) {
  return join(RECEIPT_DIR, `pr-${prNumber}.json`);
}

const LABEL = {
  ci: "CI green",
  codex: "Codex returned",
  threads: "Threads resolved",
  capture: "Evidence ordering",
  rail: "David gate",
};

export function formatReceipt(receipt) {
  const lines = [
    `PR #${receipt.pr} @ ${receipt.headSha.slice(0, 7)} -- ${receipt.verdict}`,
    ...Object.entries(receipt.items).map(
      ([key, item]) => `  ${item.pass ? "PASS" : "FAIL"}  ${LABEL[key]}: ${item.detail}`,
    ),
    `  checked ${receipt.generatedAt}`,
  ];
  return lines.join("\n");
}

/**
 * How long to wait for the remote to answer. ONE deadline, because there is
 * one resolver: `--show` and the merge hook previously had their own copies
 * with 15s and 8s, so a `ls-remote` taking 12s let the display path print
 * READY for a receipt the hook would refuse as unresolvable. Two paths
 * disagreeing about the same authority is the drift the shared predicate was
 * meant to end. (Codex, #490 round 5.)
 */
const REMOTE_TIP_TIMEOUT_MS = 8000;

/**
 * The branch's tip as the REMOTE reports it. `git rev-parse` would answer from
 * this checkout, which cannot know what GitHub would merge.
 *
 * `origin` IS THE AUTHORITY ONLY FOR SAME-REPO HEADS, which is why the receipt
 * refuses to be minted for a fork PR rather than resolving one here. `git
 * ls-remote`'s positional is a repository, so a fork's head branch lives
 * somewhere `origin` cannot see: the lookup normally returns null and blocks an
 * otherwise-ready PR forever, and a fork branch that happens to share a name
 * with one of ours (`main` is the common case) resolves an unrelated tip
 * instead. (Codex, #490 round 6.) The refusal is in `assertSnapshot`, at
 * capture time, so the failure is one explicit message rather than a confusing
 * unresolvable-tip denial an hour later.
 */
export function remoteTip(branch) {
  if (typeof branch !== "string" || branch.trim() === "") return null;
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
      encoding: "utf8",
      timeout: REMOTE_TIP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (/^([0-9a-f]{40})\s/m.exec(out) ?? [])[1] ?? null;
  } catch {
    // Network failure, or no such branch. Both deny, per checkMerge.
    return null;
  }
}

function parseArgs(argv) {
  const args = { pr: null, snapshot: null, show: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pr") args.pr = Number(argv[++i]);
    else if (argv[i] === "--snapshot") args.snapshot = argv[++i];
    else if (argv[i] === "--show") args.show = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.pr)) {
    process.stderr.write("usage: node scripts/pr-ready.mjs --pr <N> --snapshot <file> [--show]\n");
    return 2;
  }

  if (args.show) {
    const p = receiptPath(args.pr);
    if (!existsSync(p)) {
      process.stderr.write(`no receipt for PR #${args.pr}\n`);
      return 1;
    }
    const receipt = JSON.parse(readFileSync(p, "utf8"));
    process.stdout.write(`${formatReceipt(receipt)}\n`);
    // `--show` is the manual-merge path: for a PR David merges, quoting this
    // output IS the control, because no hook sees his click. Printing a stored
    // verdict without re-applying the age check would present an hours-old
    // READY as current -- past a failed re-run or a reopened thread. The merge
    // hook has always aged the receipt; this path had not. (Codex, #490.)
    const stale = staleReason(receipt);
    if (stale) {
      process.stderr.write(`pr-ready: ${stale}\n`);
      return 1;
    }
    // And the head, not only the age. A push inside the one-hour window leaves
    // a receipt that is current but describes a commit that would no longer
    // merge -- the hooked path rejects exactly that via its remote-tip
    // comparison, and this path is the one where no hook is watching.
    // (Codex, #490 round 4.)
    const tip = remoteTip(receipt.branch);
    if (!tip) {
      process.stderr.write(
        `pr-ready: could not resolve the current tip of ${receipt.branch}, so this receipt cannot be shown to describe the commit that would merge\n`,
      );
      return 1;
    }
    if (tip !== receipt.headSha) {
      process.stderr.write(
        `pr-ready: this receipt validated ${receipt.headSha.slice(0, 7)}, but ${receipt.branch} is now at ${tip.slice(0, 7)} -- re-run with a fresh snapshot\n`,
      );
      return 1;
    }
    return receipt.verdict === "READY" ? 0 : 1;
  }

  if (!args.snapshot) {
    process.stderr.write("--snapshot is required\n");
    return 2;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(args.snapshot, "utf8"));
    assertSnapshot(snapshot, args.pr);
  } catch (e) {
    process.stderr.write(`pr-ready: ${e.message}\n`);
    return 2;
  }

  const receipt = evaluate(snapshot);
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(receiptPath(args.pr), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${formatReceipt(receipt)}\n`);
  return receipt.verdict === "READY" ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) process.exit(main());
