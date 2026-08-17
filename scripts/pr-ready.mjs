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
 * The Codex comment that is NOT a review.
 *
 * Codex meters security reviews and code reviews separately, and a security
 * bounce says nothing whatever about code-review availability -- CLAUDE.md
 * spells this out because treating the bounce as "Codex responded" is exactly
 * how an outstanding round gets mistaken for a finished one. Matching on the
 * bounce text is payload-text matching, which this repo generally avoids, but
 * here the text IS the signal and the failure direction is safe: an
 * unrecognised bounce variant makes the gate stricter, never looser.
 */
const SECURITY_BOUNCE = /usage limits for security reviews/i;

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

const authorOf = (c) => c?.user?.login ?? c?.author?.login ?? c?.author ?? "";
const bodyOf = (c) => c?.body ?? "";
const timeOf = (c) => Date.parse(c?.created_at ?? c?.submitted_at ?? 0) || 0;

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
 * A CLEAN pass counts exactly like a finding-bearing one. It arrives in one of
 * two shapes and both are accepted: a `**Reviewed commit:**` announcement
 * posted as a plain issue comment (the measured signal -- see the marker's own
 * note), or a thumbs-up reaction on the request comment.
 *
 * The reaction path can only be a COUNT, not an identity: GitHub's comment
 * payload carries reaction totals, not who left them. On a `@codex review`
 * comment in this repo a `+1` is the connector, so it is accepted -- and it
 * satisfies currency (3) because it sits on the *latest* request, which by the
 * cumulative-diff discipline is posted after the latest push. That inference is
 * the one soft edge here, and it is stated rather than buried.
 */
export function checkCodex(issueComments, reviews, headSha = null) {
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

  // A completed pass, whichever collection it landed in.
  const announcements = [...reviews, ...issueComments]
    .filter((r) => authorOf(r) === CODEX_BOT && !SECURITY_BOUNCE.test(bodyOf(r)))
    .map((r) => ({ at: timeOf(r), sha: (bodyOf(r).match(REVIEWED_COMMIT_MARKER) ?? [])[1] ?? r.commit_id ?? null }))
    .filter((a) => a.sha);

  const thumbsUp = (latestRequest.reactions?.["+1"] ?? 0) > 0;

  if (announcements.length === 0 && !thumbsUp) {
    return {
      pass: false,
      detail:
        `${requests.length} review request(s), no completed Codex pass yet. A pass announces ` +
        "`**Reviewed commit:**` (in a review when it found something, in a plain issue comment when it " +
        "didn't) or reacts 👍 on the request. A security-review usage bounce is neither -- it is metered " +
        "separately from code review. If a 👍 is present, capture `reactions` on the issue comments.",
    };
  }

  const latestAnnouncement = announcements.length ? Math.max(...announcements.map((a) => a.at)) : 0;
  if (!thumbsUp && timeOf(latestRequest) >= latestAnnouncement) {
    return {
      pass: false,
      detail:
        `round ${requests.length} requested at ${new Date(timeOf(latestRequest)).toISOString()} has not ` +
        `come back (latest completed pass ${new Date(latestAnnouncement).toISOString()}) -- ` +
        "a requested-but-not-received round is not convergence. GitHub timestamps have second " +
        "resolution, so an exact tie is treated as unanswered rather than answered.",
    };
  }

  if (headSha && !thumbsUp) {
    const covering = announcements.filter((a) => sameCommit(a.sha, headSha));
    if (covering.length === 0) {
      const reviewed = [...new Set(announcements.map((a) => a.sha.slice(0, 7)))].join(", ");
      return {
        pass: false,
        detail:
          `the latest pass reviewed ${reviewed}, but the head commit is ${headSha.slice(0, 7)}. ` +
          "A pass on an earlier commit is not a pass on the diff that would merge -- request a round on " +
          "the current head.",
      };
    }
  }

  const how = thumbsUp ? "👍 on the latest request" : `pass on ${headSha ? headSha.slice(0, 7) : "head"}`;
  // `acceptedAt` is what the capture-ordering check needs: the moment the
  // response being relied on appeared. Threads read before it prove nothing.
  const acceptedAt = thumbsUp ? timeOf(latestRequest) : latestAnnouncement;
  return { pass: true, detail: `${requests.length} round(s); returned (${how})`, acceptedAt };
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
export function checkCapture(capturedAt, acceptedAt) {
  if (!acceptedAt) return { pass: true, detail: "no accepted response to order against" };
  const stale = ["reviewThreads", "checkRuns"].filter(
    (key) => Date.parse(capturedAt?.[key] ?? "") < acceptedAt,
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
  const codex = checkCodex(snapshot.issueComments, snapshot.reviews, headSha);
  const items = {
    ci: checkCi(snapshot.checkRuns, headSha),
    codex,
    threads: checkThreads(snapshot.reviewThreads),
    capture: checkCapture(snapshot.capturedAt, codex.acceptedAt),
  };
  const ready = Object.values(items).every((i) => i.pass);
  return {
    verdict: ready ? "READY" : "NOT READY",
    pr: snapshot.pr.number,
    headSha,
    branch: snapshot.pr.head.ref,
    generatedAt: new Date(now).toISOString(),
    items,
  };
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
