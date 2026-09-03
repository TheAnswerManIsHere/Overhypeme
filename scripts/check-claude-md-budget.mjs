#!/usr/bin/env node
// Line budget for CLAUDE.md — the one file loaded into every Claude Code
// session.
//
// The record: 2,446 lines on 2026-08-20, cut to 573 that day (#543), back to
// 728 by 2026-09-03, cut to 534 (#607). A prune without a lock buys about two
// weeks, because every lesson arrives as a longer paragraph and nothing pushes
// back. This check is the push-back: the file may not exceed BUDGET lines, so
// every addition has to displace something. Raising BUDGET is a change to a
// constraint on Claude Code and is David-merge-only (see CODEOWNERS).
//
// Dependency-free, runs in the Build job without install.
// Run locally:  node scripts/check-claude-md-budget.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET = 534;
export const FILE = "CLAUDE.md";

/** Count lines the way `wc -l` does: one per newline, plus one for a trailing partial line. */
export function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Returns null when within budget, else the failure message. */
export function check(text, budget = BUDGET) {
  const lines = countLines(text);
  if (lines <= budget) return null;
  return (
    `${FILE} is ${lines} lines; the budget is ${budget}. Every line of this file loads into every ` +
    `session, so an addition displaces something rather than extending it. Move rationale to ` +
    `docs/ai-context/decisions.md, mechanics to a skill, or cut. Raising the budget is a ` +
    `constraint change David merges (scripts/check-claude-md-budget.mjs, BUDGET).`
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
  console.log(`✓ ${FILE} line budget: ${countLines(text)} of ${BUDGET} lines.`);
}
