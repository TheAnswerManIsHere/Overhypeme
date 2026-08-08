#!/usr/bin/env node
// Loop-metrics store guard.
//
// Replaces check-ledger-coverage.mjs (~970 lines). That guard was large
// almost entirely because it policed problems the single-file markdown ledger
// created: carrier logic, backstop deferral, permanence-vs-main, stray-file
// and rename gates, all to make concurrent appends to one table survivable.
// One file per loop, keyed by PR number, deletes that whole class — different
// loops touch different paths, so there is nothing to reconcile.
//
// What is left is what actually needs machine checking: is a record
// internally coherent, and does it say what it means?
//
// WHAT IS DELIBERATELY *NOT* CHECKED (David, 2026-08-07 — this is an
// internal tracking tool, not payments):
//   - Coverage. A closed loop with no record is reported in the digest that
//     David actually reads, not by failing an unrelated PR's build.
//   - Permanence. A record can be edited or deleted in an ordinary commit.
//     PR review is the control; git history is the record. Enforcing this in
//     CI required a corrections-overlay system whose own review found more
//     defects than it prevented.
// Both are accepted risks, recorded in the plan rather than discovered later.
//
// Run:  node scripts/check-loop-metrics.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_DIR = join(ROOT, ".agents/metrics/loops");
const LEDGER = join(ROOT, ".agents/metrics/loop-ledger.md");
const LEDGER_BASELINE = join(ROOT, ".agents/metrics/loop-ledger.sha256");

/**
 * The only keys a `mechanical` block may carry — an allowlist, mirroring
 * `loop-metrics.mjs`'s `MECHANICAL_KEYS`. Duplicated as a literal rather than
 * imported so the guard states its own contract: if the writer's projection
 * ever drifts, these two disagreeing is the signal, not a shared constant
 * silently moving under both.
 */
const MECHANICAL_KEYS = [
  "title",
  "cohort",
  "size",
  "rounds",
  "findings",
  "perRound",
  "reviewInterval",
  "warnings",
];

const CAUSES = ["new", "prop", "wrong", "reRaised", "invalid"];

/**
 * The only keys each adjudication status may carry. `disagreementPct` and
 * `verdict` were rejected by name for the `completed` case alone; an exact
 * allowlist closes every other stale-duplicate spelling (`percentage`,
 * `agreementPct`, `sample`, ...) the same way `MECHANICAL_KEYS` does for
 * `mechanical`.
 */
const ADJUDICATION_KEYS_BY_STATUS = {
  "n/a": ["status"],
  "never-run": ["status"],
  completed: ["status", "population", "disagreements"],
  deferred: ["status", "reason"],
};

/** Which loops get blind adjudication. Loops, never findings within a loop. */
export const meetsSamplingPredicate = (pr, findings) => pr % 5 === 0 || findings >= 30;

/** Valid findings — the churn denominator. Zero here means `n/a`, not 0%. */
export const validFindings = (record) =>
  (record.mechanical?.findings ?? 0) - (record.judgment?.causes?.invalid ?? 0);

/**
 * Is this judgment complete enough to land?
 *
 * `preOpenPreflightMin` may be null — the frozen ledger's `—` convention, for
 * a branch carrying unrelated earlier work where the figure cannot be
 * isolated. Null-with-a-reason is a measurement ("genuinely unknown"), not a
 * hole, and must not force the recorder to fabricate a zero or defer the
 * entire classification over one field.
 */
export function judgmentProblems(record) {
  const j = record.judgment;
  if (!j) return ["judgment is null"];
  const problems = [];
  for (const c of CAUSES) {
    const value = j.causes?.[c];
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`judgment.causes.${c} must be a non-negative integer`);
    }
  }
  if (j.preOpenPreflightMin === null && !j.preOpenPreflightReason) {
    problems.push(
      `preOpenPreflightMin is null with no preOpenPreflightReason — an unknown must say why it is ` +
        `unknown, so it stays distinguishable from a measured zero`,
    );
  }
  if (j.preOpenPreflightMin !== null) {
    if (typeof j.preOpenPreflightMin !== "number" || !Number.isFinite(j.preOpenPreflightMin) || j.preOpenPreflightMin < 0) {
      problems.push("preOpenPreflightMin must be null or a finite, non-negative number");
    }
  }
  if (!j.breakersFired) problems.push("breakersFired is missing");
  return problems;
}

/**
 * The adjudication state matrix, enforced in BOTH directions.
 *
 * One-way checking is what let the earlier draft accept a record that met the
 * sampling predicate but claimed `never-run` — the predicate would have been
 * decorative. Roughly four-fifths of loops are legitimately `never-run`, so
 * that state carries real weight and has to be earned rather than defaulted
 * into.
 */
export function adjudicationProblems(record) {
  const a = record.adjudication;
  if (!a || typeof a.status !== "string") return ["adjudication is missing a status"];

  const pr = record.pr;
  const findings = record.mechanical?.findings ?? 0;
  const sampled = meetsSamplingPredicate(pr, findings);
  const denominator = validFindings(record);
  const problems = [];

  // Checked once, ahead of the per-status switch, so it applies to every
  // status a zero-denominator loop could claim — not just "never-run". A
  // sampled loop with zero valid findings (e.g. `{status: "completed",
  // population: 0}`) is just as much a nothing-to-adjudicate case as an
  // unsampled one.
  if (a.status !== "n/a" && denominator === 0) {
    problems.push(
      `denominator (valid findings) is 0, so the settled state is "n/a", not "${a.status}" — there is ` +
        `nothing to adjudicate`,
    );
  }

  switch (a.status) {
    case "n/a":
      // Accepted only when there is genuinely nothing to adjudicate: no
      // findings at all, or none that were valid. Anything else using `n/a`
      // is a skipped adjudication wearing a legitimate label.
      if (denominator !== 0) {
        problems.push(
          `adjudication "n/a" requires a zero valid-finding denominator, but findings=${findings} ` +
            `minus invalid=${record.judgment?.causes?.invalid ?? 0} is ${denominator}`,
        );
      }
      break;

    case "never-run":
      if (sampled) {
        problems.push(
          `PR #${pr} meets the sampling predicate (pr % 5 === 0: ${pr % 5 === 0}; findings >= 30: ` +
            `${findings >= 30}) so it may not be "never-run" — run the blind adjudication, or record a ` +
            `deferral with a reason`,
        );
      }
      break;

    case "completed":
      if (!sampled) {
        problems.push(
          `PR #${pr} does not meet the sampling predicate, so "completed" is not the settled state for ` +
            `it — use "never-run". (Adjudicating extra loops is fine; recording them as sampled makes ` +
            `the calibration set look larger than the rule that defines it.)`,
        );
      }
      if (!Number.isInteger(a.population) || !Number.isInteger(a.disagreements)) {
        problems.push('a "completed" adjudication stores integer population and disagreements');
        break;
      }
      if (a.population !== findings) {
        problems.push(
          `adjudication.population is ${a.population} but the loop has ${findings} findings — every ` +
            `adjudication that runs covers the FULL population; this samples loops, not findings`,
        );
      }
      if (a.disagreements < 0 || a.disagreements > a.population) {
        problems.push(`adjudication.disagreements (${a.disagreements}) must be between 0 and ${a.population}`);
      }
      break;

    case "deferred":
      if (typeof a.reason !== "string" || !a.reason.trim()) {
        problems.push('a "deferred" adjudication needs a reason (a trimmed, non-empty string)');
      }
      break;

    default:
      problems.push(
        `unknown adjudication status ${JSON.stringify(a.status)} — expected never-run, completed, n/a, ` +
          `or deferred`,
      );
  }

  // Exact allowlist per status, checked once the status itself is known to
  // be one of the four — derived values (disagreementPct, verdict, or any
  // other stale duplicate) are rejected here regardless of what they're
  // named, rather than blocklisting the two names anticipated in advance.
  const allowedKeys = ADJUDICATION_KEYS_BY_STATUS[a.status];
  if (allowedKeys) {
    for (const key of Object.keys(a)) {
      if (!allowedKeys.includes(key)) {
        problems.push(
          `adjudication carries "${key}", which is not in the allowlist for status "${a.status}" ` +
            `(${allowedKeys.join(", ")}) — derived values are computed at read time and must not be stored`,
        );
      }
    }
  }

  return problems;
}

/** Everything wrong with one record, as human-readable lines. */
export function recordProblems(record, filename) {
  const problems = [];
  const expected = `${record.pr}.json`;

  if (record.schemaVersion !== 1) problems.push(`schemaVersion must be 1 (got ${record.schemaVersion})`);
  if (!Number.isInteger(record.pr)) {
    problems.push(`"pr" must be an integer (got ${JSON.stringify(record.pr)})`);
    return problems; // everything below keys off it
  }
  if (filename !== expected) {
    problems.push(`filename is ${filename} but the record says pr ${record.pr} (expected ${expected})`);
  }

  // ── Exempt branch: a deliberate decision not to measure ─────────────────
  //
  // A schema union, not a measured record with holes. It satisfies
  // completeness by construction, and no report path may assume it carries
  // closedAt or mechanical.
  if ("exempt" in record) {
    if (!record.exempt) problems.push("an exempt record needs a reason");
    for (const forbidden of ["mechanical", "judgment", "adjudication"]) {
      if (record[forbidden]) problems.push(`an exempt record must not carry "${forbidden}"`);
    }
    return problems;
  }

  // ── Measured branch ─────────────────────────────────────────────────────
  if (!record.closedAt) {
    problems.push("closedAt is missing — the digest windows on it");
  } else if (Number.isNaN(new Date(record.closedAt).getTime())) {
    // An unparseable closedAt passes every other check here but makes
    // inWindow() evaluate to NaN — silently excluded from every digest
    // window while its PR still counts as "present" for completeness, so
    // the loop is neither reported nor missing.
    problems.push(`closedAt is not a parseable date (got ${JSON.stringify(record.closedAt)})`);
  }

  const m = record.mechanical;
  if (!m || typeof m !== "object") {
    problems.push("mechanical is missing");
    return problems;
  }
  for (const key of Object.keys(m)) {
    if (!MECHANICAL_KEYS.includes(key)) {
      problems.push(
        `mechanical carries "${key}", which is not in the allowlist (${MECHANICAL_KEYS.join(", ")}). ` +
          `derive() returns more than the store keeps — persisting pr, judgment, adjudication_sample or ` +
          `state here duplicates something authoritative elsewhere and goes stale on the next refresh.`,
      );
    }
  }
  if (!Number.isInteger(m.findings)) problems.push("mechanical.findings must be an integer");
  if (!Number.isInteger(m.rounds)) problems.push("mechanical.rounds must be an integer");

  // perRound is what the digest actually uses for trend eligibility and
  // volume — findings/rounds being individually well-typed doesn't mean the
  // three agree with each other. One entry per round, findings summing to
  // the aggregate, is what "internally coherent" has to mean here.
  if (!Array.isArray(m.perRound)) {
    problems.push("mechanical.perRound must be an array");
  } else {
    if (Number.isInteger(m.rounds) && m.perRound.length !== m.rounds) {
      problems.push(
        `mechanical.perRound has ${m.perRound.length} entries but mechanical.rounds is ${m.rounds} — one ` +
          `entry per round`,
      );
    }
    // Every entry's findings must itself be a non-negative integer — a
    // silent zero-substitution for a malformed entry (e.g. a string "1")
    // would let it pass the sum check by coincidence while still flowing
    // into findingBearingRounds() as a truthy-positive value downstream.
    let allEntriesValid = true;
    for (const [i, entry] of m.perRound.entries()) {
      if (!Number.isInteger(entry?.findings) || entry.findings < 0) {
        problems.push(`mechanical.perRound[${i}].findings must be a non-negative integer`);
        allEntriesValid = false;
      }
    }
    if (allEntriesValid && Number.isInteger(m.findings)) {
      const perRoundSum = m.perRound.reduce((n, r) => n + r.findings, 0);
      if (perRoundSum !== m.findings) {
        problems.push(
          `mechanical.perRound findings sum to ${perRoundSum} but mechanical.findings is ${m.findings}`,
        );
      }
    }
  }

  // reviewInterval.hours feeds the digest's `hours()` formatter directly
  // (`h.toFixed(1)`), which throws on anything but a number — a record
  // edited by hand (or after a late review) is exactly the case that could
  // introduce a string, an omitted key, or a missing value here. The key
  // must be explicitly present (as null, or a valid object) — an omitted
  // key would otherwise fall through `?? 0` in the digest and silently
  // understate cost rather than fail loudly.
  if (!("reviewInterval" in m)) {
    problems.push("mechanical.reviewInterval is missing — omit it as null, not absent");
  } else if (m.reviewInterval !== null) {
    const h = m.reviewInterval?.hours;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0) {
      problems.push(
        `mechanical.reviewInterval must be null or have a finite, non-negative numeric hours (got ` +
          `${JSON.stringify(m.reviewInterval)})`,
      );
    }
  }

  const deferred = record.judgmentDeferred;
  if (deferred) {
    if (record.judgment) problems.push("a record cannot both defer judgment and carry one");
    if (typeof deferred !== "string" || !deferred.trim()) {
      problems.push("judgmentDeferred must state a reason");
    }
    return problems;
  }

  problems.push(...judgmentProblems(record));

  if (record.judgment && Number.isInteger(m.findings)) {
    const sum = CAUSES.reduce((n, c) => n + (record.judgment.causes?.[c] ?? 0), 0);
    if (sum !== m.findings) {
      problems.push(
        `causal counts sum to ${sum} but findings is ${m.findings} — working-modes.md: "The five ` +
          `category counts must sum exactly to findings; a total that comes up short means a finding ` +
          `was skipped, not that it was hard to classify."`,
      );
    }
  }

  problems.push(...adjudicationProblems(record));
  return problems;
}

/**
 * The frozen ledger must match the baseline recorded at cutover.
 *
 * Without a pinned digest this check could not exist: an offline guard with
 * nothing to compare against cannot tell whether the current checkout differs
 * from the frozen one, so "any change fails" would be decorative. The
 * baseline is written AFTER the one permitted header edit — recording it
 * before would invalidate it the moment the edit landed.
 */
export function ledgerBaselineProblem(actualHash, expectedHash) {
  if (!expectedHash) {
    return (
      `no frozen-ledger baseline at .agents/metrics/loop-ledger.sha256. It is written once, at cutover, ` +
      `AFTER the header edit: shasum -a 256 .agents/metrics/loop-ledger.md | cut -d" " -f1 > ` +
      `.agents/metrics/loop-ledger.sha256`
    );
  }
  if (actualHash !== expectedHash) {
    return (
      `.agents/metrics/loop-ledger.md has changed since it was frozen.\n` +
      `    expected ${expectedHash}\n    actual   ${actualHash}\n` +
      `  It is the permanent archive of the first 42 loops and is not edited again. New loops go to ` +
      `.agents/metrics/loops/<pr>.json.`
    );
  }
  return null;
}

/**
 * Everything that can be wrong with the frozen ledger's presence, given what
 * actually exists on disk — separated from `main()`'s file I/O so the
 * deletion case is directly testable.
 *
 * A baseline existing means the ledger is supposed to be permanent, so the
 * ledger going missing is a failure in its own right, not a skip — the
 * archive of the first 42 loops disappearing is exactly the "any post-cutover
 * change fails CI" case this whole mechanism exists for, deletion included.
 */
export function ledgerCheckProblem({ ledgerExists, baselineExists, actualHash, expectedHash }) {
  if (baselineExists && !ledgerExists) {
    return (
      `.agents/metrics/loop-ledger.md is missing, but a baseline exists at ` +
      `.agents/metrics/loop-ledger.sha256 — it is the permanent archive of the first 42 loops and must not ` +
      `be deleted.`
    );
  }
  if (!ledgerExists) return null; // nothing frozen yet, nothing to check
  return ledgerBaselineProblem(actualHash, baselineExists ? expectedHash : null);
}

function main() {
  const failures = [];

  // ── The frozen archive ──────────────────────────────────────────────────
  const ledgerExists = existsSync(LEDGER);
  const baselineExists = existsSync(LEDGER_BASELINE);
  if (ledgerExists || baselineExists) {
    const actualHash = ledgerExists ? createHash("sha256").update(readFileSync(LEDGER)).digest("hex") : null;
    const expectedHash = baselineExists ? readFileSync(LEDGER_BASELINE, "utf8").trim() : null;
    const problem = ledgerCheckProblem({ ledgerExists, baselineExists, actualHash, expectedHash });
    if (problem) failures.push(`frozen ledger:\n  ${problem}`);
    else if (ledgerExists) console.log("✓ Frozen ledger matches its cutover baseline.");
  }

  // ── The store ───────────────────────────────────────────────────────────
  if (!existsSync(STORE_DIR)) {
    console.log("• No metrics store yet — nothing to validate.");
    if (failures.length) return report(failures);
    return;
  }

  const files = readdirSync(STORE_DIR).filter((f) => f.endsWith(".json"));
  let measured = 0;
  let exempt = 0;

  for (const filename of files.sort()) {
    let record;
    try {
      record = JSON.parse(readFileSync(join(STORE_DIR, filename), "utf8"));
    } catch (e) {
      failures.push(`${filename}:\n  not valid JSON — ${e.message}`);
      continue;
    }
    const problems = recordProblems(record, filename);
    if (problems.length) failures.push(`${filename}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    else if ("exempt" in record) exempt++;
    else measured++;
  }

  if (failures.length) return report(failures);
  console.log(
    `✓ Loop-metrics store: ${measured} measured record(s)` +
      (exempt ? ` and ${exempt} exemption(s)` : "") +
      ` valid — schema, allowlist, causal arithmetic, judgment completeness, and adjudication state.`,
  );
}

function report(failures) {
  console.error(`✗ Loop-metrics check failed:\n`);
  console.error(failures.join("\n\n"));
  console.error("");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
