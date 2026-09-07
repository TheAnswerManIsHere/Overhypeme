#!/usr/bin/env node
// Size budget for CLAUDE.md — the one file loaded into every Claude Code
// session.
//
// The record: 2,446 lines on 2026-08-20, cut to 573 that day (#543), back to
// 728 by 2026-09-03, cut to 534 (#607), raised to 545 on 2026-09-07 (#614) to
// admit the quote-the-instruction rule at full length. A prune without a lock
// buys about two weeks, because every lesson arrives as a longer paragraph and
// nothing pushes back. Both numbers are the file's exact size on the commit
// that set them, so there is no slack to grow into: raising them is a visible
// one-line diff in a PR David merges, which is the point -- growth becomes
// explicit instead of silent. (This check caught its own PR, #608, when a fix
// added one line, and #614, which is why this raise exists.)
//
// WHAT THE 2026-09-07 RAISE DECIDED, because a raised budget with no stated
// reason is just a budget that gets raised again. The rule being admitted was
// ALREADY AGREED and already written down -- in the shared payload, where it
// never reached the file that loads -- so the choice was between carrying it
// at full length, cutting ten lines of rationale from three rules I have
// actually broken, and compressing it to three lines by dropping the reason it
// exists. David chose the raise: the budget exists to stop drift, not to price
// a rule he asked for twice, and rationale is what has made the surviving
// rules stick. The alternative that is NOT available is leaving the rule out.
// This check is the push-back: the file may not exceed LINE_BUDGET lines
// OR BYTE_BUDGET bytes, so every addition has to displace something. Both are
// checked because either alone is gameable — lines by writing longer lines
// (Codex, #608 round 1), bytes by nothing that matters, but the line count is
// what a reader experiences. Raising either budget is a change to a constraint
// on Claude Code, so David merges it. Nothing server-side can enforce that —
// he and Claude Code share one GitHub account (decisions.md, 2026-09-03) —
// which is the reason a CI check, running where Claude Code runs, is the lock.
//
// Dependency-free, runs in the Build job without install.
// Run locally:  node scripts/check-claude-md-budget.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE_BUDGET = 545;
export const BYTE_BUDGET = 32541;
/** Kept for callers that predate the byte budget. */
export const BUDGET = LINE_BUDGET;
export const FILE = "CLAUDE.md";

/** Count lines the way `wc -l` does: one per newline, plus one for a trailing partial line. */
export function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** UTF-8 byte length, the way `wc -c` counts it. */
export function countBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Returns null when within both budgets, else the failure message. */
export function check(text, lineBudget = LINE_BUDGET, byteBudget = BYTE_BUDGET) {
  const lines = countLines(text);
  const bytes = countBytes(text);
  const over = [];
  if (lines > lineBudget) over.push(`${lines} lines; the line budget is ${lineBudget}`);
  if (bytes > byteBudget) over.push(`${bytes} bytes; the byte budget is ${byteBudget}`);
  if (over.length === 0) return null;
  return (
    `${FILE} is ${over.join(" and ")}. Every byte of this file loads into every session, so an ` +
    `addition displaces something rather than extending it. Move rationale to ` +
    `docs/ai-context/decisions.md, mechanics to a skill, or cut. Raising a budget is a ` +
    `constraint change David merges (scripts/check-claude-md-budget.mjs, LINE_BUDGET / BYTE_BUDGET).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const text = readFileSync(resolve(root, FILE), "utf8");
  const failure = check(text);
  if (failure) {
    console.error(`✗ ${failure}`);
    process.exit(1);
  }
  console.log(`✓ ${FILE} budget: ${countLines(text)} of ${LINE_BUDGET} lines, ${countBytes(text)} of ${BYTE_BUDGET} bytes.`);
}
