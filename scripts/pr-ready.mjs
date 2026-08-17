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
 * passes them in -- the same adapter shape `loop-metrics.mjs --mcp-snapshot`
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
 * Measured, not assumed: `loop-metrics.mjs` established this against #286,
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
 * Same reasoning as `loop-metrics.mjs`'s equivalent: this process cannot page
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
  // When the head commit came into existence. Required because it is the only
  // bound available that cannot POSTDATE the head, and a bound that is too
  // late silently drops review requests from the count. (Codex, #490.)
  if (!Number.isFinite(Date.parse(pr.head?.committedAt ?? ""))) {
    throw fail(
      'snapshot.pr.head.committedAt must be the head commit\'s ISO committer date ' +
        "(get_commits, the last commit's commit.committer.date) -- it bounds which review requests belong to this head",
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
export function checkCodex(issueComments, reviews, headSha = null, headBornAt = null) {
  const requests = issueComments
    .filter((c) => authorOf(c) !== CODEX_BOT && REVIEW_REQUEST.test(bodyOf(c)))
    .sort((a, b) => timeOf(a) - timeOf(b));
  if (requests.length === 0) {
    return {
      pass: false,
      detail: "no `@codex review` request found -- the review loop was never started (this is the PR #487 failure)",
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

  // A completed pass: connector-authored, carrying the marker, with the sha it
  // reviewed. No `commit_id` fallback -- GitHub sets that field on every review
  // object, including status and error ones, so it promoted non-passes into
  // this set. (Codex, #490.)
  const passes = [...reviews, ...issueComments]
    .filter((c) => authorOf(c) === CODEX_BOT && !SECURITY_BOUNCE.test(bodyOf(c)))
    .map((c) => ({ at: timeOf(c), sha: (bodyOf(c).match(REVIEWED_COMMIT_MARKER) ?? [])[1] ?? null }))
    .filter((p) => p.sha);

  // The single element that must exist. Strict `>` on the ordering: GitHub
  // timestamps have second resolution, so a tie is treated as unanswered.
  const qualifying = passes.filter(
    (p) => p.at > requestedAt && (!headSha || sameCommit(p.sha, headSha)),
  );

  // ONE PASS PER REQUEST ON THIS HEAD, not one pass for the latest request.
  //
  // The stall-and-retry shape defeats the single-element rule on its own:
  // `pr-watch` permits one retry when a round produces no review, and that
  // retry needs no push, so both requests name the same commit. A late
  // response to the FIRST request then postdates the retry and matches the
  // head -- indistinguishable, in the data, from a response to the retry. It
  // would mint READY with a round still outstanding, which is exactly the
  // PR #458 failure arriving through a different door. (Codex, #490 round 3.)
  //
  // GitHub exposes nothing that ties a review to the request that triggered
  // it, so this ambiguity is IRREDUCIBLE -- and the response is to stop trying
  // to resolve it and take the safe side: every request made since this commit
  // appeared must be answered by its own pass.
  //
  // The accepted cost, stated rather than discovered later: if Codex ever
  // answers two requests with a single review, this blocks until the head
  // moves. That is escapable (any push restarts the count, and a new head
  // needs a fresh review anyway) and it is the over-blocking direction.
  const onThisHead = headBornAt ? requests.filter((r) => timeOf(r) >= headBornAt) : requests;
  if (qualifying.length && qualifying.length < onThisHead.length) {
    return {
      pass: false,
      detail:
        `${onThisHead.length} review requests on ${headSha ? headSha.slice(0, 7) : "this head"} but only ` +
        `${qualifying.length} completed pass(es). Nothing in GitHub's data ties a review to the request ` +
        `that triggered it, so a late response to an earlier request cannot be told apart from a response ` +
        `to the latest one -- this fails closed rather than guess. Wait for the outstanding round; if Codex ` +
        `answered both requests with one review, push and take a fresh pass on the new head.`,
    };
  }

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
  const stale = ["reviewThreads", "checkRuns", "issueComments"].filter(
    (key) => Date.parse(capturedAt?.[key] ?? "") <= acceptedAt,
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

/** The full verdict for a validated snapshot. */
export function evaluate(snapshot, now = Date.now()) {
  const headSha = snapshot.pr.head.sha;
  // A bound that CANNOT postdate the head's appearance, which is what
  // separates review requests made for THIS commit from ones made for an
  // earlier one.
  //
  // The first version used the earliest check run's `started_at`, and that is
  // too LATE: a request posted right after a push but before CI starts falls
  // outside it, so a retry plus one late pass reads as complete while the
  // excluded request is still outstanding. The commit's own committer date is
  // the right bound -- it necessarily precedes the push, and a backdated
  // commit only moves it earlier, which retains more requests and over-blocks.
  // (Codex, #490 round 4.)
  const headBornAt = Date.parse(snapshot.pr.head.committedAt);
  const codex = checkCodex(snapshot.issueComments, snapshot.reviews, headSha, headBornAt);
  const items = {
    ci: checkCi(snapshot.checkRuns, headSha),
    codex,
    threads: checkThreads(snapshot.reviewThreads),
    capture: checkCapture(snapshot.capturedAt, codex.acceptedAt, now),
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
 * The branch's tip as the REMOTE reports it. `git rev-parse` would answer from
 * this checkout, which cannot know what GitHub would merge.
 */
function remoteTip(branch) {
  if (typeof branch !== "string" || branch.trim() === "") return null;
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
      encoding: "utf8",
      timeout: 15000,
    });
    return (/^([0-9a-f]{40})\s/m.exec(out) ?? [])[1] ?? null;
  } catch {
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
