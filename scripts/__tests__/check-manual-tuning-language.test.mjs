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

test("catches a counted component through a hyphenated modifier", () => {
  // Regression: PR #298 round 1 — "3 send-back attempts" went uncaught
  // because the modifier whitelist only allowed "independent"/"scheduling".
  assert.ok(scanText("a fact whose last 3 send-back attempts all failed").length > 0);
});

test('"one queue" is NOT flagged — it is an idiom, not a count', () => {
  // Regression: an earlier revision flagged "the one queue whose failures reach
  // a real person's inbox", which is *the singular*, not a quantity. Training
  // readers to dismiss this guard is worse than missing a real count.
  assert.deepEqual(scanText("it is the one queue whose failures reach a person"), []);
});

test("catches a batch ceiling stated as a bare number, no counted-component noun attached", () => {
  // Regression: PR #298 round 1 — "up to 50 at a time" and "up to 50
  // eligible" went uncaught because neither ends in a counted-component noun.
  assert.deepEqual(ids("send back up to 50 at a time from the card"), ["batch-cap"]);
  assert.deepEqual(ids('the dialog says "up to 50 eligible" rather than an exact count'), ["batch-cap"]);
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

test("fenced code blocks are NOT auto-exempt — a config sample is still configuration", () => {
  // A tuning value doesn't stop being one for being formatted as code. Only
  // the explicit tuning-ok escape hatch exempts it, fenced or not.
  const text = ["```js", "{ intervalMs: 2000, maxConcurrency: 3 } // 5 seconds", "```", "clean prose"].join("\n");
  assert.ok(scanText(text).length > 0, "a fenced tuning value must still be caught");
});

test("a deliberately quoted fenced example is exempt via tuning-ok, same as prose", () => {
  const text = [
    "<!-- tuning-ok:start -->",
    "```js",
    "{ intervalMs: 2000, maxConcurrency: 3 } // 5 seconds",
    "```",
    "<!-- tuning-ok:end -->",
    "clean prose",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("an unterminated ignore block is reported, not silently swallowed", () => {
  // Guarding the guard: `:start` without `:end` still suppresses every line
  // after it (a typo or merge conflict can strand the marker), but that must
  // not also disable the check for the rest of the chapter without a trace —
  // the missing `:end` is itself reported as a finding.
  const text = ["<!-- tuning-ok:start -->", "five lanes", "polls every 2 seconds"].join("\n");
  const found = scanText(text);
  assert.deepEqual(ids(text), ["unterminated-ignore-block"]);
  assert.equal(found[0].line, 1, "reports the line carrying the unmatched tuning-ok:start");
});

test("reports line numbers against the original text, fence lines included", () => {
  const text = ["```", "clean", "```", "", "five lanes"].join("\n");
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
