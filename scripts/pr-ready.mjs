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
  const sha = pr.head?.sha;
  if (typeof sha !== "string" || sha.length < 7) {
    throw fail('snapshot.pr.head.sha is required -- the receipt is bound to the commit it validated');
  }

  const complete = snapshot.complete ?? {};
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
  }

  // A thread with no resolution flag would fall through an `!== false` test and
  // read as resolved -- the silent-undercount failure this file exists to stop.
  snapshot.reviewThreads.forEach((t, i) => {
    if (typeof t?.isResolved !== "boolean") {
      throw fail(`snapshot.reviewThreads[${i}] has no boolean isResolved`);
    }
  });
  for (const [key, field] of [["issueComments", "created_at"], ["reviews", "submitted_at"]]) {
    snapshot[key].forEach((c, i) => {
      if (!c?.[field]) throw fail(`snapshot.${key}[${i}] has no ${field}`);
    });
  }
}

const authorOf = (c) => c?.user?.login ?? c?.author?.login ?? c?.author ?? "";
const bodyOf = (c) => c?.body ?? "";
const timeOf = (c) => Date.parse(c?.created_at ?? c?.submitted_at ?? 0) || 0;

/** Item 1: every check run finished, and none of them failed. */
export function checkCi(checkRuns) {
  if (checkRuns.length === 0) {
    return { pass: false, detail: "no check runs reported for the head commit -- CI has not started" };
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
  return { pass: true, detail: `${checkRuns.length} checks, all passing` };
}

/**
 * Item 2: a review round was requested, and Codex has answered the LATEST one.
 *
 * The ordering comparison is the whole point. "Codex has reviewed this PR at
 * some point" was true of #458 and would have passed a naive check while a
 * requested round was still outstanding; what has to be true is that no
 * request is newer than the newest response.
 */
export function checkCodex(issueComments, reviews) {
  const requests = issueComments.filter(
    (c) => authorOf(c) !== CODEX_BOT && REVIEW_REQUEST.test(bodyOf(c)),
  );
  if (requests.length === 0) {
    return {
      pass: false,
      detail: "no `@codex review` request found -- the review loop was never started (this is the PR #487 failure)",
    };
  }

  const responses = [
    ...reviews.filter((r) => authorOf(r) === CODEX_BOT),
    ...issueComments.filter(
      (c) => authorOf(c) === CODEX_BOT && !SECURITY_BOUNCE.test(bodyOf(c)),
    ),
  ];
  if (responses.length === 0) {
    return {
      pass: false,
      detail:
        `${requests.length} review request(s), no Codex response yet ` +
        "(a security-review usage bounce does not count -- it is metered separately from code review)",
    };
  }

  const latestRequest = Math.max(...requests.map(timeOf));
  const latestResponse = Math.max(...responses.map(timeOf));
  if (latestRequest > latestResponse) {
    return {
      pass: false,
      detail:
        `round ${requests.length} requested at ${new Date(latestRequest).toISOString()} has not been ` +
        `answered (latest Codex response ${new Date(latestResponse).toISOString()}) -- ` +
        "a requested-but-not-received round is not convergence",
    };
  }
  return {
    pass: true,
    detail: `${requests.length} round(s); latest answered at ${new Date(latestResponse).toISOString()}`,
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

/** The full three-item verdict for a validated snapshot. */
export function evaluate(snapshot, now = Date.now()) {
  const items = {
    ci: checkCi(snapshot.checkRuns),
    codex: checkCodex(snapshot.issueComments, snapshot.reviews),
    threads: checkThreads(snapshot.reviewThreads),
  };
  const ready = Object.values(items).every((i) => i.pass);
  return {
    verdict: ready ? "READY" : "NOT READY",
    pr: snapshot.pr.number,
    headSha: snapshot.pr.head.sha,
    branch: snapshot.pr.head.ref ?? null,
    generatedAt: new Date(now).toISOString(),
    items,
  };
}

export function receiptPath(prNumber) {
  return join(RECEIPT_DIR, `pr-${prNumber}.json`);
}

const LABEL = { ci: "CI green", codex: "Codex converged", threads: "Threads resolved" };

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
