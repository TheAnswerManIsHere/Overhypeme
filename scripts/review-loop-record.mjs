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
  REVIEWER_LOGINS,
  normalizeLogin,
} from "./loop-metrics.mjs";
import { loadLoop, allowance, countRounds, tierCap, nodeIo, TIERS } from "./review-budget.mjs";

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
export function changesSince(since, head, { runGit = git } = {}) {
  if (!since) {
    return { resolved: false, reason: "no reviewed commit found in the snapshot (no completed reviewer pass yet)" };
  }
  // The PR's head, from the snapshot — never the working tree's `HEAD`. Run
  // from `main`, a stale branch, or any other checkout, a `..HEAD` diff
  // describes an unrelated branch while every GitHub-derived field describes
  // the requested PR, and `noChange`/`proseOnly` then drive the verdict off
  // the wrong code. (Codex, round 1.)
  if (!head) {
    return { resolved: false, reason: "snapshot carries no pr.head.sha, so the diff has no verifiable endpoint" };
  }
  for (const [label, ref] of [["reviewed commit", since], ["PR head", head]]) {
    try {
      runGit(["cat-file", "-e", `${ref}^{commit}`]);
    } catch {
      return { resolved: false, reason: `${label} ${ref} is not present in this clone (fetch the branch, then re-run)` };
    }
  }

  const numstat = runGit(["diff", "--numstat", `${since}..${head}`]);
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
    head,
    commits: Number(runGit(["rev-list", "--count", `${since}..${head}`])),
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
 * The reviewer-authored root comments, one per thread — the same population
 * `countFindings` counts, but keeping the fields it drops (path, resolution
 * state, body).
 *
 * The reviewer filter is not optional. `countFindings` and `findingsByRound`
 * deliberately restrict to the Codex logins; a territory or gap list built
 * over *every* thread would fold David's own inline comments into the measured
 * loop and could flip a stop/continue decision on findings that were never
 * part of it. (Codex, round 1.)
 */
export function reviewerFindings(reviewThreads) {
  const out = [];
  // Deduplicated by the root comment's identity, matching `countFindings`'
  // own semantics: two concatenated MCP pages that overlap repeat a thread,
  // and without this the record could say totalFindings: 1 while listing two
  // items -- an internal contradiction handed to the one reader told to trust
  // the record. (Codex, #503 round 3.)
  const seenRoots = new Set();
  for (const thread of reviewThreads ?? []) {
    const root = thread.comments?.[0];
    if (!root) continue;
    if (!REVIEWER_LOGINS.has(normalizeLogin(root.author ?? root.user?.login))) continue;
    const rootId = /discussion_r(\d+)/.exec(root.html_url ?? "")?.[1] ?? `thread:${thread.id}`;
    if (seenRoots.has(rootId)) continue;
    seenRoots.add(rootId);
    out.push({
      threadId: thread.id ?? null,
      path: thread.path ?? root.path ?? null,
      line: thread.line ?? root.line ?? null,
      // `isResolved` is what tells an unaddressed finding from a closed one.
      // Absent in older snapshots, so it stays nullable rather than being
      // defaulted to either answer.
      resolved: typeof thread.isResolved === "boolean" ? thread.isResolved : null,
      outdated: typeof thread.isOutdated === "boolean" ? thread.isOutdated : null,
      createdAt: root.created_at ?? null,
      excerpt: typeof root.body === "string" ? root.body.slice(0, 400) : null,
    });
  }
  return out;
}

/**
 * Findings split by territory: does the finding's file appear in this PR's own
 * changed-file list?
 *
 * A snapshot whose threads carry no path at all reports `unknown` rather than
 * defaulting either way.
 */
export function findingsByTerritory(findings, files) {
  const changed = new Set(files.map((f) => f.filename));
  const out = { inDiff: 0, outsideDiff: 0, unknown: 0, outsideDiffPaths: [] };
  for (const finding of findings) {
    if (!finding.path) {
      out.unknown += 1;
    } else if (changed.has(finding.path)) {
      out.inDiff += 1;
    } else {
      out.outsideDiff += 1;
      if (!out.outsideDiffPaths.includes(finding.path)) out.outsideDiffPaths.push(finding.path);
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
  const passes = reviewerPasses(derived.reviews, derived.issueComments);
  const byRound = findingsByRound(derived.reviews, derived.comments, derived.issueComments);
  const counts = byRound.map((r) => r.findings);
  const total = countFindings(derived.comments);

  // The same reconciliation `derive()` enforces, for the same reason: a root
  // comment that cannot be correlated to a review event is counted by
  // `countFindings` and omitted by `findingsByRound`, so the two disagree. A
  // mechanical record whose own totals contradict each other is worse than no
  // record — it is the loop's one trustworthy input, and the adjudicator is
  // told to rule on it alone. (Codex, round 1.)
  const summed = counts.reduce((a, b) => a + b, 0);
  if (summed !== total) {
    throw new Error(
      `record would not reconcile: per-round findings sum to ${summed} but the total is ${total}. ` +
        "Some reviewer root comment could not be attributed to a pass; fix the snapshot rather than " +
        "shipping a record whose numbers disagree.",
    );
  }

  const findings = reviewerFindings(snapshot.reviewThreads);

  // Rounds spent, counted from THIS snapshot -- the same fresh-evidence
  // arithmetic the guard enforces, so the record and the runtime can never
  // disagree about the allowance. The earlier version omitted the spent
  // argument and took an Infinity default, activating every dormant extension
  // and showing the adjudicator a larger allowance than the guard would
  // actually grant. (Codex, #503 round 3.)
  const counted = countRounds({ reviewerPasses: passes, issueComments: derived.issueComments });

  const budget = budgetState?.problem
    ? { problem: budgetState.problem, detail: budgetState.detail ?? null }
    : {
        tier: budgetState.tier,
        tierMeaning: TIERS[budgetState.tier].label,
        declaredBudget: budgetState.budget.budget,
        cap: tierCap(budgetState.tier),
        criticality: budgetState.budget.criticality,
        artifactDeclaredAtRoundZero: budgetState.budget.artifact,
        roundsSpent: counted.spent,
        pendingRequest: counted.pending === 1,
        allowance: allowance(budgetState.tier, budgetState.extensions, counted.spent),
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
      totalFindings: total,
    },
    // The evidence both substantive verdicts require: `continue` must name a
    // specific unaddressed behavioral risk, and ship-with-gaps-recorded must
    // list the gaps being knowingly left. Counts alone cannot support either,
    // so the adjudicator would have had to guess — on a record built
    // specifically so it would not have to. (Codex, round 1.) Every field here
    // is source-derived: GitHub's own thread state and the reviewer's own
    // words, never the loop's account of them.
    findings: {
      unresolved: findings.filter((f) => f.resolved === false).length,
      resolved: findings.filter((f) => f.resolved === true).length,
      resolutionUnknown: findings.filter((f) => f.resolved === null).length,
      items: findings,
    },
    territory: {
      ...findingsByTerritory(findings, derived.files),
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
  // Validated here, not just checked for presence: `--pr 0`, `--pr -1` and
  // `--pr abc` all used to reach the body, load receipts under a nonsense
  // name, and (for NaN) write an adjudication file called `NaN-1.json` with a
  // `null` PR in it. (Codex, round 1.)
  const pr = Number(flags.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer");
  flags.pr = pr;
  if (!flags["mcp-snapshot"]) {
    throw new Error(
      "--mcp-snapshot <file> is required. Assemble it with pull_request_read (get, get_reviews, " +
        "get_files, get_review_comments, get_comments), paginated to completion, plus " +
        '"complete": { "reviews": true, "files": true, "reviewThreads": true, "issueComments": true }.',
    );
  }
  return flags;
}

/**
 * Snapshot requirements this record adds on top of `fromMcp`'s.
 *
 * Both are about the record describing the loop it CLAIMS to describe:
 *
 *  - `pr.number` must match `--pr`. `fromMcp` only checks that the number is
 *    numeric, so two files that disagree produce a record labelled as one PR
 *    carrying another PR's rounds, findings and files alongside the requested
 *    PR's budget — valid-looking, and about the wrong loop.
 *  - `issueComments` must be present and attested complete. `fromMcp` tolerates
 *    its absence for fixtures captured before clean-pass detection existed, and
 *    that backward-compatibility mode is wrong here: a clean Codex pass is
 *    delivered as an issue comment, so a snapshot without them understates the
 *    round count and can select an older `lastReviewedCommit` — understating
 *    exactly the number the tripwire turns on.
 *
 * (Both: Codex, round 1.)
 */
export function assertAdjudicationSnapshot(pr, snapshot) {
  if (snapshot?.pr?.number !== pr) {
    throw new Error(`snapshot describes PR ${snapshot?.pr?.number}, but --pr says ${pr}`);
  }
  if (!Array.isArray(snapshot.issueComments) || snapshot.complete?.issueComments !== true) {
    throw new Error(
      "an adjudication snapshot must carry issueComments with complete.issueComments === true. " +
        "Clean reviewer passes are delivered as issue comments; without them the round count is short.",
    );
  }
}

/** Next free adjudication-record path, so a second loop never overwrites a first. */
export function nextRecordPath(pr, existing) {
  // String slicing, not a regex built from `pr` -- CodeQL flagged the built
  // pattern as regex injection, and dropping the dynamic pattern removes the
  // question rather than arguing about whether the input is safe today.
  const prefix = `${pr}-`;
  const suffix = ".json";
  const used = existing
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, name.length - suffix.length))
    .filter((seq) => /^\d+$/.test(seq))
    .map(Number);
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

  const pr = flags.pr;
  const snapshot = JSON.parse(fs.readFileSync(flags["mcp-snapshot"], "utf8"));

  // Validate FIRST. `fromMcp` is where the completeness and shape assertions
  // live, and a partial snapshot understates rounds and findings on exactly
  // the long loops this record exists to characterise -- so nothing else may
  // read the raw snapshot before it has passed.
  assertAdjudicationSnapshot(pr, snapshot);
  const derived = fromMcp(snapshot);
  const budgetState = loadLoop(pr, nodeIo());
  const changes = changesSince(
    lastReviewedCommit(reviewerPasses(derived.reviews, derived.issueComments)),
    snapshot.pr?.head?.sha ?? null,
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
