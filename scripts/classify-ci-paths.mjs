#!/usr/bin/env node
/**
 * Decide whether a PR's changed files require the heavy CI jobs (Test,
 * Frontend Test, E2E Smoke) or only the always-on Build gates.
 *
 * Why this exists: a fast-iterating review loop pushes many times per day,
 * and this repo's PR mix includes a lot of genuinely docs-only work —
 * /document harvests, [LEDGER] PRs, UAT/TEST_RUN docs, skill and CLAUDE.md
 * edits. Each of those pushes was booting Postgres twice, downloading
 * Chromium, and running the full integration + e2e suites against code the
 * PR provably didn't touch. This classifier lets build.yml skip those three
 * jobs via job-level `if:` conditions.
 *
 * Why job-level `if:` and NOT workflow-level `paths:`/`paths-ignore:`
 * filtering (the trap this design exists to avoid): a required status check
 * whose workflow never triggers reports nothing at all, so the PR sits at
 * "Expected — waiting for status to be reported" forever and can never
 * merge. A job skipped by an `if:` condition instead reports its status as
 * "Success" — GitHub documents this explicitly: "A job that is skipped will
 * report its status as 'Success'. It will not prevent a pull request from
 * merging, even if it is a required check."
 *
 * Fail-safe posture, in both directions this can go wrong:
 *   - The INERT list is an allowlist, not the heavy list a denylist. A new
 *     top-level directory, a new config file, a workflow edit — anything
 *     this script has never heard of — defaults to running full CI. The
 *     failure mode of a stale allowlist is wasted minutes, never a skipped
 *     regression.
 *   - An EMPTY file list classifies as heavy. An empty list only happens
 *     when the API call that produced it failed or returned nothing —
 *     either way, "we don't know what changed" must mean "run everything,"
 *     not "nothing changed."
 *
 * Renames: the caller feeds BOTH sides of a renamed file as separate paths
 * (the API's `filename` and `previous_filename`). A rename out of a heavy
 * path into an inert one — product code moved under docs/, say — deletes
 * the source path, which is a real code change; classifying only the
 * destination would wave it through. This script just classifies whatever
 * paths it's given; the both-sides contract is enforced where the file
 * list is built (build.yml's `changes` job) and by the workflow-side count
 * check against the PR's own changed_files total.
 */

/**
 * True if this one file cannot affect the outcome of the heavy jobs.
 * "Cannot affect" is judged against what Test / Frontend Test / E2E Smoke
 * actually execute (artifacts/**, lib/**, package configs, lockfile — via
 * pnpm install + the suites), NOT against whether the file matters to CI at
 * all: .claude/guard.sh, the ledger, and the docs are all exercised by the
 * always-on Build job, so they can change freely without re-running the
 * suites that never read them.
 *
 * Deliberately NOT inert, even though some individual files would be safe:
 *   - `.github/**` — workflow edits define the jobs themselves, and carving
 *     out the PR template alone isn't worth the extra rule.
 *   - `scripts/**` — repo tooling is tested by Build, but pretest/migration
 *     glue lives near enough to the suites that the conservative call wins.
 */
export function isInertPath(path) {
  // Generated artifact, not prose: fieldDocs.test.ts (Frontend Test suite)
  // reads this exact committed file and asserts byte-parity with
  // renderAdminFieldReference(). An edit to it is precisely the change the
  // heavy suite exists to catch — a hand-edited or stale copy would merge
  // green if this classified as inert, because the always-on Build job
  // never enforces that parity.
  if (path === "docs/ADMIN_FIELD_REFERENCE.md") return false;
  if (path.startsWith("docs/")) return true;
  if (path.startsWith(".agents/")) return true;
  if (path.startsWith(".claude/")) return true;
  // Top-level prose only (README.md, CLAUDE.md, AGENTS.md, LICENSE) — a
  // markdown file nested anywhere else stays heavy unless its directory is
  // already inert above.
  if (/^[^/]+\.md$/.test(path)) return true;
  if (path === "LICENSE") return true;
  return false;
}

/**
 * `true` if the heavy jobs must run for this change set. Every file must be
 * inert for the answer to be `false`; one non-inert file — or an empty list
 * (see the fail-safe note above) — means full CI.
 */
export function needsHeavyJobs(paths) {
  if (paths.length === 0) return true;
  return paths.some((p) => !isInertPath(p));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const paths = chunks
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const heavy = needsHeavyJobs(paths);
  // Written in `key=value` form so the workflow step can append this line
  // straight to $GITHUB_OUTPUT.
  console.log(`run-heavy=${heavy}`);
  console.error(
    heavy
      ? `${paths.length} changed file(s): at least one requires the full suite (or the list was empty/unreadable).`
      : `${paths.length} changed file(s), all inert for Test/Frontend Test/E2E Smoke — heavy jobs skippable.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Any failure inside the classifier itself must land on the safe side:
    // emit run-heavy=true so the workflow runs everything, then exit 0 so
    // the emitted output is actually consumed rather than discarded by a
    // failed step.
    console.error(`✗ classify-ci-paths failed (${err.message}) — defaulting to run-heavy=true`);
    console.log("run-heavy=true");
  });
}
