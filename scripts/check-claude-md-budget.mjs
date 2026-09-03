#!/usr/bin/env node
// Size budget for CLAUDE.md — the one file loaded into every Claude Code
// session.
//
// The record: 2,446 lines on 2026-08-20, cut to 573 that day (#543), back to
// 728 by 2026-09-03, cut to 534 (#607). A prune without a lock buys about two
// weeks, because every lesson arrives as a longer paragraph and nothing pushes
// back. This check is the push-back: the file may not exceed LINE_BUDGET lines
// OR BYTE_BUDGET bytes, so every addition has to displace something. Both are
// checked because either alone is gameable — lines by writing longer lines
// (Codex, #608 round 1), bytes by nothing that matters, but the line count is
// what a reader experiences. Raising either budget is a change to a constraint
// on Claude Code and is David-merge-only (see CODEOWNERS).
//
// Dependency-free, runs in the Build job without install.
// Run locally:  node scripts/check-claude-md-budget.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE_BUDGET = 534;
export const BYTE_BUDGET = 31723;
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
