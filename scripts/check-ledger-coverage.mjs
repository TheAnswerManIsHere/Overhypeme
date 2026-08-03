#!/usr/bin/env node
// Loop-ledger coverage gate.
//
// The ledger (.agents/metrics/loop-ledger.md) exists so that claims about our
// review workflow can be checked instead of recalled. That only works if the
// rows are actually there — and the first time it met a fast build run, they
// weren't: on 2026-07-29 the ledger held 2 rows against 13 closed loops, with
// zero rows in the feature/code and bugfix cohorts. Nothing had gone wrong
// mechanically; the obligation simply had nowhere to fail, so it was silently
// skipped while every PR stayed green.
//
// That is the "recurring failure pattern becomes a CI guard" rule in
// CLAUDE.md applied to our own ceremony: a rule broken twice becomes a check
// that makes breaking it impossible, rather than a better memory note.
//
// TWO CHECKS:
//   1. COVERAGE (needs the GitHub API + PR context) — every loop that closed
//      before this PR opened has either a row or a recorded exemption.
//   2. ARITHMETIC (offline, always runs) — each row's causal counts sum to its
//      own findings total, per working-modes.md's "the five category counts
//      must sum exactly to findings".
//
// Run locally:  node scripts/check-ledger-coverage.mjs   (check 2 only)
// In CI:        same, with GITHUB_TOKEN + PR_NUMBER set (both checks)

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, ".agents/metrics/loop-ledger.md");
const REPO_OWNER = "TheAnswerManIsHere";
const REPO_NAME = "Overhypeme";

/**
 * The ledger's own starting point. PR #270 is the ledger's implementation PR
 * and the first loop it measured; rows 1 and 2 (#268, #269) are deliberate
 * retrospective baselines entered before the mechanism existed. Nothing below
 * this number is owed a row, and demanding one would mean backfilling the
 * repo's entire history to satisfy a gate.
 */
const FIRST_ENFORCED_PR = 270;

/**
 * Authors whose PRs are not agent-run review loops.
 *
 * A Dependabot bump is triaged under the /maintenance ritual — David
 * squash-merges green minor/patch bumps directly — and no plan, fix tier, or
 * review loop is run against it. Requiring a ledger row for each would mean a
 * hand-written exemption entry every week, which trains the exemption table to
 * be noise. This is a policy, not a silent skip: the count of PRs excluded
 * this way is always reported.
 */
const NON_LOOP_AUTHORS = new Set(["dependabot[bot]", "dependabot"]);

// ── Ledger parsing ───────────────────────────────────────────────────────────

/**
 * Split a markdown table row into trimmed cells, dropping the empty leading
 * and trailing fields produced by the outer pipes.
 */
function tableCells(line) {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

const isSeparatorRow = (line) => /^\|[\s:|-]+\|$/.test(line.trim());

/**
 * Extract the table that follows a given `## Heading`, as {header, rows}.
 * Returns null when the heading is absent.
 */
function tableUnderHeading(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return null;

  let header = null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // next section — table is over
    if (!line.trim().startsWith("|")) continue;
    if (isSeparatorRow(line)) continue;
    if (header === null) header = tableCells(line);
    else rows.push(tableCells(line));
  }
  return header ? { header, rows } : null;
}

/** First PR number referenced by a link to this repo's pull requests. */
function prNumberIn(cells) {
  const match = /\/pull\/(\d+)/.exec(cells.join(" | "));
  return match ? Number(match[1]) : null;
}

/** The only strings that mean "not measured" — everything else must be a real number. */
const UNMEASURED_SENTINELS = new Set(["", "—", "-", "n/a"]);

/**
 * A cell holding a count. Strips markdown bold. Returns null for an
 * explicitly-unmeasured cell (one of `UNMEASURED_SENTINELS`), which the
 * ledger distinguishes from zero on purpose — blank means *not measured*,
 * never *zero*.
 *
 * A cell that is neither a recognized sentinel nor a valid number — a typo
 * like "4x" — is NOT silently folded into "unmeasured". That would let a
 * corrupted `findings` cell skip its row out of `checkArithmetic` entirely
 * (row 163's `findings === null` guard), and a corrupted causal cell could
 * pass arithmetic outright whenever the remaining columns already happened to
 * sum correctly — the guard reporting the ledger reconciles while the ledger
 * itself is corrupted. Malformed text throws instead.
 */
function countCell(raw, context) {
  const clean = (raw ?? "").replace(/\*\*/g, "").trim();
  if (UNMEASURED_SENTINELS.has(clean)) return null;
  const n = Number(clean);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${LEDGER}: ${context} is neither a number nor a recognized "not measured" marker ` +
        `(${[...UNMEASURED_SENTINELS].map((s) => JSON.stringify(s)).join(", ")}) — got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

function parseLedger(text) {
  const rowsTable = tableUnderHeading(text, "Rows");
  if (!rowsTable) throw new Error(`${LEDGER}: no "## Rows" table found — the ledger's own shape has changed.`);

  const col = (name) => {
    const i = rowsTable.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (i === -1) throw new Error(`${LEDGER}: "## Rows" table has no "${name}" column.`);
    return i;
  };

  const idx = {
    findings: col("findings"),
    new: col("new"),
    prop: col("prop"),
    wrong: col("wrong"),
    reRaised: col("re-raised"),
    invalid: col("invalid"),
  };

  const seenRowPrs = new Set();
  const rows = rowsTable.rows
    .map((cells) => {
      const pr = prNumberIn(cells);
      if (pr === null) return { pr };
      // A duplicated row for the same PR would pass arithmetic on each copy
      // independently and pass coverage via a presence check that can't tell
      // one row from two — inflating row counts and any cohort trend derived
      // from them, silently, forever. One row per loop is the contract; catch
      // the violation here rather than trusting every future editor of this
      // file to notice a copy-paste.
      if (seenRowPrs.has(pr)) {
        throw new Error(`${LEDGER}: PR #${pr} appears more than once in the "## Rows" table. One row per loop.`);
      }
      seenRowPrs.add(pr);
      return {
        pr,
        findings: countCell(cells[idx.findings], `PR #${pr}'s "findings" cell`),
        causes: {
          new: countCell(cells[idx.new], `PR #${pr}'s "new" cell`),
          prop: countCell(cells[idx.prop], `PR #${pr}'s "prop" cell`),
          wrong: countCell(cells[idx.wrong], `PR #${pr}'s "wrong" cell`),
          reRaised: countCell(cells[idx.reRaised], `PR #${pr}'s "re-raised" cell`),
          invalid: countCell(cells[idx.invalid], `PR #${pr}'s "invalid" cell`),
        },
      };
    })
    .filter((r) => r.pr !== null);

  const exemptTable = tableUnderHeading(text, "Deliberately not measured");
  const exemptReasonCol = exemptTable ? exemptTable.header.findIndex((h) => h.toLowerCase() === "reason") : -1;
  if (exemptTable && exemptReasonCol === -1) {
    throw new Error(`${LEDGER}: the "Deliberately not measured" table has no "reason" column.`);
  }

  const exempt = new Map();
  for (const cells of exemptTable?.rows ?? []) {
    const pr = prNumberIn(cells);
    if (pr === null) continue;
    if (exempt.has(pr)) {
      throw new Error(`${LEDGER}: PR #${pr} appears more than once in "Deliberately not measured". One entry per loop.`);
    }
    // The reason is the whole point of the table — it is what distinguishes a
    // deliberate decision not to measure from a row someone simply forgot.
    // Resolved by header, not "last cell", so a short/misaligned row can't
    // have its cohort column silently read as the reason; empty or missing
    // is rejected rather than accepted as a same-thing-as-omitted exemption.
    const reason = (cells[exemptReasonCol] ?? "").trim();
    if (reason === "") {
      throw new Error(
        `${LEDGER}: PR #${pr}'s entry in "Deliberately not measured" has an empty reason. ` +
          `An exemption with no stated reason is indistinguishable from a row someone forgot.`,
      );
    }
    exempt.set(pr, reason);
  }

  return { rows, exempt };
}

// ── Check 2: a row's causal counts must sum to its own findings ──────────────

/**
 * A row with unmeasured findings, or wholly unclassified causes (a
 * retrospective baseline, or a row deliberately deferred like row 6/#279 —
 * every cell "—"), has nothing for this check to reconcile and is skipped.
 * Exported so `main()` can report how many rows were actually checked
 * without duplicating this predicate — confirmed on PR #292 (Codex round 5)
 * that reporting `ledger.rows.length` in the success message overstates
 * coverage: a table can hold rows this check silently skips and still print
 * "N rows, causal counts reconcile," which is true of the checked subset
 * only, not literally every row in the table.
 */
export function isArithmeticCheckable(row) {
  if (row.findings === null) return false;
  return Object.values(row.causes).some((v) => v !== null);
}

export function checkArithmetic({ rows }) {
  const problems = [];
  for (const row of rows) {
    if (!isArithmeticCheckable(row)) continue;
    const present = Object.values(row.causes).filter((v) => v !== null);
    const sum = present.reduce((a, b) => a + b, 0);
    if (sum !== row.findings) {
      const unmeasured = Object.entries(row.causes)
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      problems.push(
        `  PR #${row.pr}: causal counts sum to ${sum} but findings is ${row.findings}` +
          (unmeasured.length ? ` (unmeasured columns: ${unmeasured.join(", ")})` : "") +
          `\n    working-modes.md: "The five category counts must sum exactly to findings — a total that` +
          ` comes up short means a finding was skipped, not that it was hard to classify."`,
      );
    }
  }
  return problems;
}

// ── Check 1: every closed loop has a row or a recorded exemption ─────────────

async function gh(path, token) {
  const out = [];
  let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const seen = new Set();
  while (url) {
    if (seen.has(url)) throw new Error(`pagination loop detected at ${url}`);
    seen.add(url);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "check-ledger-coverage",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    out.push(...(await res.json()));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    url = next?.[1] ?? null;
  }
  return out;
}

/**
 * Which loops owe a row on this PR.
 *
 * The rule is working-modes.md's own sequencing, applied literally: a closed
 * loop's row is folded into "whichever PR you open next", so by the time THIS
 * PR was opened, every loop that had already closed owes a row here. A loop
 * that closed *after* this PR opened does not — its row belongs to the next
 * PR, not retroactively to one already in flight.
 */
export function owedRows({ allPrs, currentPr, ledger }) {
  const openedAt = new Date(currentPr.created_at);
  const owed = [];
  let skippedNonLoop = 0;

  for (const pr of allPrs) {
    if (pr.number === currentPr.number) continue;
    if (pr.number < FIRST_ENFORCED_PR) continue;
    if (!pr.closed_at) continue; // still open — the loop hasn't closed
    if (new Date(pr.closed_at) >= openedAt) continue; // closed after this PR opened
    if (NON_LOOP_AUTHORS.has(pr.user?.login)) {
      skippedNonLoop++;
      continue;
    }
    if (ledger.rows.some((r) => r.pr === pr.number)) continue;
    if (ledger.exempt.has(pr.number)) continue;
    owed.push(pr);
  }
  return { owed, skippedNonLoop };
}

// ── Check 3: post-merge audit of main — a debt that was skippable and skipped ─

/**
 * Every closed loop that still has no row, split by whether the obligation has
 * actually been missed yet.
 *
 * `owedRows` above only ever runs in a PR's own context, which leaves one real
 * hole: a loop that closes while every open PR was already in flight is owed
 * by NONE of them, because each opened before it closed. Its row waits for a
 * PR that does not exist yet. Nothing is wrong at that moment — but nothing
 * reports it either, so the debt is invisible until someone happens to open
 * the next PR, and if that next PR merges without carrying the row, the miss
 * is invisible again until the PR after that. That is exactly how #286's and
 * #290's rows both went missing: not a broken guard, an unwatched interval.
 *
 * The distinction this draws is the workflow's own sequencing rule turned into
 * a test. working-modes.md says a closed loop's row is folded into "whichever
 * PR you open next", so:
 *
 *  - **pending** — no PR has opened-and-landed since this loop closed. The
 *    obligation is live but has not come due. Reported, never failed.
 *  - **overdue** — some other PR opened AFTER this loop closed and has since
 *    merged. That PR *was* "the next one", it was the row's designated
 *    carrier, and it reached `main` without it. The obligation came due and
 *    was skipped, which is a real miss and fails the build on `main`.
 *
 * Requiring the carrier to have MERGED (not merely closed) matters: a
 * `[PLAN REVIEW]` PR is closed unmerged by contract, so a row folded into one
 * would never reach `main`. Treating such a PR as a missed carrier would
 * report a debt nobody could ever have paid.
 *
 * Requiring the carrier's BASE to be `main` matters for the same reason, one
 * level down: this repo stacks a dependent bugfix PR on another open bugfix
 * PR's head rather than on `main` (working-modes.md's *Dependent bugs* note),
 * and GitHub stamps `merged_at` on that stack merge exactly like a merge into
 * `main` — nothing in the field itself says which branch received it. A
 * stacked PR's commits reach `main` only later, when its PARENT merges into
 * `main` in turn. Counting the stacked merge itself as a landed carrier would
 * report a loop's row as overdue against a PR that never actually reached the
 * branch this audit runs against.
 */
export function auditLedgerDebt({ allPrs, ledger }) {
  const overdue = [];
  const pending = [];
  let skippedNonLoop = 0;

  const landed = allPrs
    .filter((pr) => pr.merged_at && (pr.base?.ref ?? "main") === "main")
    .map((pr) => ({ number: pr.number, opened: new Date(pr.created_at), merged: new Date(pr.merged_at) }));

  for (const pr of allPrs) {
    if (pr.number < FIRST_ENFORCED_PR) continue;
    if (!pr.closed_at) continue;
    if (NON_LOOP_AUTHORS.has(pr.user?.login)) {
      skippedNonLoop++;
      continue;
    }
    if (ledger.rows.some((r) => r.pr === pr.number)) continue;
    if (ledger.exempt.has(pr.number)) continue;

    const closedAt = new Date(pr.closed_at);
    const carrier = landed
      .filter((c) => c.number !== pr.number && c.opened > closedAt)
      .sort((a, b) => a.opened - b.opened)[0];

    if (carrier) overdue.push({ pr, carrier });
    else pending.push(pr);
  }

  return { overdue, pending, skippedNonLoop };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const text = readFileSync(LEDGER, "utf8");
  const ledger = parseLedger(text);

  const arithmetic = checkArithmetic(ledger);
  if (arithmetic.length) {
    console.error("✗ Loop-ledger arithmetic check failed:\n");
    console.error(arithmetic.join("\n\n"));
    process.exit(1);
  }
  const checkedCount = ledger.rows.filter(isArithmeticCheckable).length;
  const deferredCount = ledger.rows.length - checkedCount;
  console.log(
    `✓ Ledger arithmetic: ${checkedCount}/${ledger.rows.length} row(s) checked, causal counts reconcile with findings.` +
      (deferredCount ? ` (${deferredCount} row(s) causally deferred — unmeasured findings or wholly unclassified — not checked here.)` : ""),
  );

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const prNumber = Number(process.env.PR_NUMBER ?? "");
  const haveInputs = Boolean(token) && Number.isFinite(prNumber) && prNumber > 0;
  const auditMode = process.argv.includes("--audit");

  // ── Audit mode: the post-merge half, run on push-to-main ─────────────────
  //
  // The PR-context check below can only ever ask "does THIS PR owe rows for
  // loops that closed before it opened". Nothing asked the question in between
  // PRs, which is where both of the ledger's real misses actually happened.
  // See auditLedgerDebt for the pending-vs-overdue distinction.
  if (auditMode) {
    if (!token) {
      throw new Error(
        "Ledger debt audit cannot run: GITHUB_TOKEN is missing.\n" +
          "  It is set by the 'Audit loop-ledger debt' step in .github/workflows/build.yml.\n" +
          "  Failing loudly rather than skipping — same reason as the coverage half below.",
      );
    }
    const allPrs = await gh(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=all`, token);
    const { overdue, pending, skippedNonLoop } = auditLedgerDebt({ allPrs, ledger });

    if (skippedNonLoop > 0) {
      console.log(`• ${skippedNonLoop} closed PR(s) excluded as non-loop authors (${[...NON_LOOP_AUTHORS].join(", ")}).`);
    }
    if (pending.length) {
      // Not a failure. Printed every run so the debt is visible while it is
      // still cheap to pay, instead of surfacing only once it has been missed.
      console.log(`\n• ${pending.length} closed loop(s) owe a row but are not yet overdue — no PR has opened and`);
      console.log(`  merged since they closed. Fold these into the next PR you open, on any subject:`);
      for (const pr of pending) console.log(`    #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}`);
    }
    if (overdue.length) {
      console.error(`\n✗ ${overdue.length} closed review loop(s) missed their row and are now overdue:\n`);
      for (const { pr, carrier } of overdue) {
        console.error(
          `  #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}\n` +
            `      → PR #${carrier.number} opened after it closed and has since merged without carrying the row.`,
        );
      }
      console.error(
        `\nEvery closed loop owes one row in .agents/metrics/loop-ledger.md, folded into the next PR on any` +
          `\nsubject (working-modes.md → "The loop ledger"). To resolve, either:` +
          `\n  • add the row: node scripts/loop-metrics.mjs --pr <number>  (or --mcp-snapshot <file>), then` +
          `\n    add the judgment columns and a blind adjudication, or` +
          `\n  • record a deliberate exemption with a reason in the ledger's "Deliberately not measured" table.` +
          `\nAn exemption is a recorded decision NOT to measure a loop. It is never a pass.\n`,
      );
      process.exit(1);
    }
    console.log(`\n✓ Ledger debt audit: no closed loop has missed its row.`);
    return;
  }

  // A guard that can silently no-op is the failure this whole PR exists to
  // close: a green check that verified nothing looks exactly like a green
  // check that verified everything. Locally, skipping is correct — there is no
  // credential. In CI on a pull_request event the inputs are always available,
  // so their absence means the workflow wiring is broken, and that must be
  // loud. Without this, mis-wiring `PR_NUMBER` would disable coverage
  // enforcement permanently and no one would ever see it.
  if (!haveInputs && process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "pull_request") {
    throw new Error(
      "Coverage check cannot run: GITHUB_TOKEN and/or PR_NUMBER are missing on a pull_request run.\n" +
        `  GITHUB_TOKEN present: ${Boolean(token)}; PR_NUMBER: ${JSON.stringify(process.env.PR_NUMBER ?? null)}\n` +
        "  Both are set by the 'Check loop-ledger coverage' step in .github/workflows/build.yml.\n" +
        "  Failing loudly rather than skipping — a coverage guard that quietly does nothing is worse than none.",
    );
  }

  if (!haveInputs) {
    console.log(
      "• Coverage check skipped: needs GITHUB_TOKEN and PR_NUMBER (set in CI on pull_request events).\n" +
        "  Arithmetic check above still ran.",
    );
    return;
  }

  const allPrs = await gh(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=all`, token);
  const currentPr = allPrs.find((p) => p.number === prNumber);
  if (!currentPr) throw new Error(`PR #${prNumber} not found in the repository's pull request list.`);

  const { owed, skippedNonLoop } = owedRows({ allPrs, currentPr, ledger });

  if (skippedNonLoop > 0) {
    // Never silent: a skip nobody can see reads as coverage that was never checked.
    console.log(`• ${skippedNonLoop} closed PR(s) excluded as non-loop authors (${[...NON_LOOP_AUTHORS].join(", ")}).`);
  }

  if (owed.length) {
    console.error(`\n✗ ${owed.length} closed review loop(s) have no ledger row and no recorded exemption:\n`);
    for (const pr of owed) {
      console.error(`  #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}`);
    }
    console.error(
      `\nEvery closed loop owes one row in .agents/metrics/loop-ledger.md, folded into the next PR on any` +
        `\nsubject (working-modes.md → "The loop ledger"). To resolve, either:` +
        `\n  • add the row: node scripts/loop-metrics.mjs --pr <number>  (or --mcp-snapshot <file>), then` +
        `\n    add the judgment columns and a blind adjudication, or` +
        `\n  • record a deliberate exemption with a reason in the ledger's "Deliberately not measured" table.` +
        `\nAn exemption is a recorded decision NOT to measure a loop. It is never a pass.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ Ledger coverage: every loop closed before PR #${prNumber} opened has a row or a recorded exemption.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

export { parseLedger, tableUnderHeading, countCell };
