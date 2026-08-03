import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, markdownFiles } from "../check-manual-tuning-language.mjs";

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

test("catches a teen-number count, and a taxonomy noun like mechanisms/archetypes", () => {
  // Regression: PR #298 round 4 — "which of eleven joke mechanisms it uses"
  // went uncaught on two counts: the number vocabulary jumped straight from
  // "ten" to "twenty" (no eleven..nineteen), and "mechanisms" wasn't in the
  // counted-component noun list.
  assert.ok(scanText("which of eleven joke mechanisms it uses").length > 0, "missed teens + mechanisms");
  assert.ok(scanText("classified into one of twelve archetypes").length > 0, "missed a teen count of archetypes");
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

test('catches "one X or N" as a restated cap, spelled-out numbers included', () => {
  // Regression: PR #298 round 2 — "one fact or fifty" survived because
  // "fifty" is outside counted-component's two..ten word list and there's no
  // noun directly attached (it's elided: "fifty" stands for "fifty facts").
  assert.ok(scanText("this holds whether it's one fact or fifty").length > 0);
  assert.ok(scanText("send back one row or twenty").length > 0);
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

test("a config-only fenced sample is caught without relying on an incidental duration", () => {
  // Regression: PR #298 round 2 — the test above passed only because its
  // fixture appended "// 5 seconds", which tripped the duration rule instead
  // of actually detecting either config value. This fixture has no duration.
  const text = ["```js", "{ intervalMs: 2000, maxConcurrency: 3 }", "```"].join("\n");
  assert.deepEqual(ids(text), ["config-kv", "config-kv"]);
});

test("catches an identifier:number config pair outside a fence too", () => {
  assert.deepEqual(ids("set maxConcurrency: 3 in the job config"), ["config-kv"]);
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

test("bold/code markup around a value does not hide it from the rules", () => {
  // Regression: PR #298 round 2 — scanText("up to **50** eligible") returned
  // no findings, because the raw asterisks broke the batch-cap regex.
  assert.ok(scanText("up to **50** eligible").length > 0, "missed a bolded value");
  assert.ok(scanText("up to `50` eligible").length > 0, "missed a code-quoted value");
});

test("a phrase split across a hard-wrapped line break is still caught", () => {
  // Regression: PR #298 round 2 — scanText("3 send-back\nattempts") returned
  // no findings, because each physical line was scanned in isolation and
  // this corpus hard-wraps prose at its own line width.
  const text = ["a fact whose last 3 send-back", "attempts all failed drops out"].join("\n");
  const found = scanText(text);
  assert.ok(found.length > 0, "missed a phrase split by a line wrap");
  assert.equal(found[0].line, 1, "attributes the match to the line where it starts");
});

test("a line-wrap match is reported exactly once, not on both lines of the window", () => {
  const text = ["a fact whose last 3 send-back", "attempts all failed, and this line is clean"].join("\n");
  assert.equal(scanText(text).length, 1);
});

test("a blank line breaks the join — unrelated paragraphs don't combine into a false match", () => {
  // If "five" (end of one paragraph) joined across the blank line with "lanes
  // of traffic" (start of the next), that would falsely read as a count.
  const text = ["there were five", "", "lanes of traffic backed up"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("the escape hatch still applies when a hard-wrapped phrase finishes on an ignored line", () => {
  // Regression: PR #298 round 3 — scanText("last 3 send-back\nattempts <!--
  // tuning-ok -->") reported counted-component, because the window still
  // joined with a next line that was itself suppressed. A phrase that starts
  // clean and finishes on a deliberately-ignored continuation must not be
  // flagged — the escape hatch has to survive the line-wrap join.
  const text = ["last 3 send-back", "attempts <!-- tuning-ok -->"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("a suppressed next line's content cannot leak into an earlier line via the join", () => {
  const text = ["a fact whose last 3 send-back", "<!-- tuning-ok -->attempts, quoted deliberately"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("spelled-out numbers are caught by every numeric rule, not just elliptical-cap", () => {
  // Regression: PR #298 round 3 — round 2's tens-word support was added only
  // to elliptical-cap, so "up to fifty eligible", "polls every five seconds",
  // and "last fifty retries" all still passed.
  assert.ok(scanText("send back up to fifty eligible facts").length > 0, "missed batch-cap: fifty");
  assert.ok(scanText("polls every five seconds").length > 0, "missed duration: five seconds");
  assert.ok(scanText("a fact whose last fifty retries failed").length > 0, "missed counted-component: fifty retries");
});

test('"hundreds" is not a duration — attached "s" only fires on digits, not spelled numbers', () => {
  // Regression: PR #298 round 3's own fix — extending duration's number
  // vocabulary to spelled-out words re-used the "attached s" shorthand
  // (`60s`), which then also matched "hundred" + "s" = the ordinary English
  // word "hundreds" ("hundreds of facts"), not a duration.
  assert.deepEqual(scanText("this affects hundreds of facts across the corpus"), []);
});

test("normalizes italics and markdown links too, not just bold/code", () => {
  // Regression: PR #298 round 3 — scanText("up to *50* eligible"),
  // scanText("polls every _2_ seconds"), and scanText("up to [50](../spec.md)
  // eligible") all returned no findings; the claim that this corpus doesn't
  // use single-asterisk italics or links was wrong (moderation.md and
  // README.md both do).
  assert.ok(scanText("up to *50* eligible").length > 0, "missed an italicized value");
  assert.ok(scanText("polls every _2_ seconds").length > 0, "missed an underscore-italicized value");
  assert.ok(scanText("up to [50](../spec.md) eligible").length > 0, "missed a value inside link text");
});

test("italics stripping does not corrupt a snake_case identifier", () => {
  // max_concurrency_limit has two underscores, which a naive strip could
  // misread as an italics pair around "concurrency_limit".
  assert.deepEqual(matches("set max_concurrency_limit: 3 in the job config"), ["max_concurrency_limit: 3"]);
});

test("catches a snake_case config key, not just camelCase", () => {
  // Regression: PR #298 round 3 — "max_concurrency: 3" went uncaught because
  // config-kv's identifier class excluded underscores.
  assert.deepEqual(ids("{ max_concurrency: 3 }"), ["config-kv"]);
});

test("a stray tuning-ok:end with no matching start is flagged, not silently honored", () => {
  // Regression: PR #298 round 3 — scanText("polls every 2 seconds <!--
  // tuning-ok:end -->") returned no findings at all: the unmatched end
  // marker silently exempted the whole line instead of being rejected.
  assert.deepEqual(ids("polls every 2 seconds <!-- tuning-ok:end -->"), ["malformed-ignore-marker", "duration"]);
});

test("a properly matched tuning-ok:end is not flagged as malformed", () => {
  const text = ["<!-- tuning-ok:start -->", "five lanes", "<!-- tuning-ok:end -->"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("scans manual chapters in nested subdirectories, not just the top level", async () => {
  // Regression: PR #298 round 3 — markdownFiles only listed files directly
  // in docs/manual/, so a chapter added under a subdirectory (e.g.
  // docs/manual/admin/) was never scanned at all.
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "manual-tuning-guard-test-"));
  try {
    await mkdir(path.join(dir, "admin"));
    await writeFile(path.join(dir, "top-level.md"), "clean\n");
    await writeFile(path.join(dir, "admin", "queues.md"), "clean\n");
    const files = markdownFiles(dir);
    assert.ok(files.includes(path.join(dir, "top-level.md")), "top-level chapter not discovered");
    assert.ok(files.includes(path.join(dir, "admin", "queues.md")), "nested chapter not discovered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
