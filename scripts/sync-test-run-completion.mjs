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
 * True if `docs/` still has a TEST_RUN doc for `prNumber` at the triggering
 * commit. `--no-renames` stops a genuine deletion from being hidden as a
 * rename, but the inverse still needs catching: David correcting a TEST_RUN
 * doc's filename (a typo in the slug, say) without actually running the
 * checklist is *also* a delete-then-add under `--no-renames`, and would
 * otherwise be read as "Replit finished" purely because the old path
 * disappeared — even though a same-numbered TEST_RUN doc still exists right
 * next to it.
 */
export function stillHasTestRunDoc(docsFilenames, prNumber) {
  const re = new RegExp(`^PR${prNumber}_.+_TEST_RUN\\.md$`);
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

/** The `mode:` values `pr-docs`/`working-modes.md` actually define. */
const RECOGNIZED_MODES = new Set(["feature", "bugfix", "docs", "devops"]);

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
 * Returns the updated body, or null if the block isn't in the expected
 * shape this script can safely rewrite — callers must still apply the
 * label change in that case (labels are the actual source of truth; the
 * block is the narrative projection of them), just log that the body needs
 * a human's eyes. "Expected shape" means every field/section this call is
 * actually asked to update is present to update: `**Stage:**`,
 * `**Waiting on:**`, and `**Last movement:**` always (this function always
 * rewrites all three), plus each of `### What's blocking`/`### What you
 * need to do` whenever the caller passes `blockingText`/`todoText` for it.
 * A field silently missing here used to mean `replaceSection`/the line
 * regexes no-op'd on it and the caller reported success anyway — the PATCH
 * would go through and the run would look clean while that one field stayed
 * stuck describing the old stage forever, with nothing left to ever retry
 * it. Rejecting the whole update (not just the missing piece) keeps this
 * script's two failure modes exactly two: fully reconciled, or flagged
 * `degraded` for a human — never silently partial.
 */
export function updateStateOfPlayBody(body, { stageDisplay, lastMovementLine, blockingText, todoText }) {
  if (
    !/\*\*Stage:\*\*/.test(body) ||
    !/\*\*Waiting on:\*\*/.test(body) ||
    !/\*\*Last movement:\*\*/.test(body)
  ) {
    return null;
  }
  if (blockingText && !body.includes("### What's blocking")) return null;
  if (todoText && !body.includes("### What you need to do")) return null;

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
 *
 * Revalidates ownership before touching anything: only proceeds if the
 * issue's current stage labels are a subset of {`expectedFromStage`,
 * `targetStage`} — a fresh transition, a resumed/no-op cleanup pass, or an
 * interrupted one caught mid-way with both present. Anything else — INCLUDING
 * one of those two alongside a third, unexpected stage — means a human or
 * another agent moved the issue somewhere this call doesn't own since the
 * caller last checked, and blindly cleaning up would delete that stage as
 * "stale" and silently roll it back. A membership check alone (does the set
 * contain an allowed stage) isn't enough for this: a non-atomic concurrent
 * swap can leave the actor's genuinely-new stage sitting alongside
 * `expectedFromStage` for a moment, and that combination must also reject,
 * not just an allowed stage's mere presence. Returns `null` instead of
 * mutating whenever the check fails.
 */
async function ensureCleanLabels(repository, issueNumber, targetStage, expectedFromStage, token) {
  const wantedStage = `stage:${targetStage}`;
  const allowedStages = new Set([targetStage, expectedFromStage]);

  const before = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  const beforeNames = before.labels.map((l) => l.name);
  const beforeStages = beforeNames.filter((l) => l.startsWith("stage:")).map((l) => l.slice("stage:".length));
  const hasAllowedStage = beforeStages.some((s) => allowedStages.has(s));
  const hasUnexpectedStage = beforeStages.some((s) => !allowedStages.has(s));
  if (!hasAllowedStage || hasUnexpectedStage) {
    return null;
  }

  if (!beforeNames.includes(wantedStage) || !beforeNames.includes("waiting:david")) {
    await rest("POST", `/repos/${repository}/issues/${issueNumber}/labels`, token, {
      labels: [wantedStage, "waiting:david"],
    });
  }

  // "Stale" is computed from what the `before` snapshot already knew to be
  // old — never from whatever's merely absent-from-wanted in the `after`
  // snapshot. The two GETs bracket a real network gap (the POST above), and
  // deriving deletions straight from `after` would delete anything a
  // concurrent actor added in that gap too — including a `waiting:` label
  // the earlier check never validated at all. Intersecting with `after`
  // only drops a candidate if the concurrent actor already removed it
  // themselves; it never adds a new deletion target the `before` read
  // didn't already justify.
  const beforeStale = beforeNames.filter(
    (l) => (l.startsWith("stage:") || l.startsWith("waiting:")) && l !== wantedStage && l !== "waiting:david",
  );

  const after = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
  const afterNames = after.labels.map((l) => l.name);
  const stale = beforeStale.filter((l) => afterNames.includes(l));
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
async function processDeletedTestRunDoc(path, { repository, token, project, projectsToken, commitRef, commitDate }) {
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
  const modeLabels = labels.filter((l) => l.startsWith("mode:"));

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
  // the "What you need to do" text below. Pinned to the triggering commit
  // (`?ref=`), not the unqualified default-branch tip — a later push can
  // land on main before this queued run reaches this call (the workflow's
  // own `queue: max` concurrency setting allows runs to queue up), and an
  // unqualified Contents API request would then read that later tree
  // instead of the one this specific TEST_RUN deletion actually belongs to.
  const docsListing = await rest(
    "GET",
    `/repos/${repository}/contents/docs?ref=${encodeURIComponent(commitRef)}`,
    token,
  );
  const docsFilenames = docsListing.map((f) => f.name);
  const uatFilename = findUatDocFilename(docsFilenames, prNumber);

  let targetStage;
  let finalLabels = labels;

  if (needsTransition) {
    // A same-numbered TEST_RUN doc still present at this commit means the
    // deletion this run is reacting to was a rename/replacement (a slug
    // typo fixed, say), not Replit actually finishing — `--no-renames`
    // reports that as a plain delete of the old path, same as a real
    // completion, so this is the only way to tell the two apart.
    if (stillHasTestRunDoc(docsFilenames, prNumber)) {
      console.log(
        `  ~ issue #${issueNumber} (PR #${prNumber}): a TEST_RUN doc for this PR still exists at ` +
          `${commitRef} — this was a rename, not completion; skipping`,
      );
      return;
    }
    targetStage = computeTransition(uatFilename !== null).stage;

    // mode is the ONLY evidence this function has for distinguishing "no UAT
    // doc because none was due" (bugfix/docs/devops) from "no UAT doc
    // because a feature-mode PR's got deleted/renamed/never created by
    // mistake" — so before trusting it to wave a missing UAT doc through to
    // close-out, require exactly one recognized mode: a missing, duplicate,
    // or misspelled mode: label is not evidence of anything and must not be
    // read as "not feature, safe to close out."
    if (targetStage === "close-out") {
      // Exactly one mode: label, full stop — not "at least one recognized
      // one among however many are present." A duplicate like mode:bugfix +
      // a stray mode:bugfx must reject too: it's still evidence the mode
      // labeling on this issue is broken, and letting a coincidentally-
      // recognized label among the extras through would silently trust
      // corrupted state.
      if (modeLabels.length !== 1 || !RECOGNIZED_MODES.has(modeLabels[0].slice("mode:".length))) {
        throw new Error(
          `issue #${issueNumber} doesn't have exactly one recognized mode: label ` +
            `(found: ${modeLabels.join(", ") || "none"}) and has no UAT doc for PR #${prNumber} — mode is the ` +
            `only evidence distinguishing a required UAT from a legitimate exemption, so this can't be safely ` +
            `routed to close-out; leaving stage:test-run untouched.`,
        );
      }
      // A feature-mode PR always ships a UAT doc (pr-docs' contract has no
      // exception for it) — so a missing one here isn't "no UAT was due,"
      // the way it can legitimately be for a bugfix/docs/devops PR. It
      // means the doc was deleted, renamed, or never created by mistake.
      // Silently routing that to close-out would skip David's UAT gate
      // without him ever knowing there was one to skip; leave the label
      // untouched and surface it as a failed run instead.
      if (modeLabels[0].slice("mode:".length) === "feature") {
        throw new Error(
          `issue #${issueNumber} (mode:feature) has no UAT doc for PR #${prNumber} — feature-mode PRs always ` +
            `require one; leaving stage:test-run untouched rather than silently bypassing the UAT gate`,
        );
      }
    }

    finalLabels = await ensureCleanLabels(repository, issueNumber, targetStage, "test-run", token);
    if (finalLabels === null) {
      console.log(
        `  ~ issue #${issueNumber} (PR #${prNumber}): stage changed concurrently since the ` +
          `dispatch read — skipping this pass rather than overwriting it`,
      );
      return;
    }
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
    // "Retry" means retry of *this deletion's own* transition, not "adopt
    // whatever the issue happens to be at now" — those are different things.
    // computeTransition is a pure function of the UAT doc's presence at the
    // pinned `commitRef`, so it always names the one stage this specific
    // deletion is entitled to reconcile toward. If the issue has genuinely
    // moved past that since (David finished UAT and something else advanced
    // it to close-out, say), that later move already has its own correct
    // narrative from whatever actor caused it — this retry rewriting the
    // body to claim *this* TEST_RUN deletion auto-transitioned it there
    // would be a false, backdated narrative, not a legitimate reconciliation.
    const expectedTargetStage = computeTransition(uatFilename !== null).stage;
    const freshStageIssue = await rest("GET", `/repos/${repository}/issues/${issueNumber}`, token);
    const freshStage = freshStageIssue.labels
      .map((l) => l.name)
      .find((l) => l.startsWith("stage:"))
      ?.slice("stage:".length);
    if (freshStage !== expectedTargetStage) {
      console.log(
        `  ~ issue #${issueNumber} (PR #${prNumber}): current stage (${freshStage ? `stage:${freshStage}` : "none"}) ` +
          `no longer matches what this deletion's UAT doc implies (stage:${expectedTargetStage}) — the issue has ` +
          `moved on for a reason unrelated to this retry; skipping rather than backdating a false transition`,
      );
      return;
    }
    targetStage = freshStage;
    finalLabels = await ensureCleanLabels(repository, issueNumber, targetStage, targetStage, token);
    if (finalLabels === null) {
      console.log(
        `  ~ issue #${issueNumber} (PR #${prNumber}): stage changed again since the retry read ` +
          `— skipping this pass rather than overwriting it`,
      );
      return;
    }
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
  let degraded = false;
  if (project) {
    try {
      await syncIssue(
        { node_id: issue.node_id, number: issueNumber, labels: finalLabels },
        project,
        projectsToken,
      );
    } catch (err) {
      degraded = true;
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
  // Dated from the triggering push's own commit, not wall-clock "now" — a
  // manual re-run of a failed job replays the same event date, so a retry
  // landing on a later UTC date doesn't produce a `Last movement` line that
  // disagrees with itself (and, per the Round 14 full-body comparison,
  // doesn't spuriously fail to match an already-reconciled body purely
  // because the date moved).
  const lastMovementLine =
    `${commitDate.slice(0, 10)} — TEST_RUN doc for PR #${prNumber} cleared ` +
    `(Replit finished); auto-transitioned to ${targetDisplay} by sync-test-run-completion.mjs.`;
  const updatedBody = updateStateOfPlayBody(freshIssue.body ?? "", {
    stageDisplay: targetDisplay,
    lastMovementLine,
    ...handoffText(targetStage, uatFilename),
  });
  if (updatedBody === null) {
    // The authoritative labels (and board, if that succeeded) did move —
    // but the narrative is now permanently stuck describing the old stage
    // with nothing that will ever retry it (a future run only fires on
    // another TEST_RUN deletion, which won't happen again for this PR).
    // Surface this as a failed run rather than a quiet success so it gets
    // an actual human's attention instead of staying wrong indefinitely.
    degraded = true;
    console.error(
      `  ✗ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage}, waiting:david ` +
        `(body's State of Play block wasn't in the expected shape — labels/board updated, body left as-is; ` +
        `this needs a human to fix the body manually, nothing will retry it)`,
    );
    return degraded;
  }
  // Comparing the *fully computed* replacement against the current body,
  // not just a Stage-line check — a retry can land with Stage already
  // correct but Waiting on/Last movement/blocking/todo still describing
  // the old handoff (a prior run's PATCH partly landed, say), and a
  // Stage-only shortcut would report that partial state as done instead
  // of finishing the reconciliation.
  if (updatedBody === freshIssue.body) {
    console.log(
      `  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage} (body already fully reflects it)`,
    );
    return degraded;
  }
  await rest("PATCH", `/repos/${repository}/issues/${issueNumber}`, token, { body: updatedBody });
  console.log(`  ✓ issue #${issueNumber} (PR #${prNumber}) -> stage:${targetStage}, waiting:david`);
  return degraded;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const before = process.env.BEFORE_SHA;
  const after = process.env.AFTER_SHA;
  const commitDate = process.env.EVENT_COMMIT_DATE;
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
    EVENT_COMMIT_DATE: commitDate,
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
  let anyDegraded = projectLookupFailed;
  for (const path of testRunDeletions) {
    try {
      const degraded = await processDeletedTestRunDoc(path, {
        repository,
        token,
        project,
        projectsToken,
        commitRef: after,
        commitDate,
      });
      if (degraded) anyDegraded = true;
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
      console.error(`  ✗ ${path} — ${err.message}`);
    }
  }

  // A board-sync or body-reconciliation failure doesn't block the loop
  // above, but it should still turn this run red — someone needs to notice
  // (PROJECTS_TOKEN, the Projects API, or a State of Play block that didn't
  // match the expected shape), even though the authoritative labels went
  // through fine.
  if (anyDegraded) {
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
