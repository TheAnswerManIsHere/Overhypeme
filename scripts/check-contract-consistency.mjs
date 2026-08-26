#!/usr/bin/env node
// Retired-contract guard.
//
// When a working rule is replaced, the replacement lands in the file the agent
// happened to be editing and the OLD rule survives in its twin. This repo
// carries most rules twice by design — CLAUDE.md and docs/ai-context/ state the
// same contract at different altitudes, and the skills restate the mechanics —
// so a rule change that isn't swept leaves a live instruction contradicting the
// one that replaced it. An agent then follows whichever it reads first.
//
// **Why this is a CI check rather than a rule someone remembers.** PR #553
// replaced the review-loop stopping rule three times in one day. Each
// replacement was correctly written into the section being edited and left
// stale in two to four others; the review found five such contradictions
// across two rounds, and a manual sweep afterwards found five MORE the review
// had not reached — including the adjudicator agent's own frontmatter, which
// is the text that loads at dispatch. Every one was a fixed string. The repo's
// standing rule (docs/ai-context/decisions.md, "Recurring failure patterns
// become CI guards, not just doc updates") says that at that point the answer
// is a deterministic check, not another promise to sweep carefully.
//
// **What this CANNOT do, stated so nobody mistakes a green check for
// consistency:** it is a lexical guard. It knows the strings below and nothing
// else. It cannot tell that two sections describe incompatible procedures in
// different words, that a rule is wrong, or that a NEW contradiction has been
// introduced in fresh prose. Those stay human. This catches the one class that
// is regular enough to automate — a retired rule still stated as live.
//
// **Adding an entry is part of retiring a rule.** When a rule is replaced, its
// distinctive phrase goes in RETIRED below in the same commit. That is the
// whole maintenance model: the list grows as rules are retired, and each entry
// pays for itself the first time someone reaches for the old wording.
//
// Dependency-free by design, like the other docs guards, so it runs in CI and
// locally with no install step.
//
// Escape hatch, for deliberately writing ABOUT a retired rule (a decision
// record, a superseding note, this file): mark the line with
// `<!-- retired-ok -->`, or wrap a block in `<!-- retired-ok:start -->` …
// `<!-- retired-ok:end -->`. In .mjs sources the same markers work inside
// comments. Marking is deliberate and cheap; inferring "this looks historical"
// from nearby words was rejected — guessing intent is what this guard exists to
// stop doing.
//
// Run locally:  node scripts/check-contract-consistency.mjs

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Retired contract language. Each entry is a string that must not appear as a
 * live instruction anywhere the agent reads for guidance.
 *
 * `phrase` is matched case-insensitively as a plain substring — never a regex
 * built from data, and never a word this repo also uses innocently. When in
 * doubt the entry is left OUT: a guard that cries wolf gets suppressed
 * everywhere and then guards nothing.
 */
export const RETIRED = [
  {
    phrase: "adjudicatedStop",
    retired: "2026-08-22",
    why: "deleted tier property — it existed to make an unreviewed head mergeable, which the write-gate rule forbids outright",
    instead: "no tier commits a terminal receipt mid-budget; a stop precedes any new commit",
  },
  {
    phrase: "distinctReviewedCommits",
    retired: "2026-08-22",
    why: "deleted record field — it existed only to keep the deleted dispatch-point floor honest",
    instead: "nothing; the mechanism it guarded is gone",
  },
  {
    phrase: "minPasses",
    retired: "2026-08-22",
    why: "deleted validator parameter — the dispatch-point record floor it carried is gone",
    instead: "every adjudication receipt is held to the tripwire floor",
  },
  {
    phrase: "beyond the first",
    retired: "2026-08-22",
    why: "retired adjudication cadence ('after every round beyond the first')",
    instead: "from round 3 onward, on any round that returned findings, before anything is written",
  },
  {
    phrase: "no re-requested rounds",
    retired: "2026-08-22",
    why: "retired internal-tooling carve-out — it left every fix round structurally unreviewable",
    instead: "the internal tier: fixes are re-reviewed, budget 3, two-tier tripwire, strict rubric",
  },
  {
    phrase: "fix-round merge path",
    retired: "2026-08-22",
    why: "retired workaround (David posting the trigger himself, or recutting the PR) for a wedge that no longer exists",
    instead: "the internal tier's ordinary re-request",
  },
  {
    phrase: "outer rail",
    retired: "2026-08-26",
    why: "retired tier-2 tripwire shape (a 2x-budget hard stop) — replaced by the David gate under the two-tier tripwire",
    instead: "the David gate: budget + 3-round self-serve leash, repeating with each David grant, entered with a fresh Fable recommendation",
  },
  {
    phrase: "2x the declared budget",
    retired: "2026-08-26",
    why: "retired David-gate position — the gate sits at budget + 3, not double the budget",
    instead: "the David gate at budget + leash (+ his earlier grants)",
  },
  {
    phrase: "2x its declared budget",
    retired: "2026-08-26",
    why: "retired David-gate position — the gate sits at budget + 3, not double the budget",
    instead: "the David gate at budget + leash (+ his earlier grants)",
  },
  {
    phrase: "no self-serve",
    retired: "2026-08-26",
    why: "retired tier property — every tier now self-serves the leash via the Fable adjudicator",
    instead: "the two-tier tripwire on every tier: Fable at the budget, the David gate at budget + 3",
  },
  {
    phrase: "mandatory 🛑 at 5",
    retired: "2026-08-26",
    why: "retired sensitive-tier shape (uncapped, with a mandatory stop for David at its round 5)",
    instead: "sensitive: budget 5, the same two-tier tripwire as every tier",
  },
  {
    // The same retired rule's other attested wording (.agents/receipts/README.md,
    // working-modes.md) — one rule, two fixed strings, both tracked.
    phrase: "mandatory 🛑 to David at 5",
    retired: "2026-08-26",
    why: "retired sensitive-tier shape (uncapped, with a mandatory stop for David at its round 5)",
    instead: "sensitive: budget 5, the same two-tier tripwire as every tier",
  },
  {
    phrase: "hard cap 3",
    retired: "2026-08-26",
    why: "retired internal-tier shape (straight to David at 3, no extension of any kind)",
    instead: "internal: budget 3, Fable-adjudicated leash to 6, the David gate at 6",
  },
  {
    // The same retired rule's attested prose wording (docs/engineering/
    // code-review.md said "a hard cap of 3 rounds") — one rule, both fixed
    // strings tracked. (Codex, #574 round 1.)
    phrase: "hard cap of 3",
    retired: "2026-08-26",
    why: "retired internal-tier shape (straight to David at 3, no extension of any kind)",
    instead: "internal: budget 3, Fable-adjudicated leash to 6, the David gate at 6",
  },
  {
    // "no second self-serve extension, ever" — the one-extension rule, whose
    // intervening word defeats the "no self-serve" substring. Both spellings
    // this repo actually used are tracked. (Codex, #574 round 1.)
    phrase: "second self-serve extension",
    retired: "2026-08-26",
    why: "retired one-extension rule — the David gate now repeats, and what persists is which gates were passed and what he granted",
    instead: "the repeating David gate: his grant opens exactly those rounds, and the gate stands again where they run out",
  },
  {
    phrase: "second self-service extension",
    retired: "2026-08-26",
    why: "retired one-extension rule — the David gate now repeats, and what persists is which gates were passed and what he granted",
    instead: "the repeating David gate: his grant opens exactly those rounds, and the gate stands again where they run out",
  },
];

const IGNORE_LINE = "<!-- retired-ok -->";
const IGNORE_START = "<!-- retired-ok:start -->";
const IGNORE_END = "<!-- retired-ok:end -->";

/**
 * Where a live instruction can live. Deliberately the agent-facing surfaces:
 * the contracts, the skills, the agent definitions, and the guard sources
 * whose comments are themselves read as contract.
 */
const SCAN_DIRS = ["docs/ai-context", "docs/engineering", ".claude/skills", ".claude/agents", "scripts"];
const SCAN_FILES = ["CLAUDE.md", "AGENTS.md", ".agents/PLANS.md", ".agents/receipts/README.md"];

/**
 * Archives, exempt wholesale. These files exist to RECORD what was decided and
 * when; requiring a marker on every historical sentence in them would be noise
 * with no signal, and their whole purpose makes "is this live guidance?"
 * answerable without one.
 */
const ARCHIVE_EXEMPT = [
  ".agents/metrics/loop-ledger.md",
  "docs/ai-context/decisions.md",
  "scripts/check-contract-consistency.mjs", // this file names every retired phrase by construction
];

const SKIP_DIRS = new Set(["node_modules", ".git", "__tests__", "dist", "build"]);
const SCANNABLE = /\.(md|mjs)$/;

export function collectFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else if (SCANNABLE.test(e.name)) {
        out.push(rel);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(d);
  for (const f of SCAN_FILES) {
    if (existsSync(join(root, f)) && statSync(join(root, f)).isFile()) out.push(f);
  }
  return out.filter((f) => !ARCHIVE_EXEMPT.includes(f)).sort();
}

/**
 * Findings for one file's text. Exported so the guard's own behaviour is
 * testable without touching the filesystem — the same shape the other docs
 * guards use.
 */
export function scanText(text, retired = RETIRED) {
  const findings = [];
  let suppressedFrom = null;
  text.split("\n").forEach((line, i) => {
    if (line.includes(IGNORE_START)) {
      if (suppressedFrom === null) suppressedFrom = i + 1;
      return;
    }
    if (line.includes(IGNORE_END)) {
      if (suppressedFrom !== null) {
        // A matched end closes the block; the marker line itself carries no
        // guidance, so there is nothing further to scan on it.
        suppressedFrom = null;
        return;
      }
      // A STRAY end must not act as an exemption for the line it sits on —
      // that would be a one-character way to silence the guard. Report the
      // marker, then scan the line anyway.
      findings.push({
        line: i + 1,
        phrase: IGNORE_END,
        why: `${IGNORE_END} has no matching ${IGNORE_START} — remove the stray end marker; it suppresses nothing`,
        instead: "",
      });
    } else if (suppressedFrom !== null || line.includes(IGNORE_LINE)) {
      return;
    }
    const haystack = line.toLowerCase();
    const hits = [];
    for (const entry of retired) {
      const at = haystack.indexOf(entry.phrase.toLowerCase());
      if (at !== -1) hits.push({ at, entry });
    }
    // Left-to-right, so a line with two hits reads in the order a person sees
    // them rather than in the order this file happens to list them.
    hits.sort((a, b) => a.at - b.at);
    for (const { entry } of hits) {
      findings.push({ line: i + 1, phrase: entry.phrase, why: entry.why, instead: entry.instead, retired: entry.retired });
    }
  });
  // An unclosed `:start` suppresses everything after it. That is a silent
  // hole in the guard exactly where someone was already writing about a
  // retired rule, so it is reported rather than honoured quietly — same
  // treatment the tuning-language guard gives its own stranded marker.
  if (suppressedFrom !== null) {
    findings.push({
      line: suppressedFrom,
      phrase: IGNORE_START,
      why: `${IGNORE_START} is never closed — every line after it is unchecked`,
      instead: `close the block with ${IGNORE_END}`,
    });
  }
  return findings;
}

function main() {
  const files = collectFiles();
  const all = [];
  for (const file of files) {
    for (const f of scanText(readFileSync(join(ROOT, file), "utf8"))) {
      all.push({ file, ...f });
    }
  }

  if (all.length === 0) {
    console.log(
      `✓ contract consistency: ${files.length} file(s), no retired rule stated as live ` +
        `(${RETIRED.length} retired phrase(s) tracked).`,
    );
    return;
  }

  console.error(`\n✗ ${all.length} retired-contract finding(s) — a replaced rule is still stated as live.\n`);
  for (const f of all) {
    console.error(`  ${f.file}:${f.line}  “${f.phrase}”${f.retired ? `  (retired ${f.retired})` : ""}`);
    console.error(`      ${f.why}`);
    if (f.instead) console.error(`      now: ${f.instead}\n`);
    else console.error("");
  }
  console.error(
    `To resolve: rewrite the sentence to state the CURRENT rule, or — if it is\n` +
      `deliberately describing the retired one (a decision record, a superseding\n` +
      `note) — mark the line with ${IGNORE_LINE} or wrap the block in\n` +
      `${IGNORE_START} … ${IGNORE_END}.\n\n` +
      "This guard is LEXICAL. Green means no TRACKED retired phrase appears as live\n" +
      "guidance — not that the contracts agree with each other.\n",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
