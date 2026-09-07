import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BYTE_BUDGET, LINE_BUDGET, check, countBytes, countLines } from "../check-claude-md-budget.mjs";

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("countLines matches wc -l semantics", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
});

test("countBytes counts UTF-8 bytes, not characters", () => {
  assert.equal(countBytes("a"), 1);
  assert.equal(countBytes("🛑"), 4);
});

test("exactly at both budgets passes", () => {
  const text = lines(10);
  assert.equal(check(text, 10, countBytes(text)), null);
});

test("one line over budget fails and the message names the number and the fix", () => {
  const text = lines(11);
  const msg = check(text, 10, countBytes(text));
  assert.ok(msg, "expected a failure message");
  assert.match(msg, /11 lines; the line budget is 10/);
  assert.match(msg, /decisions\.md/);
  assert.match(msg, /David merges/);
});

test("same-line growth fails the byte budget even when the line count is unchanged (#608)", () => {
  const base = lines(10);
  const grown = base.replace("line 10\n", "line 10 " + "x".repeat(500) + "\n");
  assert.equal(countLines(grown), countLines(base));
  const msg = check(grown, 10, countBytes(base));
  assert.ok(msg, "expected a failure message");
  assert.match(msg, /bytes; the byte budget is/);
  assert.doesNotMatch(msg, /line budget/);
});

test("the committed CLAUDE.md is within both committed budgets", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const text = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
  assert.equal(
    check(text),
    null,
    `CLAUDE.md is ${countLines(text)} lines / ${countBytes(text)} bytes, budgets ${LINE_BUDGET} / ${BYTE_BUDGET}`,
  );
});

test("both budgets are pinned to CLAUDE.md's EXACT size, with no slack", () => {
  // The check's whole mechanism is that there is nothing to grow into: the
  // next addition either displaces something or comes back as a visible
  // one-line diff David merges. "Within budget" preserves none of that -- it
  // is satisfied by a file with room left, and room left is exactly the state
  // the mechanism exists to prevent.
  //
  // It drifted twice in one afternoon after the 2026-09-07 raise, first by two
  // bytes and then by forty, each time because a later commit shrank the file
  // and the constants stayed where the raise had put them. Both times the test
  // above passed. A rule this file has broken twice becomes a check rather
  // than a longer comment. (Codex, #614 round 2.)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const text = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
  assert.deepEqual(
    { lines: LINE_BUDGET, bytes: BYTE_BUDGET },
    { lines: countLines(text), bytes: countBytes(text) },
    "re-pin LINE_BUDGET and BYTE_BUDGET to the file's actual size in the same commit that changes it",
  );
});
