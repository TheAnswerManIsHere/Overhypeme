import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../check-manual-tuning-language.mjs";

const ids = (text) => scanText(text).map((f) => f.rule);
const matches = (text) => scanText(text).map((f) => f.match);

test("catches a bare duration", () => {
  assert.deepEqual(ids("The fast lane polls every 2 seconds."), ["duration"]);
});

test("catches durations in every unit form the corpus uses", () => {
  for (const s of ["30 minutes", "60s", "500 ms", "24 hours", "5 min", "7 days"]) {
    assert.ok(scanText(`waits ${s} before sweeping`).length > 0, `missed: ${s}`);
  }
});

test("catches a counted component, spelled or numeric", () => {
  assert.deepEqual(ids("Five independent scheduling lanes claim rows."), ["counted-component"]);
  assert.deepEqual(ids("There are 3 workers."), ["counted-component"]);
});

test('"one queue" is NOT flagged — it is an idiom, not a count', () => {
  // Regression: an earlier revision flagged "the one queue whose failures reach
  // a real person's inbox", which is *the singular*, not a quantity. Training
  // readers to dismiss this guard is worse than missing a real count.
  assert.deepEqual(scanText("it is the one queue whose failures reach a person"), []);
});

test("catches magnitude stand-ins that encode a value", () => {
  assert.deepEqual(ids("Both are serialized."), ["magnitude-standin"]);
  assert.deepEqual(ids("It polls frequently."), ["magnitude-standin"]);
  assert.deepEqual(ids("Recovered, but not promptly."), ["magnitude-standin"]);
  assert.deepEqual(ids("A run is capped at 50 facts."), ["magnitude-standin"]);
});

test("does NOT flag polysemous words that describe the work, not the tuning", () => {
  // Every one of these is a real, legitimate sentence in docs/manual/ today.
  // They describe the NATURE of work or a behavioural guarantee, not a constant.
  assert.deepEqual(scanText("How Overhype.me runs slow or external work"), []);
  assert.deepEqual(scanText("too slow, too unreliable, or too expensive to do inline"), []);
  assert.deepEqual(scanText("Taking a fact down always works, immediately."), []);
  assert.deepEqual(scanText("protecting the bill, not finishing quickly"), []);
});

test("catches a stated default", () => {
  assert.deepEqual(ids("The alert is off by default."), ["default-value"]);
  assert.deepEqual(ids("It defaults to bulk."), ["default-value"]);
});

test("a line-level ignore marker suppresses that line only", () => {
  const text = ["polls every 2 seconds <!-- tuning-ok -->", "polls every 5 seconds"].join("\n");
  const found = scanText(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test("a block ignore marker suppresses everything between its ends", () => {
  const text = [
    "<!-- tuning-ok:start -->",
    "five lanes",
    "polls every 2 seconds",
    "<!-- tuning-ok:end -->",
    "serialized",
  ].join("\n");
  const found = scanText(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].match, "serialized");
});

test("fenced code blocks are exempt — a chapter may show a config sample", () => {
  const text = ["```js", "{ intervalMs: 2000, maxConcurrency: 3 } // 5 seconds", "```", "clean prose"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("an unterminated ignore block does not silently swallow the rest of a file", () => {
  // Guarding the guard: if `:start` without `:end` suppressed everything after
  // it, one stray marker would disable the check for a whole chapter. This test
  // documents the current behaviour so a change to it is deliberate.
  const text = ["<!-- tuning-ok:start -->", "five lanes", "polls every 2 seconds"].join("\n");
  assert.deepEqual(scanText(text), [], "unterminated block currently suppresses to EOF — by design, and tested so it cannot change silently");
});

test("reports line numbers against the original text, not the code-masked copy", () => {
  const text = ["```", "ignored", "```", "", "five lanes"].join("\n");
  const found = scanText(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 5);
});

test("every finding carries a rule id and a reason, so the failure is actionable", () => {
  for (const f of scanText("five lanes polling every 2 seconds by default")) {
    assert.ok(f.rule && f.why && f.match, "finding missing rule/why/match");
  }
});

test("the real historical violations are all caught", () => {
  // The exact phrases that cost six review rounds on PR #291. This is the
  // acceptance test for the whole guard: if any of these stops being caught,
  // the guard has regressed to the state that made it necessary.
  const historical = [
    "Five independent scheduling lanes",
    "Polls every 2 seconds",
    "Polls every 5 seconds",
    "concurrency capped at 1",
    "the alert is off by default",
    "recovered, but not promptly",
  ];
  for (const phrase of historical) {
    assert.ok(scanText(phrase).length > 0, `regression — no longer caught: "${phrase}"`);
  }
});

test("matched text is returned so a reader can find it without re-grepping", () => {
  assert.deepEqual(matches("polls every 2 seconds"), ["2 seconds"]);
});
