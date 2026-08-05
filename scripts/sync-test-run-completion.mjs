#!/usr/bin/env node
/**
 * Detect a deleted TEST_RUN doc on a push to main and transition that PR's
 * workstream issue past `stage:test-run`.
 *
 * Per the `pr-docs` contract, `docs/PR<N>_<FEATURE>_TEST_RUN.md` is transient:
 * David deletes it once Replit has actually run the checklist, and that
 * deletion is the ONLY completion signal that exists — there is no other
 * event to hook. Before this script, nothing with write access was guaranteed
 * to ever notice a deletion and move the label, so a workstream could sit at
 * `stage:test-run`/`waiting:replit` indefinitely even after Replit finished
 * (Codex flagged this twice, as a P1, reviewing PR #334). This closes that
 * gap the same way `sync-project-fields.mjs` closes the labels-to-board gap:
 * a small, focused Action that reacts to the one event that matters.
 *
 * Scope, deliberately narrow: this only handles the `stage:test-run` ->
 * `stage:uat`/`stage:close-out` transition. It never touches any other
 * stage — those already have a real actor (`pr-watch`, `plan-review-loop`,
 * `bugfix`) engaged at the moment they fire.
 */

import { execFileSync } from "node:child_process";

/** Extract the PR number from a deleted TEST_RUN doc's path, or null. */
export function extractPrNumberFromTestRunPath(path) {
  const m = /^docs\/PR(\d+)_.+_TEST_RUN\.md$/.exec(path);
  return m ? Number(m[1]) : null;
}

/**
 * Pull the workstream issue number out of a PR body. Same regex documented
 * in `.claude/skills/workstream-status/SKILL.md` and used by that skill's
 * issue<->PR mapping — kept in sync by hand since the two live in different
 * runtimes (a GitHub Action here, an agent's own instructions there).
 */
export function extractWorkstreamIssueNumber(prBody) {
  const m = /Workstream:\s*#(\d+)/.exec(prBody ?? "");
  return m ? Number(m[1]) : null;
}

/** True if `docs/` (as returned by the Contents API) has a UAT doc for `prNumber`. */
export function hasUatDoc(docsFilenames, prNumber) {
  const re = new RegExp(`^PR${prNumber}_.+_UAT\\.md$`);
  return docsFilenames.some((name) => re.test(name));
}

/**
 * The lifecycle's own display names for the board/State-of-Play block,
 * matching `scripts/__tests__/sync-project-fields.test.mjs`'s Status option
 * list verbatim — this script writes labels (source of truth) AND, best
 * effort, the human-readable block, so both must use the same names the
 * Project board itself uses.
 */
const STAGE_DISPLAY = {
  uat: "🛑 UAT",
  "close-out": "Close-out",
};

/** Decide the destination stage: UAT only if a UAT doc genuinely exists. */
export function computeTransition(hasUat) {
  const stage = hasUat ? "uat" : "close-out";
  return { stage, stageDisplay: STAGE_DISPLAY[stage] };
}

/**
 * Replace whichever label(s) share `prefix` with a single new one. Throws on
 * more than one existing label with that prefix — same "exactly one wins"
 * discipline as `sync-project-fields.mjs`'s `labelsToFieldValues`, since
 * guessing which stale label to keep is worse than failing loudly.
 */
export function swapPrefixedLabel(labels, prefix, newValue) {
  const others = labels.filter((l) => !l.startsWith(prefix));
  const hits = labels.filter((l) => l.startsWith(prefix));
  if (hits.length > 1) {
    throw new Error(`${hits.length} "${prefix}" labels (${hits.join(", ")}) — exactly one expected`);
  }
  return [...others, `${prefix}${newValue}`];
}

/**
 * Best-effort update of the State of Play block's Stage/Waiting on/Last
 * movement lines. Returns the updated body, or null if the block isn't in
 * the expected `**Field:** value` shape this script can safely rewrite —
 * callers must still apply the label change in that case (labels are the
 * actual source of truth; the block is the narrative projection of them),
 * just log that the body needs a human's eyes.
 */
export function updateStateOfPlayBody(body, { stageDisplay, lastMovementLine }) {
  if (!/\*\*Stage:\*\*/.test(body) || !/\*\*Waiting on:\*\*/.test(body)) {
    return null;
  }
  return body
    .replace(/\*\*Stage:\*\*[^\n]*/, `**Stage:** ${stageDisplay}`)
    .replace(/\*\*Waiting on:\*\*[^\n]*/, "**Waiting on:** David")
    .replace(/\*\*Last movement:\*\*[^\n]*/, `**Last movement:** ${lastMovementLine}`);
}

/** Deleted file paths between two commits, via `git diff --name-status`. */
function deletedPaths(before, after) {
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", before], { stdio: "inherit" });
  const out = execFileSync("git", ["diff", "--name-status", before, after, "--", "docs/"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith("D\t"))
    .map((line) => line.slice(2).trim());
}

async function rest(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`REST ${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function processDeletedTestRunDoc(path, { repository, token }) {
  const prNumber = extractPrNumberFromTestRunPath(path);
  if (!prNumber) return;

  const pr = await rest("GET", `/repos/${repository}/pulls/${prNumber}`, token);
  const issueNumber = extractWorkstreamIssueNumber(pr.body);
  if (!issueNumber) {
    console.log(`  ~ PR #${prNumber}: no "Workstream: #N" marker in body, nothing to transition`);
    return;
  }

  const issue = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  const labels = issue.labels.map((l) => l.name);
  if (!labels.includes("stage:test-run")) {
    console.log(
      `  ~ issue #${issueNumber} (PR #${prNumber}): not at stage:test-run (current: ` +
        `${labels.filter((l) => l.startsWith("stage:")).join(", ") || "none"}) — already handled, skipping`,
    );
    return;
  }

  const docsListing = await rest("GET", `/repos/${repository}/contents/docs`, token);
  const docsFilenames = docsListing.map((f) => f.name);
  const { stage, stageDisplay } = computeTransition(hasUatDoc(docsFilenames, prNumber));

  const newLabels = swapPrefixedLabel(
    swapPrefixedLabel(labels, "stage:", stage),
    "waiting:",
    "david",
  );
  await rest("PUT", `/repos/${repository}/issues/${issueNumber}/labels`, token, {
    labels: newLabels,
  });

  const lastMovementLine =
    `${new Date().toISOString().slice(0, 10)} — TEST_RUN doc for PR #${prNumber} cleared ` +
    `(Replit finished); auto-transitioned to ${stageDisplay} by sync-test-run-completion.mjs.`;
  const updatedBody = updateStateOfPlayBody(issue.body ?? "", { stageDisplay, lastMovementLine });
  if (updatedBody === null) {
    console.log(
      `  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${stage}, waiting:david ` +
        `(body's State of Play block wasn't in the expected shape — labels updated, body left as-is)`,
    );
    return;
  }
  await rest("PATCH", `/repos/${repository}/issues/${issueNumber}`, token, { body: updatedBody });
  console.log(`  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${stage}, waiting:david`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const before = process.env.BEFORE_SHA;
  const after = process.env.AFTER_SHA;

  const missing = Object.entries({ GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, BEFORE_SHA: before, AFTER_SHA: after })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }

  const testRunDeletions = deletedPaths(before, after).filter((p) => p.endsWith("_TEST_RUN.md"));
  if (!testRunDeletions.length) {
    console.log("No TEST_RUN docs deleted in this push — nothing to do.");
    return;
  }

  console.log(`${testRunDeletions.length} deleted TEST_RUN doc(s): ${testRunDeletions.join(", ")}\n`);

  const failures = [];
  for (const path of testRunDeletions) {
    try {
      await processDeletedTestRunDoc(path, { repository, token });
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
      console.error(`  ✗ ${path} — ${err.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n✗ ${failures.length} deletion(s) failed to process.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}
