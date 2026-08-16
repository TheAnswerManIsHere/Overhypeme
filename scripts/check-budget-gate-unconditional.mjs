#!/usr/bin/env node
/**
 * The budget gate must not be conditional on pricing.
 * ────────────────────────────────────────────────────────────────────────────
 * Every spend call site resolves a fal price first, then calls `checkBudget`.
 * Resolving the price can fail (no cached row, pricing API down, no FAL key),
 * and three of the four call sites used to wrap the gate in `if (priced)` —
 * so a pricing miss skipped the spend check entirely rather than denying or
 * degrading. The ceiling went unenforced in exactly the window where
 * something else was already failing, logged at WARN only.
 *
 * `videoPipelineRunner.ts` always had the right shape: on a pricing miss it
 * degrades to the engine's configured estimate and still calls the gate. The
 * fix made the other three match.
 *
 * A unit test cannot hold this line — the gate is inline control flow inside
 * large route/pipeline functions, and the regression is a re-introduced
 * conditional, not a wrong number. So this is a source guard, the same
 * instrument `check-permission-chokepoint.mjs` uses for the authorization
 * chokepoint: it fails the build if a `checkBudget` call is ever nested inside
 * a block guarded by a pricing-resolution conditional.
 *
 * What it does NOT check: that the fallback estimate is well-chosen. That is a
 * judgement, not an invariant. This guard only enforces that the gate RUNS.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(REPO_ROOT, "artifacts/api-server/src");

/** Identifiers that hold a resolved-price result; `if (<one of these>)` gates. */
const PRICE_HOLDER = /^priced[A-Za-z0-9_]*$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blanks comment bodies while preserving newlines, so a rule described in
 * prose isn't read as code and reported line numbers stay accurate.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^(\s*)\/\/.*$/gm, "$1");
}

/** Index of the `}` closing the `{` at `openIdx`, or -1. Ignores string bodies. */
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const violations = [];

for (const file of walk(API_SRC)) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const src = stripComments(readFileSync(file, "utf8"));
  if (!src.includes("checkBudget(")) continue;

  // Find every `if (<priceHolder>)` and check whether a checkBudget call lives
  // inside the block it opens.
  const ifPattern = /\bif\s*\(\s*([A-Za-z0-9_]+)\s*\)\s*\{/g;
  let match;
  while ((match = ifPattern.exec(src)) !== null) {
    if (!PRICE_HOLDER.test(match[1])) continue;

    const openIdx = src.indexOf("{", match.index + match[0].length - 1);
    const closeIdx = matchBrace(src, openIdx);
    if (closeIdx === -1) continue;

    const body = src.slice(openIdx, closeIdx);
    if (!body.includes("checkBudget(")) continue;

    violations.push({
      file: rel,
      line: src.slice(0, match.index).split("\n").length,
      identifier: match[1],
    });
  }
}

if (violations.length > 0) {
  console.error("[check-budget-gate-unconditional] FAILED\n");
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}\n` +
        `    checkBudget() is nested inside \`if (${v.identifier})\`, so a pricing\n` +
        `    miss skips the spend check entirely. Call the gate unconditionally and\n` +
        `    pass a fallback estimate instead — see estimateStage2Cost() in\n` +
        `    lib/videoPipelineRunner.ts for the shape.\n`,
    );
  }
  process.exit(1);
}

console.log("[check-budget-gate-unconditional] OK: no pricing-conditional spend gates.");
