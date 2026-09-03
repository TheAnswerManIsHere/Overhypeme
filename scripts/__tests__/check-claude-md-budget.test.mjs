import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET, check, countLines } from "../check-claude-md-budget.mjs";

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("countLines matches wc -l semantics", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
});

test("exactly at budget passes", () => {
  assert.equal(check(lines(10), 10), null);
});

test("one over budget fails and the message names the number and the fix", () => {
  const msg = check(lines(11), 10);
  assert.ok(msg, "expected a failure message");
  assert.match(msg, /11 lines; the budget is 10/);
  assert.match(msg, /decisions\.md/);
  assert.match(msg, /David merges/);
});

test("the committed CLAUDE.md is within the committed budget", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const text = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
  assert.equal(check(text), null, `CLAUDE.md is ${countLines(text)} lines, budget ${BUDGET}`);
});
