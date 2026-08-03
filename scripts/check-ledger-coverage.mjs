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
// THE CHECKS (behavior split by PR kind since 2026-08-02 — rows ship via
// dedicated [LEDGER] PRs, not folded into whatever PR opens next):
//   1. COVERAGE (needs the GitHub API + PR context) — every loop that closed
//      before this PR opened has either a row or a recorded exemption.
//      On a [LEDGER] PR this is a HARD GATE (carrying those rows is the PR's
//      purpose); on a regular PR it prints a WARNING and stays green.
//   2. STRUCTURAL ([LEDGER] PRs only) — the diff touches nothing besides
//      .agents/metrics/loop-ledger.md, so the [LEDGER] exclusion can't be
//      borrowed by substantive work. Hard gate.
//   3. ARITHMETIC (offline, always runs, always a hard gate) — each row's
//      causal counts sum to its own findings total, per working-modes.md's
//      "the five category counts must sum exactly to findings".
//   4. AUDIT (--audit, on push to main) — reports pending debt every run;
//      fails on overdue debt (a merged [LEDGER] carrier skipped a row, or
//      the no-carrier backstop tripped). See auditLedgerDebt.
//
// Run locally:  node scripts/check-ledger-coverage.mjs   (check 3 only)
// In CI:        same, with GITHUB_TOKEN + PR_NUMBER set (checks 1-3), and
//               --audit with GITHUB_TOKEN on push-to-main (checks 3-4)

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

/**
 * The dedicated ledger-append PR type (David, 2026-08-02, replacing the old
 * "a row is never its own dedicated PR" fold-into-next-PR rule — see
 * working-modes.md → "A row ships in a dedicated [LEDGER] PR").
 *
 * A PR whose title starts with `[LEDGER]` carries ledger rows and nothing
 * else. It is excluded from owing a row itself — that exclusion is what
 * terminates the recursion the old rule was built around (a ledger PR's own
 * close owing another row, forever) — and like the Dependabot exclusion it is
 * counted and reported on every run, never silent.
 *
 * The title prefix follows the `[PLAN REVIEW]` precedent: machine-checkable
 * from data every check here already fetches, and visible at a glance in any
 * PR list. It is NOT honor-system: `ledgerPrStrayFiles` below fails any
 * `[LEDGER]`-titled PR whose diff strays outside the ledger file, so the
 * exclusion cannot be borrowed by substantive work riding in under the
 * prefix.
 */
const LEDGER_PR_TITLE = /^\[LEDGER\]/;
export const isLedgerPr = (pr) => LEDGER_PR_TITLE.test(pr?.title ?? "");

/** The one file a [LEDGER] PR is allowed to change. */
const LEDGER_ONLY_PATH = ".agents/metrics/loop-ledger.md";

/**
 * Overdue backstop: with no [LEDGER] PR open, this many merges to `main`
 * after a loop closes turns its missing row from pending (reported) into
 * overdue (fails the audit). Keeps silence from lasting forever without
 * coupling any individual PR to ledger state.
 */
const OVERDUE_BACKSTOP_MERGES = 2;

/**
 * Files a [LEDGER] PR touches beyond the ledger file itself — the structural
 * check that makes the title prefix load-bearing instead of honor-system.
 * Returns the stray filenames; empty means the PR is what its title claims.
 *
 * Handles renames explicitly (fixed on PR #304, Codex round 2, P2): GitHub's
 * `filename` is always the destination path, so a file renamed FROM some
 * other path INTO `.agents/metrics/loop-ledger.md` would pass a check that
 * only compares `filename` — even though it also deletes whatever content
 * lived at the source path, which is exactly the "changes something besides
 * the ledger file" case this function exists to catch. A rename is flagged
 * unless its source was already the ledger path (i.e., not a real rename at
 * all by content).
 *
 * An empty file list is rejected too (fixed on PR #304, Codex round 2, P2):
 * without this, a PR whose diff was emptied back to its base (every change
 * reverted) and then retitled `[LEDGER]` would pass this check vacuously —
 * zero files means zero stray files — permanently excusing a real reviewed
 * loop from ever owing its row despite never touching the ledger at all. A
 * `[LEDGER]` PR must touch exactly the ledger file, not nothing.
 */
export function ledgerPrStrayFiles(files) {
  if (files.length === 0) {
    return ["(no files changed — a [LEDGER] PR must touch the ledger file)"];
  }
  const stray = [];
  for (const f of files) {
    if (f.filename !== LEDGER_ONLY_PATH) {
      stray.push(f.filename);
      continue;
    }
    if (f.previous_filename && f.previous_filename !== LEDGER_ONLY_PATH) {
      stray.push(`${f.previous_filename} (renamed into the ledger path)`);
    }
  }
  return stray;
}

/**
 * The trust boundary `owedRows`/`auditLedgerDebt` use for OTHER PRs in the
 * `allPrs` list, as opposed to `isLedgerPr`'s plain title check.
 *
 * Confirmed on PR #304 (Codex round 1, P1): a PR retitled to `[LEDGER] …`
 * after its last push is never re-validated, because this repo's Build
 * workflow triggers on `opened`/`synchronize`/`reopened` but not `edited` —
 * a title-only edit gets no new check run at all. Trusting `isLedgerPr(pr)`
 * directly for a PR that ISN'T the one currently being checked (which always
 * gets a live structural check against its own current diff — see main()'s
 * [LEDGER]-gate path) would let a retitled, structurally-invalid PR merge
 * and then be silently exempted from ever owing a row, or wrongly counted as
 * a valid carrier for someone else's debt — the exact "structurally
 * enforced, not honor-system" guarantee this file exists to give.
 *
 * `confirmedLedgerPrNumbers` below builds the actual trust set once per run,
 * fetching each `[LEDGER]`-titled candidate's live file list. This predicate
 * is the pure half — kept separate so tests can exercise the gating logic
 * with a hand-built Set instead of mocking file fetches.
 */
export const isConfirmedLedgerPr = (pr, confirmedLedgerPrs) => confirmedLedgerPrs.has(pr.number);

/**
 * Resolve which `[LEDGER]`-titled candidates in `allPrs` actually satisfy the
 * structural constraint right now, by fetching each one's live file list.
 * Only candidates are fetched (title match is cheap and filters first), so
 * cost scales with how many `[LEDGER]` PRs exist, not with total PR count.
 */
export async function confirmedLedgerPrNumbers(allPrs, token) {
  const confirmed = new Set();
  for (const pr of allPrs.filter(isLedgerPr)) {
    const files = await gh(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${pr.number}/files`, token);
    if (ledgerPrStrayFiles(files).length === 0) confirmed.add(pr.number);
  }
  return confirmed;
}

/**
 * Raw content of one file at a specific ref. A single-object GitHub endpoint
 * (`contents`), not the paginated-array shape `gh()` is built for — kept
 * separate rather than overloading `gh()` to branch on response shape.
 * Returns null if the file doesn't exist at that ref (e.g. the ledger was
 * added after the ref's commit).
 */
async function fetchFileAtRef(path, ref, token) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "check-ledger-coverage",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${path}@${ref}`);
  const data = await res.json();
  return Buffer.from(data.content, data.encoding ?? "base64").toString("utf8");
}

/** Every PR number carrying a row or an exemption entry in a parsed ledger. */
function prNumbersInLedger(ledger) {
  return new Set([...ledger.rows.map((r) => r.pr), ...ledger.exempt.keys()]);
}

/**
 * PR numbers whose row is either not arithmetic-checkable (a baseline or
 * wholly-deferred row — see `isArithmeticCheckable`) or checkable and correct,
 * plus every exempted PR number. Used to decide whether an open `[LEDGER]`
 * PR's head content actually, deliverably carries a given loop's row (fixed
 * on PR #304, Codex round 2, P2) — a row with broken arithmetic can never
 * pass this file's own hard gate, so a PR that only carries it that way can
 * never merge as-is and must not be trusted to defer that loop's backstop
 * indefinitely while it sits open and red.
 */
function deliverableRowNumbers(ledger) {
  const ok = ledger.rows.filter((row) => !isArithmeticCheckable(row) || rowCauseSum(row) === row.findings).map((r) => r.pr);
  return new Set([...ok, ...ledger.exempt.keys()]);
}

/**
 * PR numbers with a row or exemption in `before` that are missing from BOTH
 * in `after` — a permanence violation (fixed on PR #304, Codex round 2, P2).
 *
 * The ledger's own contract is that a row, once added, is never removed. The
 * `[LEDGER]` structural gate (diff touches only the ledger file) doesn't by
 * itself guarantee that: a botched merge-conflict resolution — exactly the
 * scenario three separate ledger PRs have already hit (#285/#286, #290/#294,
 * #292/#295) — could silently drop a row nobody meant to touch, and neither
 * the structural check nor the arithmetic check would notice, since a
 * shorter table with internally-consistent rows still passes both.
 */
export function removedRows(before, after) {
  const afterNums = prNumbersInLedger(after);
  return [...prNumbersInLedger(before)].filter((n) => !afterNums.has(n));
}

/**
 * For each OPEN, structurally-confirmed `[LEDGER]` PR, which loop PR numbers
 * its CURRENT head content actually carries — fetched live, not inferred.
 *
 * Needed because "some [LEDGER] PR is open" doesn't mean it carries any
 * particular loop's row (fixed on PR #304, Codex round 2, P2): the
 * opened-after-closed timing check alone let a stalled or incomplete open
 * ledger PR defer every timing-eligible loop's backstop indefinitely, even
 * loops its own current head doesn't contain a row for at all.
 *
 * Two further constraints, both fixed on PR #304 (Codex round 2, second
 * pass, both P2):
 *  - A row that fails the arithmetic hard gate can never actually merge as
 *    written, so it must not count as "carried" — see `deliverableRowNumbers`.
 *  - Only a PR targeting `main` can ever deliver anything to `main`. This
 *    repo stacks dependent bugfix PRs on other open PRs' heads
 *    (working-modes.md's *Dependent bugs* note), and a `[LEDGER]` PR is no
 *    exception — one based on a non-`main` branch cannot pay `main`'s debt no
 *    matter how clean its own diff is, matching the `base.ref === "main"`
 *    filter `auditLedgerDebt` already applies to landed carriers.
 */
export async function openLedgerPrCarries(allPrs, confirmedLedgerPrs, token) {
  const carries = new Map();
  for (const pr of allPrs) {
    if (pr.closed_at) continue;
    if ((pr.base?.ref ?? "main") !== "main") continue;
    if (!confirmedLedgerPrs.has(pr.number)) continue;
    const text = await fetchFileAtRef(LEDGER_ONLY_PATH, pr.head.sha, token);
    carries.set(pr.number, text ? deliverableRowNumbers(parseLedger(text)) : new Set());
  }
  return carries;
}

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

/** A row's present causal counts, summed. Shared by `checkArithmetic` and `deliverableRowNumbers`. */
function rowCauseSum(row) {
  return Object.values(row.causes)
    .filter((v) => v !== null)
    .reduce((a, b) => a + b, 0);
}

export function checkArithmetic({ rows }) {
  const problems = [];
  for (const row of rows) {
    if (!isArithmeticCheckable(row)) continue;
    const sum = rowCauseSum(row);
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
 * Which loops still owe a row, as of this PR's opening.
 *
 * The cutoff is working-modes.md's own sequencing: a `[LEDGER]` PR carries a
 * row for every loop closed before it opened, and a loop that closed *after*
 * it opened belongs to the next one — demanding it here would be
 * unsatisfiable. What this list MEANS depends on the current PR's kind, and
 * that decision lives in main(), not here: on a `[LEDGER]` PR a non-empty
 * list is a hard failure (carrying these rows is the PR's entire purpose);
 * on a regular PR it is a printed warning only (David, 2026-08-02 — a
 * regular PR is no longer anyone's designated carrier, and failing it for
 * ledger state would hold unrelated work hostage).
 *
 * Closed `[LEDGER]` PRs never appear in the owed list themselves — the
 * policy exclusion that terminates the ledger's self-reference. Counted and
 * reported, like the Dependabot skip, never silent. Gated by
 * `confirmedLedgerPrs`, not a live `isLedgerPr(pr)` title check, so a PR
 * retitled to `[LEDGER] …` after its last push (and never re-validated —
 * this repo's Build workflow doesn't trigger on `edited`) can't borrow the
 * exclusion without its diff actually having been confirmed ledger-only.
 */
export function owedRows({ allPrs, currentPr, ledger, confirmedLedgerPrs = new Set() }) {
  const openedAt = new Date(currentPr.created_at);
  const owed = [];
  let skippedNonLoop = 0;
  let skippedLedger = 0;

  for (const pr of allPrs) {
    if (pr.number === currentPr.number) continue;
    if (pr.number < FIRST_ENFORCED_PR) continue;
    if (!pr.closed_at) continue; // still open — the loop hasn't closed
    if (new Date(pr.closed_at) >= openedAt) continue; // closed after this PR opened
    if (NON_LOOP_AUTHORS.has(pr.user?.login)) {
      skippedNonLoop++;
      continue;
    }
    if (isConfirmedLedgerPr(pr, confirmedLedgerPrs)) {
      skippedLedger++;
      continue;
    }
    if (ledger.rows.some((r) => r.pr === pr.number)) continue;
    if (ledger.exempt.has(pr.number)) continue;
    owed.push(pr);
  }
  return { owed, skippedNonLoop, skippedLedger };
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
 * The distinction this draws is working-modes.md's `[LEDGER]`-PR sequencing
 * (David, 2026-08-02) turned into a test. The designated carrier of a
 * closed loop's row is the next `[LEDGER]` PR — not, as under the old rule,
 * whichever PR happened to open next — so:
 *
 *  - **pending** — the row is missing but nothing has missed it yet.
 *    Reported on every run, never failed, so the debt is visible while it is
 *    still cheap to pay.
 *  - **overdue, carrier trigger** — a `[LEDGER]` PR opened after this loop
 *    closed and has since merged to `main` without carrying its row. That PR
 *    was the designated carrier and skipped it; its own hard gate should
 *    have caught this, so reaching here also means a guard hole. Fails.
 *  - **overdue, backstop trigger** — no carrier ever showed up: two-plus PRs
 *    of any kind have merged to `main` since the loop closed, the row is
 *    still missing, and no `[LEDGER]` PR is open. Without this, a debt with
 *    no carrier would stay politely "pending" forever. An OPEN `[LEDGER]` PR
 *    defers this trigger — the debt is visibly being paid — but never the
 *    carrier trigger, which marks a miss that already happened.
 *
 * Requiring a carrier to have MERGED (not merely closed) matters: a
 * `[PLAN REVIEW]` PR is closed unmerged by contract, and a closed-unmerged
 * `[LEDGER]` PR delivered nothing. Requiring its BASE to be `main` matters
 * one level down: this repo stacks dependent bugfix PRs on other PRs' heads
 * (working-modes.md's *Dependent bugs* note), and GitHub stamps `merged_at`
 * on a stack merge exactly like a merge into `main` — counting one as landed
 * would report a debt against a PR that never reached the branch this audit
 * runs on.
 *
 * Closed `[LEDGER]` PRs are also skipped as loops owing rows — the same
 * policy exclusion `owedRows` applies, counted and reported the same way,
 * gated by the same `confirmedLedgerPrs` trust boundary (see its doc comment
 * above `owedRows` — a title-only check here is exactly as exploitable as it
 * is there, since `--audit` reads live PR titles at merge time, not whatever
 * title CI last actually validated a diff against).
 *
 * The backstop's "defer while a [LEDGER] PR is open" clause is evaluated
 * PER LOOP against VERIFIED CONTENT, not one repo-wide "is anything open"
 * boolean and not opening-time ordering alone (fixed on PR #304, both
 * Codex round 1 P2 and round 2 P2, same clause hardened twice): an open
 * ledger PR can only defer a loop's debt if its OWN CURRENT HEAD actually
 * carries a row or exemption for that specific loop, per `openLedgerPrCarries`
 * — timing order alone doesn't establish that (a `[LEDGER]` PR opened after
 * several loops closed could still be missing one of them, stalled, and open
 * indefinitely, deferring a backstop it was never actually going to pay).
 */
export function auditLedgerDebt({ allPrs, ledger, confirmedLedgerPrs = new Set(), openLedgerPrCarries = new Map() }) {
  const overdue = [];
  const pending = [];
  let skippedNonLoop = 0;
  let skippedLedger = 0;

  const isLedger = (pr) => isConfirmedLedgerPr(pr, confirmedLedgerPrs);

  const landed = allPrs
    .filter((pr) => pr.merged_at && (pr.base?.ref ?? "main") === "main")
    .map((pr) => ({
      number: pr.number,
      opened: new Date(pr.created_at),
      merged: new Date(pr.merged_at),
      ledger: isLedger(pr),
    }));
  const openLedgerPrs = allPrs
    .filter((pr) => !pr.closed_at && isLedger(pr) && (pr.base?.ref ?? "main") === "main")
    .map((pr) => ({ number: pr.number }));

  for (const pr of allPrs) {
    if (pr.number < FIRST_ENFORCED_PR) continue;
    if (!pr.closed_at) continue;
    if (NON_LOOP_AUTHORS.has(pr.user?.login)) {
      skippedNonLoop++;
      continue;
    }
    if (isLedger(pr)) {
      skippedLedger++;
      continue;
    }
    if (ledger.rows.some((r) => r.pr === pr.number)) continue;
    if (ledger.exempt.has(pr.number)) continue;

    const closedAt = new Date(pr.closed_at);
    const carrier = landed
      .filter((c) => c.ledger && c.number !== pr.number && c.opened > closedAt)
      .sort((a, b) => a.opened - b.opened)[0];
    if (carrier) {
      overdue.push({ pr, trigger: "carrier", carrier });
      continue;
    }

    const mergedSince = landed.filter((c) => c.number !== pr.number && c.merged > closedAt).length;
    const deferredByOpenCarrier = openLedgerPrs.some(
      (c) => c.number !== pr.number && (openLedgerPrCarries.get(c.number) ?? new Set()).has(pr.number),
    );
    if (mergedSince >= OVERDUE_BACKSTOP_MERGES && !deferredByOpenCarrier) {
      overdue.push({ pr, trigger: "backstop", mergedSince });
      continue;
    }

    pending.push(pr);
  }

  return { overdue, pending, skippedNonLoop, skippedLedger };
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
    const confirmedLedgerPrs = await confirmedLedgerPrNumbers(allPrs, token);
    const openLedgerPrCarriesMap = await openLedgerPrCarries(allPrs, confirmedLedgerPrs, token);
    const { overdue, pending, skippedNonLoop, skippedLedger } = auditLedgerDebt({
      allPrs,
      ledger,
      confirmedLedgerPrs,
      openLedgerPrCarries: openLedgerPrCarriesMap,
    });

    if (skippedNonLoop > 0) {
      console.log(`• ${skippedNonLoop} closed PR(s) excluded as non-loop authors (${[...NON_LOOP_AUTHORS].join(", ")}).`);
    }
    if (skippedLedger > 0) {
      console.log(`• ${skippedLedger} closed [LEDGER] PR(s) excluded by policy — a ledger append owes no row of its own.`);
    }
    if (pending.length) {
      // Not a failure. Printed every run so the debt is visible while it is
      // still cheap to pay, instead of surfacing only once it has been missed.
      console.log(`\n• ${pending.length} closed loop(s) owe a row but are not yet overdue.`);
      console.log(`  Open a [LEDGER] PR carrying these rows (working-modes.md → "The loop ledger"):`);
      for (const pr of pending) console.log(`    #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}`);
    }
    if (overdue.length) {
      console.error(`\n✗ ${overdue.length} closed review loop(s) missed their row and are now overdue:\n`);
      for (const item of overdue) {
        const cause =
          item.trigger === "carrier"
            ? `[LEDGER] PR #${item.carrier.number} opened after it closed and merged without carrying the row.`
            : `${item.mergedSince} PR(s) have merged since it closed, the row is still missing, and no [LEDGER] PR is open.`;
        console.error(`  #${item.pr.number}  closed ${item.pr.closed_at.slice(0, 10)}  ${item.pr.title}\n      → ${cause}`);
      }
      console.error(
        `\nEvery closed loop owes one row in .agents/metrics/loop-ledger.md, shipped via a dedicated` +
          `\n[LEDGER]-titled PR touching only that file (working-modes.md → "The loop ledger"). To resolve, either:` +
          `\n  • open a [LEDGER] PR: node scripts/loop-metrics.mjs --pr <number>  (or --mcp-snapshot <file>),` +
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

  // Excludes currentPr itself — if it's a [LEDGER] PR, its own structural
  // validity is checked live below against its current diff, not this set.
  const confirmedLedgerPrs = await confirmedLedgerPrNumbers(
    allPrs.filter((pr) => pr.number !== currentPr.number),
    token,
  );
  const { owed, skippedNonLoop, skippedLedger } = owedRows({ allPrs, currentPr, ledger, confirmedLedgerPrs });

  if (skippedNonLoop > 0) {
    // Never silent: a skip nobody can see reads as coverage that was never checked.
    console.log(`• ${skippedNonLoop} closed PR(s) excluded as non-loop authors (${[...NON_LOOP_AUTHORS].join(", ")}).`);
  }
  if (skippedLedger > 0) {
    console.log(`• ${skippedLedger} closed [LEDGER] PR(s) excluded by policy — a ledger append owes no row of its own.`);
  }

  // Fetched once, used by both branches below: the [LEDGER] gate needs it for
  // the structural check, and a regular PR needs it to confirm it ISN'T
  // touching the ledger file at all (Codex round 2, P2 — see that branch).
  const files = await gh(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}/files`, token);

  if (isLedgerPr(currentPr)) {
    // ── [LEDGER] PR: hard gates ─────────────────────────────────────────────
    //
    // The structural gate is what makes the title prefix load-bearing: the
    // row exclusion above cannot be borrowed by substantive work, because a
    // diff that strays outside the ledger file fails here.
    const stray = ledgerPrStrayFiles(files);
    if (stray.length) {
      console.error(
        `\n✗ This PR is titled [LEDGER] but changes ${stray.length} file(s) other than ${LEDGER_ONLY_PATH}:\n` +
          stray.map((f) => `  ${f}`).join("\n") +
          `\n\nA [LEDGER] PR carries ledger rows and nothing else — that constraint is what makes its` +
          `\nexclusion from the ledger obligation safe. Move the other changes to a normal PR.\n`,
      );
      process.exit(1);
    }
    console.log(`✓ [LEDGER] structural check: the diff touches only ${LEDGER_ONLY_PATH}.`);

    // A row, once added, is never removed (Codex round 2, P1) — the diff
    // touching only the ledger file doesn't by itself rule out a botched
    // merge-conflict resolution silently dropping one, and neither the
    // structural check above nor the arithmetic check below would notice a
    // shorter-but-internally-consistent table. Compared against live `main`,
    // not this PR's (possibly stale) base — a concurrent [LEDGER] PR may have
    // landed a row on `main` after this one's base was cut.
    const mainText = await fetchFileAtRef(LEDGER_ONLY_PATH, "main", token);
    const mainLedger = mainText ? parseLedger(mainText) : { rows: [], exempt: new Map() };
    const removed = removedRows(mainLedger, ledger);
    if (removed.length) {
      console.error(
        `\n✗ This PR's ledger no longer has a row or exemption for ${removed.length} PR(s) that ` +
          `\`main\`'s copy carries:\n` +
          removed.map((n) => `  #${n}`).join("\n") +
          `\n\nA row is added once and never removed. If this is a stale base rather than a real removal,` +
          `\nmerge current main into this branch and re-resolve the conflict — never drop a row to make it` +
          `\nresolve cleanly.\n`,
      );
      process.exit(1);
    }
    console.log(`✓ [LEDGER] permanence check: no row or exemption present on main is missing here.`);

    if (owed.length) {
      console.error(`\n✗ This [LEDGER] PR is missing ${owed.length} row(s) it exists to carry:\n`);
      for (const pr of owed) {
        console.error(`  #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}`);
      }
      console.error(
        `\nA [LEDGER] PR carries a row (or a "Deliberately not measured" entry) for EVERY loop closed` +
          `\nbefore it opened — that is its entire purpose, so unlike a regular PR this is a hard failure.` +
          `\nDerive each row with node scripts/loop-metrics.mjs --pr <number> (or --mcp-snapshot <file>),` +
          `\nadd the judgment columns and a blind adjudication, and push them to this PR.\n`,
      );
      process.exit(1);
    }
    console.log(`✓ Ledger coverage: every loop closed before [LEDGER] PR #${prNumber} opened has a row or a recorded exemption.`);
    return;
  }

  // A regular PR must never touch the ledger file at all (Codex round 2, P2)
  // — that is precisely the fold-rows-into-unrelated-PRs behavior this whole
  // redesign exists to end. Without this, a PR could carry a ledger row
  // exactly like the old rule, stay green (missing rows are only a warning
  // below, and arithmetic can still pass on a fully-formed row), and nobody
  // would ever see that the new contract was quietly bypassed.
  if (files.some((f) => f.filename === LEDGER_ONLY_PATH)) {
    console.error(
      `\n✗ This is a regular PR (not titled [LEDGER]) but its diff changes ${LEDGER_ONLY_PATH}.\n\n` +
        `Ledger rows ship only via a dedicated [LEDGER]-titled PR touching that file and nothing else` +
        `\n(working-modes.md → "The loop ledger"). Move this change to its own [LEDGER] PR, or drop it` +
        `\nfrom this diff if it landed here by accident.\n`,
    );
    process.exit(1);
  }

  // ── Regular PR: pending rows warn, never fail (David, 2026-08-02) ────────
  //
  // A regular PR is no longer anyone's designated carrier — rows ship via
  // dedicated [LEDGER] PRs — so failing unrelated work for ledger state would
  // recreate the coupling that rule change removed. The debt still prints so
  // it is never invisible; enforcement lives in the [LEDGER] PR's own hard
  // gate and the push-to-main audit's overdue triggers.
  if (owed.length) {
    console.log(`\n• Warning: ${owed.length} closed review loop(s) have no ledger row and no recorded exemption:`);
    for (const pr of owed) {
      console.log(`    #${pr.number}  closed ${pr.closed_at.slice(0, 10)}  ${pr.title}`);
    }
    console.log(
      `  Not this PR's problem to carry — open a [LEDGER] PR with these rows (working-modes.md →` +
        `\n  "The loop ledger"). This is a warning only; the build stays green.`,
    );
    return;
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
