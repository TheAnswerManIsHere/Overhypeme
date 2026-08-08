#!/usr/bin/env node
// The loop-efficacy digest — the part the ledger never had.
//
// The measurement system existed since PR #270 and produced real findings,
// but they lived in a ~2,500-word analysis section inside a file David never
// opens. He found out the rows were duplicating by stumbling into it. This
// script is the delivery half: it answers the standing questions from the
// per-loop store, and `/maintenance` narrates the answers to him in plain
// language.
//
// Design rules it enforces, all of them lessons from the frozen ledger:
//   - Derived, never stored. Self-inflicted share, disagreement percentage
//     and verdict are computed here from their inputs, so no two copies of
//     one number can disagree.
//   - A zero denominator is `n/a`, never 0%. A loop with no valid findings
//     cannot have a self-inflicted share.
//   - Only loops where the metric is structurally possible enter the trend:
//     more than one finding-bearing round, and an adjudication that did not
//     trip the disagreement gate.
//   - Unknown is not zero. Unknown preflight is reported as unknown.
//   - Say "not yet informative" rather than drawing a line through two points.
//
// Run:  node scripts/loop-report.mjs [--since YYYY-MM-DD] [--inventory <file>]

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_DIR = join(ROOT, ".agents/metrics/loops");

/**
 * The cutover. Loops below this number were recorded in the frozen markdown
 * ledger and deliberately have no JSON record, so reporting them as "missing"
 * would drown the one signal this section exists to give. Same shape as the
 * retired guard's FIRST_ENFORCED_PR, and set to the first loop that closes
 * after the store lands.
 */
export const FIRST_RECORDED_PR = 344;

/**
 * Authors whose PRs are not review loops. A Dependabot bump is triaged under
 * `/maintenance` — David squash-merges green minor/patch bumps directly, with
 * no plan, fix tier, or review loop — so listing every weekly bump as a
 * missing loop would train the reader to skip the section.
 */
export const NON_LOOP_AUTHORS = new Set(["dependabot[bot]", "dependabot"]);

/** Disagreement above this share means the loop's causal figure is unmeasured. */
const DISAGREEMENT_GATE = 0.2;

// ---------------------------------------------------------------------------
// Derived values — computed here, never read from the record
// ---------------------------------------------------------------------------

/** Findings that count toward churn: everything but `invalid`. */
export const validFindings = (r) => (r.mechanical?.findings ?? 0) - (r.judgment?.causes?.invalid ?? 0);

/** Findings the loop caused itself: propagation + wrong fix. */
export const selfInflictedCount = (r) => (r.judgment?.causes?.prop ?? 0) + (r.judgment?.causes?.wrong ?? 0);

/**
 * Self-inflicted share, or null when there is nothing to divide by.
 *
 * Zero denominator happens two ways — no findings at all, and every finding
 * invalid (the #284 shape) — and the second can pass the multi-round filter,
 * so this cannot be guarded by a findings check alone. Both report `n/a`.
 */
export function selfInflictedShare(record) {
  const denominator = validFindings(record);
  if (denominator <= 0) return null;
  return selfInflictedCount(record) / denominator;
}

/** Rounds that surfaced at least one finding. */
export const findingBearingRounds = (r) => (r.mechanical?.perRound ?? []).filter((x) => x.findings > 0).length;

/** The adjudication verdict, derived from its two stored inputs. */
export function adjudicationVerdict(record) {
  const a = record.adjudication;
  if (a?.status !== "completed") return null;
  if (!a.population) return "measured";
  return a.disagreements / a.population > DISAGREEMENT_GATE ? "unmeasured" : "measured";
}

/**
 * Does this loop belong in the churn/trend population?
 *
 * Two independent conditions, both required:
 *
 *  1. **More than one finding-bearing round.** Propagation and wrong-fix
 *     cannot occur on a loop's first finding-bearing round — there is no
 *     earlier fix for a later finding to respond to — so a single-round loop
 *     scores 0% by construction. That is a structural floor, not a
 *     measurement, and mixing it into the trend understates the real number.
 *  2. **The adjudication did not trip the gate.** working-modes.md requires
 *     an `unmeasured` loop to be excluded from the trend. Without this the
 *     author's classification would still flow through, which is exactly the
 *     figure the gate declared untrustworthy.
 *
 * `never-run` loops DO qualify — they are roughly four-fifths of all loops,
 * and their author classification is the measurement. Excluding them would
 * leave the digest with almost nothing to say.
 */
export function qualifiesForTrend(record) {
  if ("exempt" in record) return false;
  // A deferred judgment leaves `judgment` null. `selfInflictedShare` reads it
  // through optional chaining and would score that as 0% self-inflicted
  // rather than "not yet classified" — and the churn section below dereferences
  // `judgment.causes` directly, which crashes the whole digest on a record
  // that is legitimately mid-triage.
  if (record.judgmentDeferred) return false;
  if (selfInflictedShare(record) === null) return false;
  if (findingBearingRounds(record) <= 1) return false;
  return adjudicationVerdict(record) !== "unmeasured";
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function loadStore(dir = STORE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.pr - b.pr);
}

export const inWindow = (record, since) =>
  Boolean(record.closedAt) && new Date(record.closedAt).getTime() >= since.getTime();

/**
 * Cost across a window, keeping unknown preflight visibly unknown.
 *
 * The frozen ledger's contract defines pre-open preflight as the only cost
 * outside the review interval and says to add it for total cost — so
 * reporting review hours alone understates exactly the loops where preflight
 * did the most work. But it also records real `—` values where the figure
 * cannot be isolated, and summing those as zero would silently understate in
 * the other direction. So: a known subtotal plus a count of unknowns, never
 * one number pretending to be complete.
 */
export function costTotals(records) {
  let reviewHours = 0;
  let preflightMin = 0;
  let preflightUnknown = 0;
  for (const r of records) {
    reviewHours += r.mechanical?.reviewInterval?.hours ?? 0;
    const p = r.judgment?.preOpenPreflightMin;
    if (p === null || p === undefined) preflightUnknown++;
    else preflightMin += p;
  }
  return { reviewHours, preflightMin, preflightUnknown };
}

/**
 * A closed PR is not owed a record until it has been closed for a full
 * digest window (14 days) — working-modes.md's terminal-point rule. Without
 * this floor, every PR closed in the last two weeks reports as an actionable
 * data gap on a normal weekly run, which trains the reader to skip the
 * section. The inventory (a plain PR listing) doesn't carry reviewer-event
 * timestamps, so this checks closure age only — the coarser half of the
 * terminal-point rule, not the full "no reviewer pass" refinement `--write`
 * enforces with the richer per-PR data it has access to.
 */
const SETTLING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Closed loops with no record, from a paginated inventory.
 *
 * Absence leaves no artifact in the store, so completeness cannot be computed
 * from the store alone — the directory always looks complete to itself. The
 * inventory has to be paginated to exhaustion (truncating at one page would
 * silently under-report), filtered to post-cutover loops, and stripped of
 * non-loop authors.
 */
export function missingRecords(inventory, records, now = new Date()) {
  const have = new Set(records.map((r) => r.pr));
  return inventory
    .filter((pr) => pr.number >= FIRST_RECORDED_PR)
    .filter((pr) => pr.closed_at)
    .filter((pr) => now.getTime() - new Date(pr.closed_at).getTime() >= SETTLING_WINDOW_MS)
    .filter((pr) => !NON_LOOP_AUTHORS.has(pr.user?.login))
    .filter((pr) => !have.has(pr.number))
    .map((pr) => ({ number: pr.number, title: pr.title, closedAt: pr.closed_at }));
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const hours = (h) => `${h.toFixed(1)}h`;

/** Review minutes plus known preflight minutes. Unknown preflight adds nothing — never zero pretending to be complete. */
const attributableMinutes = (r) => (r.mechanical?.reviewInterval?.hours ?? 0) * 60 + (r.judgment?.preOpenPreflightMin ?? 0);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderDigest({ records, since, inventory = null }) {
  const windowed = records.filter((r) => !("exempt" in r) && inWindow(r, since));
  const out = [];
  const day = since.toISOString().slice(0, 10);

  out.push(`# Loop efficacy — loops closed since ${day}`);
  out.push("");

  if (windowed.length === 0) {
    out.push(`No loops closed in this window. ${records.length} record(s) in the store overall.`);
    out.push("");
  } else {
    // ── Volume and cost ──────────────────────────────────────────────────
    const { reviewHours, preflightMin, preflightUnknown } = costTotals(windowed);
    const rounds = windowed.reduce((n, r) => n + (r.mechanical?.rounds ?? 0), 0);
    const findings = windowed.reduce((n, r) => n + (r.mechanical?.findings ?? 0), 0);

    out.push("## Volume and cost");
    out.push("");
    out.push(`- **${windowed.length} loop(s)**, ${rounds} review round(s), ${findings} finding(s).`);
    out.push(`- **Review time:** ${hours(reviewHours)}.`);
    out.push(
      `- **Pre-open preflight:** ${(preflightMin / 60).toFixed(1)}h across ` +
        `${windowed.length - preflightUnknown} loop(s)` +
        (preflightUnknown ? `; **${preflightUnknown} loop(s) unknown** (not counted as zero).` : "."),
    );
    out.push(
      `- **Total attributable cost:** ${hours(reviewHours + preflightMin / 60)}` +
        (preflightUnknown ? ` **plus ${preflightUnknown} loop(s) of unmeasured preflight**.` : "."),
    );
    out.push("");

    // ── Churn ────────────────────────────────────────────────────────────
    const qualifying = windowed.filter(qualifiesForTrend);
    out.push("## Churn — how much of the review was self-inflicted");
    out.push("");
    if (qualifying.length === 0) {
      out.push(
        `No qualifying loops in this window. A loop qualifies with more than one finding-bearing round ` +
          `(propagation and wrong-fix are structurally impossible before that) and an adjudication that ` +
          `did not trip the ${pct(DISAGREEMENT_GATE)} disagreement gate.`,
      );
    } else {
      for (const r of qualifying) {
        const share = selfInflictedShare(r);
        const prop = r.judgment.causes.prop;
        const wrong = r.judgment.causes.wrong;
        out.push(
          `- **#${r.pr}** — ${pct(share)} self-inflicted (${selfInflictedCount(r)}/${validFindings(r)} ` +
            `valid findings; ${wrong} wrong-fix, ${prop} propagation), ` +
            `${findingBearingRounds(r)} finding-bearing rounds, cohort \`${r.mechanical.cohort}\`.`,
        );
      }
    }
    out.push("");

    // ── Trend ────────────────────────────────────────────────────────────
    out.push("## Trend");
    out.push("");
    if (qualifying.length < 3) {
      out.push(
        `**n = ${qualifying.length} — not yet informative.** Reporting a direction from fewer than three ` +
          `qualifying loops would be reading noise; the frozen ledger's own analysis withdrew two such ` +
          `readings. The sequence so far: ` +
          (qualifying.length
            ? qualifying.map((r) => `#${r.pr} ${pct(selfInflictedShare(r))}`).join(" → ")
            : "(none)") +
          ".",
      );
    } else {
      out.push(
        `n = ${qualifying.length}, in closure order: ` +
          qualifying
            .slice()
            .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
            .map((r) => `#${r.pr} ${pct(selfInflictedShare(r))}`)
            .join(" → ") +
          ".",
      );
    }
    out.push("");

    // ── Outliers ─────────────────────────────────────────────────────────
    // Ranked by total attributable cost — review hours plus known preflight
    // minutes — not review hours alone, or a loop with heavy preflight and
    // light review would rank below a loop that cost less overall.
    const expensive = windowed
      .slice()
      .sort((a, b) => attributableMinutes(b) - attributableMinutes(a))
      .slice(0, 3);
    if (expensive.length) {
      out.push("## Most expensive loops in the window");
      out.push("");
      for (const r of expensive) {
        const p = r.judgment?.preOpenPreflightMin;
        out.push(
          `- **#${r.pr}** — ${hours(r.mechanical?.reviewInterval?.hours ?? 0)} review, ` +
            `${r.mechanical?.rounds ?? 0} rounds, ${r.mechanical?.findings ?? 0} findings; preflight ` +
            `${p === null || p === undefined ? "**unknown**" : `${p}m`}.`,
        );
      }
      out.push("");
    }
  }

  // ── Data health ────────────────────────────────────────────────────────
  out.push("## Data health");
  out.push("");
  const counts = { "never-run": 0, unmeasured: 0, "n/a": 0, deferred: 0, exempt: 0 };
  const deferrals = [];
  for (const r of records) {
    if ("exempt" in r) {
      counts.exempt++;
      continue;
    }
    const status = r.adjudication?.status;
    if (status === "deferred") {
      counts.deferred++;
      deferrals.push(r);
    } else if (status === "n/a") counts["n/a"]++;
    else if (status === "never-run") counts["never-run"]++;
    if (adjudicationVerdict(r) === "unmeasured") counts.unmeasured++;
    // A judgment deferral is a second, independent way a record can be
    // "deferred" — a malformed record could in principle carry both, so this
    // only counts it once.
    if (r.judgmentDeferred && status !== "deferred") {
      counts.deferred++;
      deferrals.push(r);
    }
  }
  out.push(
    `- ${counts["never-run"]} never-run, ${counts["n/a"]} n/a, ${counts.deferred} deferred, ` +
      `${counts.unmeasured} unmeasured (tripped the gate), ${counts.exempt} exempt.`,
  );

  // Every deferral by name. A count alone is how a deferral becomes
  // permanent: nobody can act on "3 deferred".
  if (deferrals.length) {
    out.push("");
    out.push("**Open deferrals** — each stays listed until it is resolved:");
    for (const r of deferrals) {
      const reason = r.judgmentDeferred ?? r.adjudication?.reason ?? "(no reason recorded)";
      out.push(`- **#${r.pr}** — ${reason}`);
    }
  }

  out.push("");
  if (inventory === null) {
    out.push(
      "**Completeness: not checked.** No PR inventory was supplied, so missing records cannot be " +
        "detected — the store always looks complete to itself. Re-run with `--inventory <file>` or a " +
        "GitHub token to check.",
    );
  } else {
    const missing = missingRecords(inventory, records);
    if (missing.length === 0) {
      out.push(`**Completeness:** every closed loop since #${FIRST_RECORDED_PR} has a record.`);
    } else {
      out.push(`**${missing.length} closed loop(s) with no record:**`);
      for (const m of missing) out.push(`- **#${m.number}** — ${m.title} (closed ${m.closedAt.slice(0, 10)})`);
    }
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const sinceArg = arg("since");
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) throw new Error(`--since must be a parseable date (got ${sinceArg})`);
  return { since, inventoryPath: arg("inventory") };
}

function main() {
  const { since, inventoryPath } = parseArgs(process.argv);
  const records = loadStore();
  const inventory = inventoryPath ? JSON.parse(readFileSync(inventoryPath, "utf8")) : null;
  console.log(renderDigest({ records, since, inventory }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
