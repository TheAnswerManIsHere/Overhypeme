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
 * So this checks four shapes:
 *
 *   1. A price-conditional `if` that records in one branch and not the other —
 *      including the no-`else` case, which is precisely the historical bug.
 *   2. A price-conditional early exit (`if (!priced) return;`) ahead of a
 *      recordCost in the same block, which reaches the same place by a
 *      different route. The gate guard learned this shape the hard way in
 *      round 3 of PR #474's review; inheriting the lesson rather than
 *      rediscovering it.
 *   3. A short-circuit — `priced && recordCost(...)`, or the `||` mirror.
 *   4. A ternary — `priced ? recordCost(...) : undefined`.
 *
 * Shapes 3 and 4, and the naming rule in PRICE_IDENTIFIER_RE, come from Codex
 * round 1 on PR #498: it probed all three against the first version of this
 * guard and all three exited 0. That is the honest history of this file — its
 * first draft checked the one shape that had actually occurred, which is how a
 * guard ends up asserting less than its name promises. Each is now covered by
 * an executed probe, together with two negative controls (if/else recording in
 * both branches, and record-then-exit followed by a fall-through record) that
 * must NOT fire.
 *
 * RESIDUAL LIMITS, stated so nobody reads a pass as proof of correctness:
 * price-shaped conditions are still recognised by identifier naming, so a flag
 * named `resolved` or `havePricing` is invisible to it; a caller that never
 * reaches the recording site at all — an early return far upstream — is out of
 * scope; and so is the post-processing boundary the plan deliberately leaves
 * alone (settled decision 6: we charge only for what was delivered).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(REPO_ROOT, "artifacts", "api-server", "src");

/**
 * Does this identifier's truthiness plausibly mean "a price or cost resolved"?
 *
 * This started as an explicit list of the six names in use. Codex round 1
 * showed why that was the wrong shape: `if (estimatedCostUsd > 0)` — the exact
 * wrapper this release removed from the video writer — sailed through, because
 * the guard was matching the names it had seen rather than the naming *rule*.
 * A guard whose coverage is a list of yesterday's variable names protects
 * against yesterday's regression only.
 *
 * So: any identifier containing "price" or "cost", case-insensitively. Still
 * naming-based, and still a residual limit — a `resolved` or `havePricing`
 * flag is invisible to it. But it now covers the whole naming convention this
 * codebase actually uses rather than an enumeration of it.
 */
const PRICE_IDENTIFIER_RE = /pric|cost/i;

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
    if (ts.isIdentifier(n) && PRICE_IDENTIFIER_RE.test(n.text)) {
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

  /**
   * Is this `if` covered by the "one branch exits, the fall-through records"
   * shape? `if (priced) { recordCost(...); return; } recordCost(...)` records on
   * both paths and is correct, even though the `if` itself looks one-sided.
   */
  const fallThroughRecords = (ifStmt, siblings, index) => {
    if (ifStmt.elseStatement) return false;
    if (!alwaysExits(ifStmt.thenStatement)) return false;
    for (let j = index + 1; j < siblings.length; j++) {
      if (containsRecordCost(siblings[j])) return true;
    }
    return false;
  };

  /** Statement lists, so shape 1 and shape 2 can both see an `if`'s siblings. */
  const blockIndex = new Map();
  const indexBlocks = (node) => {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const stmts = node.statements ?? [];
      stmts.forEach((s, i) => blockIndex.set(s, { stmts, i }));
    }
    ts.forEachChild(node, indexBlocks);
  };
  indexBlocks(sf);

  const visit = (node) => {
    // Shape 1 — a price-conditional `if` that records in one branch only.
    if (ts.isIfStatement(node) && isPriceConditional(node.expression)) {
      const thenRecords = containsRecordCost(node.thenStatement);
      const elseRecords = containsRecordCost(node.elseStatement);
      const sib = blockIndex.get(node);
      const covered = sib ? fallThroughRecords(node, sib.stmts, sib.i) : false;
      if (thenRecords !== elseRecords && !covered) {
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
    // same block. Only a violation when the EXITING branch records nothing:
    // `if (!priced) return;` before a write is the bug, while
    // `if (priced) { recordCost(...); return; }` before a write is correct.
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const stmts = node.statements ?? [];
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (!ts.isIfStatement(stmt) || !isPriceConditional(stmt.expression)) continue;
        const thenExits = alwaysExits(stmt.thenStatement);
        const elseExits = alwaysExits(stmt.elseStatement);
        if (!thenExits && !elseExits) continue;
        const exitingRecords =
          (thenExits && containsRecordCost(stmt.thenStatement)) ||
          (elseExits && containsRecordCost(stmt.elseStatement));
        if (exitingRecords) continue;
        for (let j = i + 1; j < stmts.length; j++) {
          if (containsRecordCost(stmts[j])) {
            report(stmts[j], "a price-conditional early exit skips a later recordCost");
            break;
          }
        }
      }
    }

    // Shape 3 — short-circuit: `priced && recordCost(...)`, which records on
    // one path and silently does nothing on the other. `||` is the mirror
    // image. Codex probed both against the IfStatement-only version of this
    // guard and both exited 0.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      isPriceConditional(node.left) &&
      containsRecordCost(node.right) &&
      !containsRecordCost(node.left)
    ) {
      report(
        node,
        "price-conditional short-circuit records on one path only — the other path is gated and written nowhere",
      );
    }

    // Shape 4 — ternary: `priced ? recordCost(...) : undefined`.
    if (
      ts.isConditionalExpression(node) &&
      isPriceConditional(node.condition) &&
      containsRecordCost(node.whenTrue) !== containsRecordCost(node.whenFalse)
    ) {
      report(node, "price-conditional ternary records in one arm only");
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
