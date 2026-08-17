#!/usr/bin/env node
/**
 * The mechanical record a review loop hands to its fresh-context adjudicator.
 *
 * WHY A SCRIPT AND NOT A SUMMARY
 * ------------------------------
 * The whole point of the tier-1 tripwire is that the loop's own account of
 * itself is the thing that failed. A loop that has run 12 rounds narrates
 * those rounds as 12 locally-reasonable decisions, because that is exactly
 * what they were -- so a summary written from inside the loop hands the
 * adjudicator the same frame that produced the problem, and the adjudication
 * becomes a second opinion on a conclusion it was already given.
 *
 * So the adjudicator is fed COUNTED numbers only. This repo has measured that
 * distinction: recalled numbers have been wrong 3 times out of 3, counted ones
 * right 3 out of 3 (see the loop-ledger contract in working-modes.md). Every
 * field below is derived from GitHub's own records or from git, and the
 * counting logic is `loop-metrics.mjs`'s -- the same functions the ledger uses,
 * already hardened against the round-counting mistakes that cost that file
 * four rounds of review to find.
 *
 * WHAT IT CANNOT DERIVE, SAID OUT LOUD
 * ------------------------------------
 * The bucket rubric in working-modes.md sorts findings on two axes: CAUSE
 * (new ground / propagation / wrong-fix / re-raised) and TERRITORY (inside
 * this loop's diff, or outside it).
 *
 *   - TERRITORY is mechanical, and is derived here: a finding's file path
 *     against the PR's own changed-file list.
 *   - CAUSE is not. "Re-raised" and "wrong-fix" are prose conventions with no
 *     machine-readable marker, and `loop-metrics.mjs` refuses to regex them
 *     for exactly that reason -- a regex over prose is a guess wearing the
 *     costume of a measurement. So this record reports cause as null and says
 *     why, rather than shipping a fabricated classification to the one reader
 *     who is supposed to be immune to the loop's own storytelling.
 *
 * TRANSPORT
 * ---------
 * `--mcp-snapshot` only. No bash transport in this container reaches the
 * GitHub API: `curl` gets a 403 from the agent proxy, Node `fetch` gets a 401
 * with the git-scoped GITHUB_TOKEN (measured 2026-08-16, see
 * .agents/memory/github-rest-api-blocked-from-bash.md). The session assembles
 * the snapshot through the MCP tools and passes the file, exactly as
 * `loop-metrics.mjs --mcp-snapshot` already requires -- and inherits that
 * file's completeness assertions, which refuse a snapshot that was not
 * paginated to the end.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  fromMcp,
  reviewerPasses,
  findingsByRound,
  countFindings,
  artifactSize,
} from "./loop-metrics.mjs";
import { loadLoop, allowance, tierCap, nodeIo, TIERS } from "./review-budget.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ADJUDICATIONS_DIR = ".agents/adjudications";

// ---------------------------------------------------------------------------
// Behavioral vs. prose
// ---------------------------------------------------------------------------

/**
 * Three classes, because two would lie.
 *
 * A skill file, CLAUDE.md, or a `docs/ai-context/` contract is markdown that
 * CHANGES AGENT BEHAVIOUR -- calling it "prose" would let a loop keep
 * re-requesting review on a diff of pure contract edits while reporting
 * "prose-only, no behavioural change", which is the opposite of true in this
 * repo. And calling it "code" would hide the distinction the adjudicator
 * actually needs when the diff is documentation of a shipped mechanism.
 *
 * Anything unrecognised classifies as `code`. Unknown-is-behavioural is the
 * conservative direction for THIS question: it never lets a real change be
 * reported as inert, and its cost is only that a genuinely inert file may be
 * counted as behavioural, which errs toward the loop continuing rather than
 * toward a change being waved past unreviewed.
 */
export function classifyPath(file) {
  if (/^\.agents\/(metrics|receipts|adjudications)\//.test(file)) return "record";
  if (/^\.claude\//.test(file)) return "agent-contract";
  if (/^(CLAUDE|AGENTS)\.md$/.test(file)) return "agent-contract";
  if (/^docs\/(ai-context|engineering)\//.test(file)) return "agent-contract";
  if (/^\.agents\//.test(file)) return "agent-contract";
  if (/\.(md|txt)$/.test(file)) return "prose";
  if (/^docs\//.test(file)) return "prose";
  return "code";
}

/** Which classes count as a behavioural change for the re-request rule. */
export const BEHAVIORAL_CLASSES = new Set(["code", "agent-contract"]);

// ---------------------------------------------------------------------------
// Git side: what changed since the last reviewed commit
// ---------------------------------------------------------------------------

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * `git diff --numstat <since>..HEAD`, classified.
 *
 * Returns `{ resolved: false, reason }` rather than an empty diff when the
 * commit cannot be resolved. An unresolvable base and a genuinely empty diff
 * are opposite facts -- "nothing changed since the last review" is the single
 * strongest argument for stopping, so reporting it because a sha lookup failed
 * would be the most consequential possible false statement in this record.
 */
export function changesSince(since, { runGit = git } = {}) {
  if (!since) {
    return { resolved: false, reason: "no reviewed commit found in the snapshot (no completed reviewer pass yet)" };
  }
  try {
    runGit(["cat-file", "-e", `${since}^{commit}`]);
  } catch {
    return { resolved: false, reason: `commit ${since} is not present in this clone (fetch the branch, then re-run)` };
  }

  const numstat = runGit(["diff", "--numstat", `${since}..HEAD`]);
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, file] = line.split("\t");
      return {
        file,
        class: classifyPath(file),
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      };
    });

  const behavioral = files.filter((f) => BEHAVIORAL_CLASSES.has(f.class));
  return {
    resolved: true,
    since,
    commits: Number(runGit(["rev-list", "--count", `${since}..HEAD`])),
    files,
    behavioralFiles: behavioral.length,
    // The re-request rule's whole test, precomputed so the adjudicator does
    // not have to re-derive it from the file list.
    proseOnly: files.length > 0 && behavioral.length === 0,
    noChange: files.length === 0,
  };
}

// ---------------------------------------------------------------------------
// GitHub side
// ---------------------------------------------------------------------------

/**
 * Findings split by territory: does the finding's file appear in this PR's own
 * changed-file list?
 *
 * `flattenMcpThreads` drops the path (it exists to feed the counting
 * functions, which never needed it), so this reads the raw thread groups
 * instead. A snapshot whose threads carry no path at all reports `unknown`
 * rather than defaulting either way.
 */
export function findingsByTerritory(reviewThreads, files) {
  const changed = new Set(files.map((f) => f.filename));
  const out = { inDiff: 0, outsideDiff: 0, unknown: 0, outsideDiffPaths: [] };
  for (const thread of reviewThreads ?? []) {
    const p = thread.path ?? thread.comments?.[0]?.path ?? null;
    if (!p) {
      out.unknown += 1;
    } else if (changed.has(p)) {
      out.inDiff += 1;
    } else {
      out.outsideDiff += 1;
      if (!out.outsideDiffPaths.includes(p)) out.outsideDiffPaths.push(p);
    }
  }
  return out;
}

/** The commit of the most recent completed reviewer pass, or null. */
export function lastReviewedCommit(passes) {
  for (let i = passes.length - 1; i >= 0; i -= 1) {
    if (passes[i].commit) return passes[i].commit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildRecord({ pr, snapshot, derived, budgetState, changes, now }) {
  const passes = reviewerPasses(derived.reviews, derived.issueComments ?? []);
  const byRound = findingsByRound(derived.reviews, derived.comments, derived.issueComments ?? []);
  const counts = byRound.map((r) => r.findings);

  const budget = budgetState?.problem
    ? { problem: budgetState.problem, detail: budgetState.detail ?? null }
    : {
        tier: budgetState.tier,
        tierMeaning: TIERS[budgetState.tier].label,
        declaredBudget: budgetState.budget.budget,
        cap: tierCap(budgetState.tier),
        criticality: budgetState.budget.criticality,
        artifactDeclaredAtRoundZero: budgetState.budget.artifact,
        roundsRequested: budgetState.rounds.length,
        allowance: allowance(budgetState.tier, budgetState.extensions),
        extensions: budgetState.extensions.map((e) => ({
          kind: e.kind,
          verdict: e.verdict ?? null,
          grant: e.grant ?? null,
        })),
      };

  return {
    generator: "scripts/review-loop-record.mjs",
    generatedAt: now,
    pr,
    title: snapshot.pr?.title ?? null,
    // Counted, never recalled. Every number below comes from GitHub's records
    // via loop-metrics.mjs's own counting functions.
    artifact: artifactSize(derived.files),
    budget,
    rounds: {
      completedReviewerPasses: passes.length,
      byRound,
      trend: counts,
      totalFindings: countFindings(derived.comments),
    },
    territory: {
      ...findingsByTerritory(snapshot.reviewThreads, derived.files),
      note:
        "Territory is mechanical (finding path vs. this PR's changed files). CAUSE " +
        "(new-ground / propagation / wrong-fix / re-raised) is NOT derivable -- it has no " +
        "machine-readable marker, and is deliberately left unclassified rather than guessed.",
    },
    sinceLastReview: {
      lastReviewedCommit: lastReviewedCommit(passes),
      ...changes,
    },
    provenance: {
      githubVia: "mcp-snapshot (no bash transport reaches the GitHub API in this container)",
      countingLogic: "scripts/loop-metrics.mjs",
      caveat:
        "This record contains no narration from the loop it measures. If a field is unknown it says so; " +
        "nothing here is inferred from the session's own account of its rounds.",
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") {
      flags.write = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
    flags[key] = value;
    i += 1;
  }
  if (!flags.pr) throw new Error("--pr <number> is required");
  if (!flags["mcp-snapshot"]) {
    throw new Error(
      "--mcp-snapshot <file> is required. Assemble it with pull_request_read (get, get_reviews, " +
        "get_files, get_review_comments, get_comments), paginated to completion, plus " +
        '"complete": { "reviews": true, "files": true, "reviewThreads": true, "issueComments": true }.',
    );
  }
  return flags;
}

/** Next free adjudication-record path, so a second loop never overwrites a first. */
export function nextRecordPath(pr, existing) {
  const used = existing
    .map((name) => new RegExp(`^${pr}-(\\d+)\\.json$`).exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const seq = used.length ? Math.max(...used) + 1 : 1;
  return `${ADJUDICATIONS_DIR}/${pr}-${seq}.json`;
}

function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  const pr = Number(flags.pr);
  const snapshot = JSON.parse(fs.readFileSync(flags["mcp-snapshot"], "utf8"));

  // Validate FIRST. `fromMcp` is where the completeness and shape assertions
  // live, and a partial snapshot understates rounds and findings on exactly
  // the long loops this record exists to characterise -- so nothing else may
  // read the raw snapshot before it has passed.
  const derived = fromMcp(snapshot);
  const budgetState = loadLoop(pr, nodeIo());
  const changes = changesSince(
    lastReviewedCommit(reviewerPasses(derived.reviews, derived.issueComments ?? [])),
  );

  const record = buildRecord({
    pr,
    snapshot,
    derived,
    budgetState,
    changes,
    now: new Date().toISOString(),
  });

  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (!flags.write) {
    process.stdout.write(text);
    return 0;
  }

  const dir = path.join(REPO_ROOT, ADJUDICATIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const rel = nextRecordPath(pr, fs.readdirSync(dir));
  fs.writeFileSync(path.join(REPO_ROOT, rel), text);
  process.stdout.write(`${rel}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) process.exit(main());
