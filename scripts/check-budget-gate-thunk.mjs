#!/usr/bin/env node
/**
 * The proposed cost must reach `checkBudget` as a THUNK, never as a value.
 * ────────────────────────────────────────────────────────────────────────────
 * Third guard in the spend-gate family, and the one that had been missing.
 * `check-budget-gate-unconditional.mjs` stops the gate being SKIPPED on a
 * pricing miss; `check-record-cost-unconditional.mjs` stops the ledger write
 * being skipped. Neither says anything about HOW the proposed cost gets to the
 * gate, and that turns out to be its own money bug.
 *
 * THE DEFECT. `checkBudget` returns the admin exemption before it resolves the
 * proposed cost, deliberately — see its body. That ordering is worth nothing if
 * the caller resolves the cost first, because JavaScript evaluates arguments
 * before entering the function. A resolver that throws then denies an exempt
 * admin outright, having never reached the exemption that would have let them
 * through. The failure is silent in the normal case and only appears when an
 * `engines` read fails, which is exactly when nobody is looking.
 *
 * WHY THIS EXISTS RATHER THAN A COMMENT. This has now happened twice:
 *
 *   1. PR #474 round 4 caught `checkBudget(userId, await resolveCost())` and
 *      fixed it by introducing the thunk overload.
 *   2. PR #498 round 3 caught it again — reintroduced by a fix written two
 *      rounds earlier in the very PR that was closing the surrounding
 *      fail-open, by code whose author (me) had read the `checkBudget` comment
 *      describing the bug and reintroduced it anyway.
 *
 * A rule broken twice is a rule that needs a machine, not a third undertaking.
 *
 * THE RULE IS DELIBERATELY BRIGHT-LINE: the second argument must be an arrow
 * function or a function expression. Not "must not be an await expression" —
 * that version would have passed the PR #498 instance, whose argument was the
 * innocuous-looking `estimated.total`, a plain property access on a value
 * resolved by a fallible call on the PREVIOUS line. Distinguishing a safe value
 * from a fallible one at the call site needs dataflow analysis; requiring the
 * thunk unconditionally needs none, and costs a caller with a genuinely cheap
 * value nothing but an arrow.
 *
 * It is also the stronger invariant on its own merits: with a thunk, an exempt
 * admin never even pays for a lookup their request does not need.
 *
 * RESIDUAL LIMIT: this checks the shape of the argument, not what the thunk
 * body does. A thunk that closes over an already-resolved fallible value —
 * `const c = await resolve(); checkBudget(u, async () => c)` — satisfies the
 * guard and reintroduces the bug. That is a narrower and more obviously-wrong
 * shape than the one this catches, and closing it needs the dataflow analysis
 * this deliberately avoids.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(REPO_ROOT, "artifacts", "api-server", "src");

/** Sites intentionally exempt. Empty, and a new entry needs a reason. */
const ALLOWLIST = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A `checkBudget(...)` call — bare or via a property access. */
function isCheckBudgetCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "checkBudget";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "checkBudget";
  return false;
}

const violations = [];

for (const file of walk(API_SRC)) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  if (!source.includes("checkBudget")) continue;

  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node) => {
    if (isCheckBudgetCall(node)) {
      const arg = node.arguments[1];
      const isThunk =
        arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (!isThunk) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (!ALLOWLIST.some((e) => e.file === rel && e.line === line)) {
          violations.push({
            file: rel,
            line,
            got: arg ? arg.getText(sf).slice(0, 60) : "<missing>",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
}

if (violations.length > 0) {
  console.error("[check-budget-gate-thunk] Proposed cost passed to checkBudget as a value:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    second argument is \`${v.got}\`, not a thunk\n`);
  }
  console.error(
    "checkBudget resolves the ADMIN EXEMPTION before it resolves the proposed cost.\n" +
      "Arguments are evaluated before the call, so passing a value throws away that\n" +
      "ordering: a failing cost lookup denies an exempt admin who never needed it.\n" +
      "Pass `async () => <resolve the cost>` instead. See budgetGate.checkBudget.",
  );
  process.exit(1);
}

console.log("[check-budget-gate-thunk] OK: every checkBudget call defers its cost.");
