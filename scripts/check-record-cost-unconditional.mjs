#!/usr/bin/env node
/**
 * Recording spend must not be conditional on pricing either.
 * ────────────────────────────────────────────────────────────────────────────
 * Sibling to `check-budget-gate-unconditional.mjs`, for the second half of the
 * same defect class.
 *
 * That guard stops the *gate* being skipped on a pricing miss. This one stops
 * the *ledger write* being skipped on a pricing miss — which PR #474 left
 * behind and Release B of the is_estimated plan fixes. The failure is the same
 * shape and the same money: a generation was checked against the ceiling, ran,
 * cost real money, and then wrote nothing. Across a sustained pricing outage
 * the enforcement SUM stops growing while spend continues, so the ceiling
 * progressively stops binding — silently, because nothing errors.
 *
 * WHY A GUARD AND NOT A UNIT TEST — and this one was measured, not assumed.
 * After writing Release B I restored the old `if (cachedPriceForRecording)`
 * wrapper on the video writer to check my coverage. Result: `pnpm typecheck`
 * reported ZERO errors and the budgetGate suite passed 32/32. The regression
 * that the whole release exists to prevent was invisible to everything I had.
 * Driving it from a test needs the full route plus a mocked provider; the
 * defect meanwhile is a re-introduced conditional in inline control flow,
 * which is exactly what a source guard reads well.
 *
 * WHY NOT JUST REUSE THE GATE GUARD. Its rule is "the call must not be inside
 * a price-conditional branch." That rule is wrong here: the correct shape for
 * recording IS a price conditional —
 *
 *     if (priced) { recordCost({ …, isEstimated: false }) }
 *     else        { recordCost({ …, isEstimated: true  }) }
 *
 * — because the two branches record different provenance. Applying the gate
 * guard's rule verbatim would flag correct code twice over. The invariant here
 * is not "never conditional", it is **"every branch records"**: if one branch
 * of a price-conditional writes to the ledger, the other must too.
 *
 * So this checks two shapes:
 *
 *   1. A price-conditional `if` that records in one branch and not the other —
 *      including the no-`else` case, which is precisely the historical bug.
 *   2. A price-conditional early exit (`if (!priced) return;`) ahead of a
 *      recordCost in the same block, which reaches the same place by a
 *      different route. The gate guard learned this shape the hard way in
 *      round 3 of PR #474's review; inheriting the lesson rather than
 *      rediscovering it.
 *
 * RESIDUAL LIMITS, stated so nobody reads a pass as proof of correctness:
 * price-shaped conditions are recognised by identifier naming (see
 * PRICE_IDENTIFIERS), so a differently-named variable is invisible to it; and
 * a caller that never reaches the recording site at all — an early return far
 * upstream — is out of scope, as is the post-processing boundary the plan
 * deliberately leaves alone (settled decision 6: we charge only for what was
 * delivered).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(REPO_ROOT, "artifacts", "api-server", "src");

/**
 * Identifiers whose truthiness means "a provider price resolved". Naming-based
 * and therefore incomplete — a residual limit, not a claim of coverage.
 */
const PRICE_IDENTIFIERS = [
  "priced",
  "cachedImgPrice",
  "cachedRefPrice",
  "cachedPriceForRecording",
  "cachedPrice",
  "price",
];

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

function isRecordCostCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "recordCost";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "recordCost";
  return false;
}

/** Does this expression's truthiness turn on a price having resolved? */
function isPriceConditional(expr) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && PRICE_IDENTIFIERS.includes(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

function containsRecordCost(node) {
  if (!node) return false;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (isRecordCostCall(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function alwaysExits(stmt) {
  if (!stmt) return false;
  if (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isContinueStatement(stmt) ||
    ts.isBreakStatement(stmt)
  ) {
    return true;
  }
  if (ts.isBlock(stmt)) return stmt.statements.some(alwaysExits);
  return false;
}

const violations = [];

for (const file of walk(API_SRC)) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  if (!source.includes("recordCost")) continue;

  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const report = (node, shape) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (ALLOWLIST.some((e) => e.file === rel && e.line === line)) return;
    violations.push({ file: rel, line, shape });
  };

  const visit = (node) => {
    // Shape 1 — a price-conditional `if` that records in one branch only.
    if (ts.isIfStatement(node) && isPriceConditional(node.expression)) {
      const thenRecords = containsRecordCost(node.thenStatement);
      const elseRecords = containsRecordCost(node.elseStatement);
      if (thenRecords !== elseRecords) {
        report(
          node,
          elseRecords
            ? "price-conditional records in the else branch but not the then branch"
            : node.elseStatement
              ? "price-conditional records in the then branch but not the else branch"
              : "price-conditional records only when a price resolved (no else branch) — an unpriced generation is gated and then written nowhere",
        );
      }
    }

    // Shape 2 — a price-conditional early exit ahead of a recordCost in the
    // same block.
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const stmts = node.statements ?? [];
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (!ts.isIfStatement(stmt) || !isPriceConditional(stmt.expression)) continue;
        const exits = alwaysExits(stmt.thenStatement) || alwaysExits(stmt.elseStatement);
        if (!exits) continue;
        for (let j = i + 1; j < stmts.length; j++) {
          if (containsRecordCost(stmts[j])) {
            report(stmts[j], "a price-conditional early exit skips a later recordCost");
            break;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

if (violations.length > 0) {
  console.error("[check-record-cost-unconditional] Ledger writes skipped on a pricing miss:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.shape}\n`);
  }
  console.error(
    "A generation that passes the gate must leave a ledger row whichever way pricing went.\n" +
      "Record the resolved price with isEstimated: false, or the estimate the gate used with\n" +
      "isEstimated: true — never neither. See docs/plans/is-estimated-cost-ledger.md.",
  );
  process.exit(1);
}

console.log("[check-record-cost-unconditional] OK: no pricing-conditional ledger writes.");
