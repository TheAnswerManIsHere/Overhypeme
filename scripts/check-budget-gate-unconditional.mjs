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
 * chokepoint.
 *
 * WHY THE TYPESCRIPT AST, NOT A REGEX. The first version of this guard matched
 * `if (<identifier>) {` textually. Round 1 of PR #474's review demonstrated
 * with a probe file that `if (priced !== null) { await checkBudget(...) }`
 * sailed straight through it — as would `if (priced && x)`, a brace-less
 * `if (priced) await checkBudget(...)`, and an early-return
 * `if (!priced) return;`. A guard that is the SOLE regression check for a
 * money bug cannot be narrower than the bug, so this walks parsed control flow
 * and catches five shapes:
 *
 *   1. the call nested inside a branch of a price-conditional `if`
 *   2. the call inside a branch of a price-conditional ternary
 *   3. a brace-less price-conditional statement wrapping the call
 *   4. an earlier `if (!priced) return/throw/continue/break;` in the same block
 *   5. the call short-circuited by `priced && …`, `priced || …`, `priced ?? …`
 *
 * Shape 5 is the one that survived the first AST rewrite: that version treated
 * everything in an `if` condition as unconditional, which is true of the
 * condition as a whole but false of the right-hand operand of a `&&` inside
 * it — `if (priced && await checkBudget(...))` skips the gate on a pricing
 * miss. Round 2 caught it with its own probe. The lesson worth keeping: each
 * time this guard was narrowed to what looked like "the" shape of the bug, a
 * cheaper equivalent shape was still reachable.
 *
 * What it does NOT check: that the fallback estimate is well-chosen. That is a
 * judgement, not an invariant. This guard only enforces that the gate RUNS.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(REPO_ROOT, "artifacts/api-server/src");

/**
 * Identifiers treated as holding a price-resolution result. Deliberately broad
 * (anything with "price"/"priced" in the name): for a guard, over-matching is
 * loud and fixable at review time, while under-matching is silent and is
 * exactly what round 1 caught. A legitimately-blocked call site goes in
 * ALLOWLIST below rather than being handled by narrowing this.
 */
const PRICE_IDENTIFIER = /price/i;

/**
 * Named, reviewed exceptions. Each MUST carry the reason — an exception
 * without one is just a hole. Empty today, and that is the intended state.
 * Shape: { file: "<repo-relative path>", line: <number>, reason: "..." }
 */
const ALLOWLIST = [];

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

/** True if any identifier under `node` looks like a price-resolution result. */
function referencesPrice(node) {
  if (!node) return false;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && PRICE_IDENTIFIER.test(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** True if this statement always leaves the current block. */
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
  if (ts.isBlock(stmt)) {
    return stmt.statements.some(alwaysExits);
  }
  return false;
}

/** `checkBudget(...)` / `something.checkBudget(...)` */
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

  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);

  const report = (node, shape) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (ALLOWLIST.some((e) => e.file === rel && e.line === line)) return;
    violations.push({ file: rel, line, shape });
  };

  const visit = (node) => {
    if (isCheckBudgetCall(node)) {
      // Shapes 1–3 and 5: an enclosing price-conditional.
      const pos = node.getStart(sf);
      const within = (n) => n && pos >= n.getStart(sf) && pos < n.getEnd();

      for (let p = node.parent; p; p = p.parent) {
        // Short-circuit operands. `if (priced && await checkBudget(...))` skips
        // the gate on a pricing miss just as surely as nesting does — round 2
        // of PR #474's review found the first AST version exempting the whole
        // condition as "unconditional", which is true of the condition but NOT
        // of the right-hand side of an `&&`/`||` inside it. Checked before the
        // `if` case below, and independently of it, because this shape occurs
        // in assignments and returns too, not only in conditions.
        if (
          ts.isBinaryExpression(p) &&
          (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
          within(p.right) &&
          referencesPrice(p.left)
        ) {
          report(
            node,
            `short-circuited by \`${p.left.getText(sf).slice(0, 40)} ${p.operatorToken.getText(sf)} …\``,
          );
          break;
        }

        if (ts.isIfStatement(p) && referencesPrice(p.expression)) {
          // Only the BRANCHES are conditional — a call in the condition itself
          // runs unconditionally unless short-circuited, which the check above
          // already caught. Test by position rather than by text.
          if (within(p.thenStatement) || within(p.elseStatement)) {
            report(node, `nested inside \`if (${p.expression.getText(sf).slice(0, 60)})\``);
            break;
          }
        }

        if (
          ts.isConditionalExpression(p) &&
          referencesPrice(p.condition) &&
          (within(p.whenTrue) || within(p.whenFalse))
        ) {
          report(node, `inside a branch of a price-conditional ternary`);
          break;
        }

        if (ts.isFunctionLike(p)) break; // don't escape the enclosing function
      }

      // Shape 4: an earlier price-conditional early-return in the same block.
      let stmt = node;
      while (stmt.parent && !ts.isBlock(stmt.parent)) stmt = stmt.parent;
      const block = stmt.parent;
      if (block && ts.isBlock(block)) {
        for (const prior of block.statements) {
          if (prior === stmt) break;
          if (ts.isIfStatement(prior) && referencesPrice(prior.expression) && alwaysExits(prior.thenStatement)) {
            report(node, `preceded by an early-return guard \`if (${prior.expression.getText(sf).slice(0, 60)})\``);
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
  console.error("[check-budget-gate-unconditional] FAILED\n");
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}\n` +
        `    checkBudget() is ${v.shape}, so a pricing miss skips the spend\n` +
        `    check entirely. Call the gate unconditionally and pass a fallback\n` +
        `    estimate instead — see estimateStage2Cost() in\n` +
        `    lib/videoPipelineRunner.ts for the shape.\n`,
    );
  }
  process.exit(1);
}

console.log("[check-budget-gate-unconditional] OK: no pricing-conditional spend gates.");
