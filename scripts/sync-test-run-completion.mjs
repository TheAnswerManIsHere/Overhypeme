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
import { fetchProject, syncIssue } from "./sync-project-fields.mjs";

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
 *
 * Anchored to the start of a line, with only horizontal whitespace before
 * the `#` — not the bare `Workstream:\s*#(\d+)` this used to be. `\s`
 * matches newlines too, so an unanchored search can cross a line break and
 * grab an unrelated `#N` several lines later, and can match an example
 * inside prose (an approved-plan oracle illustrating the convention, say)
 * as if it were the real marker. Either misfire would point this Action at
 * the wrong issue — including, worst case, mutating an unrelated public
 * issue from a PR that was never meant to be linked at all (a sensitive/
 * disclosure-carve-out PR deliberately has no marker).
 */
export function extractWorkstreamIssueNumber(prBody) {
  const m = /^Workstream:[ \t]*#(\d+)/m.exec(prBody ?? "");
  return m ? Number(m[1]) : null;
}

/** The UAT doc's filename for `prNumber` among `docs/`'s listing, or null if none exists. */
export function findUatDocFilename(docsFilenames, prNumber) {
  const re = new RegExp(`^PR${prNumber}_.+_UAT\\.md$`);
  return docsFilenames.find((name) => re.test(name)) ?? null;
}

/** True if `docs/` (as returned by the Contents API) has a UAT doc for `prNumber`. */
export function hasUatDoc(docsFilenames, prNumber) {
  return findUatDocFilename(docsFilenames, prNumber) !== null;
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
 * Replace the paragraph under a `### Heading` with `text`, up to the next
 * `##`/`###` heading (or end of body). No-op (returns `body` unchanged) if
 * `heading` isn't found — same best-effort posture as the rest of this
 * function: a body that doesn't match the expected shape gets left alone,
 * not corrupted by a regex that assumed too much about its structure.
 */
function replaceSection(body, heading, text) {
  const idx = body.indexOf(heading);
  if (idx === -1) return body;
  const afterHeading = idx + heading.length;
  const rest = body.slice(afterHeading);
  const nextHeading = /\n#{2,3} /.exec(rest);
  const sectionEnd = nextHeading ? afterHeading + nextHeading.index : body.length;
  return body.slice(0, afterHeading) + `\n\n${text}\n` + body.slice(sectionEnd);
}

/**
 * Best-effort update of the State of Play block's Stage/Waiting on/Last
 * movement lines, plus (when given) the "What's blocking" and "What you
 * need to do" narrative sections. The latter two matter as much as the
 * labels: a cold reader hitting `waiting:david` in the labels but "waiting
 * on Replit" in the narrative is exactly the confusing half-transitioned
 * state this whole script exists to prevent. "Where it actually stands"
 * is deliberately left untouched — its full history is too free-form for a
 * script to safely rewrite without risking losing real narrative.
 *
 * Returns the updated body, or null if the Stage/Waiting-on block isn't in
 * the expected `**Field:** value` shape this script can safely rewrite —
 * callers must still apply the label change in that case (labels are the
 * actual source of truth; the block is the narrative projection of them),
 * just log that the body needs a human's eyes.
 */
export function updateStateOfPlayBody(body, { stageDisplay, lastMovementLine, blockingText, todoText }) {
  if (!/\*\*Stage:\*\*/.test(body) || !/\*\*Waiting on:\*\*/.test(body)) {
    return null;
  }
  let updated = body
    .replace(/\*\*Stage:\*\*[^\n]*/, `**Stage:** ${stageDisplay}`)
    .replace(/\*\*Waiting on:\*\*[^\n]*/, "**Waiting on:** David")
    .replace(/\*\*Last movement:\*\*[^\n]*/, `**Last movement:** ${lastMovementLine}`);
  if (blockingText) updated = replaceSection(updated, "### What's blocking", blockingText);
  if (todoText) updated = replaceSection(updated, "### What you need to do", todoText);
  return updated;
}

/** The "What's blocking"/"What you need to do" text for a resolved transition. */
export function handoffText(targetStage, uatFilename) {
  if (targetStage === "uat") {
    return {
      blockingText: "Nothing structural — the TEST_RUN passed and this is ready for your UAT click-through.",
      todoText: `Run through \`docs/${uatFilename}\` and confirm the behavior.`,
    };
  }
  return {
    blockingText: "Nothing — no UAT is due for this PR (see working-modes.md's UAT exceptions); ready to close out.",
    todoText: "Nothing right now. Close this workstream out whenever you're satisfied.",
  };
}

/**
 * True if the body's `**Stage:**` line already reads `stageDisplay` — lets a
 * retry (after a partial prior run, e.g. labels wrote but the body PATCH
 * failed) skip straight to whatever's actually still stale instead of
 * re-deriving from scratch or silently no-op'ing on an already-correct body.
 */
export function bodyStageMatches(body, stageDisplay) {
  const m = /\*\*Stage:\*\*([^\n]*)/.exec(body ?? "");
  return m ? m[1].trim() === stageDisplay : false;
}

/**
 * Deleted file paths between two commits, via `git diff --name-status`.
 * `--no-renames` is deliberate: a TEST_RUN doc's deletion landing in the same
 * push as an unrelated, content-similar Markdown add/move can otherwise be
 * reported as a rename (`R…`) instead of a plain delete, which would hide
 * the deletion from this filter entirely and leave that workstream stuck.
 */
function deletedPaths(before, after) {
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", before], { stdio: "inherit" });
  const out = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-status", before, after, "--", "docs/"],
    { encoding: "utf8" },
  );
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

/**
 * Ensure exactly `stage:${targetStage}` and `waiting:david` are present on
 * the issue and every other `stage:`/`waiting:` label is gone — converging
 * to that state regardless of which step a previous, interrupted attempt
 * got through. Add-then-clean, deliberately not delete-then-add: adding is
 * idempotent (GitHub's add-labels endpoint no-ops on a label that's already
 * there), so a failure partway through still leaves the issue correctly
 * stage-labeled, merely with stale extras that this same call — or a later
 * retry calling it again — removes. The opposite ordering (delete old,
 * then add new) has a failure mode where a crash between the two leaves the
 * issue with NO `stage:` label at all: invisible to the dispatch check
 * below, which would then treat it as "nothing to do" and abandon it
 * permanently instead of finishing the transition.
 */
async function ensureCleanLabels(repository, issueNumber, targetStage, token) {
  const wantedStage = `stage:${targetStage}`;

  const before = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  const beforeNames = before.labels.map((l) => l.name);
  if (!beforeNames.includes(wantedStage) || !beforeNames.includes("waiting:david")) {
    await rest("POST", `/repos/${repository}/issues/${issueNumber}/labels`, token, {
      labels: [wantedStage, "waiting:david"],
    });
  }

  const after = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  const afterNames = after.labels.map((l) => l.name);
  const stale = afterNames.filter(
    (l) => (l.startsWith("stage:") || l.startsWith("waiting:")) && l !== wantedStage && l !== "waiting:david",
  );
  for (const label of stale) {
    await rest("DELETE", `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, token);
  }

  return afterNames.filter((l) => !stale.includes(l));
}

/**
 * Transition one workstream, idempotently. Split into two independent
 * halves — resolve the target stage, then reconcile whatever's still
 * stale — so a retry after a partial prior run (labels wrote, board sync or
 * body PATCH then failed) picks up exactly where it left off instead of
 * either re-touching already-correct labels or leaving a stale body forever
 * because "stage:test-run is already gone" looked like "already handled".
 */
async function processDeletedTestRunDoc(path, { repository, token, project, projectsToken }) {
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
  const stageLabels = labels.filter((l) => l.startsWith("stage:"));
  const mode = labels.find((l) => l.startsWith("mode:"))?.slice("mode:".length);

  // Checked against the *set* of stage labels, not a single "the" stage —
  // an interrupted prior run of this same function can leave an issue with
  // stage:test-run alongside a stage it already added, and that state still
  // needs finishing, not skipping.
  const needsTransition = stageLabels.includes("stage:test-run");
  const alreadyTransitioned =
    !needsTransition && (stageLabels.includes("stage:uat") || stageLabels.includes("stage:close-out"));
  if (!needsTransition && !alreadyTransitioned) {
    console.log(
      `  ~ issue #${issueNumber} (PR #${prNumber}): not at stage:test-run (current: ` +
        `${stageLabels.join(", ") || "none"}) — already handled elsewhere, skipping`,
    );
    return;
  }

  // Fetched unconditionally: needed to derive the target stage on a fresh
  // transition, and needed either way for the UAT doc's exact filename in
  // the "What you need to do" text below.
  const docsListing = await rest("GET", `/repos/${repository}/contents/docs`, token);
  const docsFilenames = docsListing.map((f) => f.name);
  const uatFilename = findUatDocFilename(docsFilenames, prNumber);

  let targetStage;
  let finalLabels = labels;

  if (needsTransition) {
    targetStage = computeTransition(uatFilename !== null).stage;

    // A feature-mode PR always ships a UAT doc (pr-docs' contract has no
    // exception for it) — so a missing one here isn't "no UAT was due," the
    // way it can legitimately be for a bugfix/docs/devops PR. It means the
    // doc was deleted, renamed, or never created by mistake. Silently
    // routing that to close-out would skip David's UAT gate without him
    // ever knowing there was one to skip; leave the label untouched and
    // surface it as a failed run instead.
    if (targetStage === "close-out" && mode === "feature") {
      throw new Error(
        `issue #${issueNumber} (mode:feature) has no UAT doc for PR #${prNumber} — feature-mode PRs always ` +
          `require one; leaving stage:test-run untouched rather than silently bypassing the UAT gate`,
      );
    }

    finalLabels = await ensureCleanLabels(repository, issueNumber, targetStage, token);
  } else {
    // Labels already moved (this run or an earlier partial one) — but don't
    // trust the top-of-function read for *which* stage it moved to; a retry
    // can start minutes after that read, plenty of time for David or another
    // agent to have advanced it again since. Re-derive fresh, right before
    // reconciling the board/body against it, and bail rather than
    // reconciling against a stage that's no longer current if it moved
    // somewhere this function doesn't own. `ensureCleanLabels` is a no-op
    // beyond returning the current set when nothing's actually stale, so
    // this also mops up any leftover labels an earlier interrupted run of
    // the branch above didn't get to.
    const freshStageIssue = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
    const freshStage = freshStageIssue.labels
      .map((l) => l.name)
      .find((l) => l.startsWith("stage:"))
      ?.slice("stage:".length);
    if (freshStage !== "uat" && freshStage !== "close-out") {
      console.log(
        `  ~ issue #${issueNumber} (PR #${prNumber}): stage changed since the first read ` +
          `(now: ${freshStage ? `stage:${freshStage}` : "none"}) — skipping this pass`,
      );
      return;
    }
    targetStage = freshStage;
    finalLabels = await ensureCleanLabels(repository, issueNumber, targetStage, token);
  }

  const targetDisplay = STAGE_DISPLAY[targetStage];

  // GITHUB_TOKEN-authored label writes don't trigger other workflows (GitHub
  // suppresses that cascade to prevent infinite loops), so project-sync.yml's
  // `issues: labeled`/`unlabeled` trigger never fires from this Action's own
  // PUT — the private board would stay stuck at Test run/Replit forever even
  // though the issue's labels moved. Call the same reconcile that trigger
  // would have called, directly, so the board and the labels never diverge.
  // Caught, not awaited-and-thrown: the authoritative labels above already
  // moved, and a transient GraphQL failure here must not stop the body
  // reconciliation below from happening too — same reasoning as `main()`
  // catching `fetchProject`'s failure instead of letting it block the loop.
  let boardSyncFailed = false;
  if (project) {
    try {
      await syncIssue(
        { node_id: issue.node_id, number: issueNumber, labels: finalLabels },
        project,
        projectsToken,
      );
    } catch (err) {
      boardSyncFailed = true;
      console.error(
        `  ✗ issue #${issueNumber}: board sync failed (${err.message}) — proceeding with body reconciliation.`,
      );
    }
  }

  // Re-fetch the body immediately before the mutating PATCH, rather than
  // reusing the snapshot from the GET above — narrows (doesn't eliminate;
  // this isn't a conditional/CAS write) the window in which a concurrent
  // David/agent body edit, made after that first GET but before now, would
  // otherwise be silently overwritten by a stale full-body PATCH.
  const freshIssue = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  if (bodyStageMatches(freshIssue.body, targetDisplay)) {
    console.log(`  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage} (body already reflects it)`);
    return boardSyncFailed;
  }

  const lastMovementLine =
    `${new Date().toISOString().slice(0, 10)} — TEST_RUN doc for PR #${prNumber} cleared ` +
    `(Replit finished); auto-transitioned to ${targetDisplay} by sync-test-run-completion.mjs.`;
  const updatedBody = updateStateOfPlayBody(freshIssue.body ?? "", {
    stageDisplay: targetDisplay,
    lastMovementLine,
    ...handoffText(targetStage, uatFilename),
  });
  if (updatedBody === null) {
    console.log(
      `  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage}, waiting:david ` +
        `(body's State of Play block wasn't in the expected shape — labels/board updated, body left as-is)`,
    );
    return boardSyncFailed;
  }
  await rest("PATCH", `/repos/${repository}/issues/${issueNumber}`, token, { body: updatedBody });
  console.log(`  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage}, waiting:david`);
  return boardSyncFailed;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const before = process.env.BEFORE_SHA;
  const after = process.env.AFTER_SHA;
  const projectsToken = process.env.PROJECTS_TOKEN;
  const projectOwner = process.env.PROJECT_OWNER;
  const projectNumber = Number(process.env.PROJECT_NUMBER);

  // Only the issue-transition inputs are hard-required. PROJECTS_TOKEN/
  // PROJECT_OWNER/PROJECT_NUMBER are the board-sync half — treated as
  // optional here, not required, so a rotated-out or never-set
  // PROJECTS_TOKEN degrades to "no board sync" (same as a rejected one)
  // instead of throwing before deletion detection even starts and blocking
  // the authoritative label transition along with it.
  const missing = Object.entries({
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: repository,
    BEFORE_SHA: before,
    AFTER_SHA: after,
  })
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

  // Fetched once and reused across every deletion in this push — the same
  // board, looked up once, rather than once per issue. The board sync is a
  // projection of the labels, not their source — a missing/expired
  // PROJECTS_TOKEN or a transient Projects GraphQL outage must never block
  // the labels themselves from moving (labels are the authoritative half
  // this whole Action exists to guarantee). So this whole lookup is
  // best-effort: `project` stays null on any failure (including simply not
  // being configured), every `syncIssue` call below is already conditioned
  // on `if (project)` and just skips, and the loop still runs.
  let project = null;
  let projectLookupFailed = false;
  if (!projectsToken || !projectOwner || !process.env.PROJECT_NUMBER) {
    console.error(
      "✗ PROJECTS_TOKEN/PROJECT_OWNER/PROJECT_NUMBER not fully configured — proceeding without board sync; " +
        "labels/body will still update.",
    );
    projectLookupFailed = true;
  } else {
    try {
      project = await fetchProject(projectOwner, projectNumber, projectsToken);
    } catch (err) {
      projectLookupFailed = true;
      console.error(
        `✗ Project board lookup failed (${err.message}) — proceeding without board sync; ` +
          `labels/body will still update.`,
      );
    }
  }

  const failures = [];
  let anyBoardSyncFailed = projectLookupFailed;
  for (const path of testRunDeletions) {
    try {
      const boardSyncFailed = await processDeletedTestRunDoc(path, { repository, token, project, projectsToken });
      if (boardSyncFailed) anyBoardSyncFailed = true;
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
      console.error(`  ✗ ${path} — ${err.message}`);
    }
  }

  // A board-sync failure doesn't block the loop above, but it should still
  // turn this run red — someone needs to notice PROJECTS_TOKEN or the
  // Projects API needs attention, even though the authoritative labels went
  // through fine.
  if (anyBoardSyncFailed) {
    process.exitCode = 1;
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
