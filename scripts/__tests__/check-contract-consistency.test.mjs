import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RETIRED, scanText, collectFiles } from "../check-contract-consistency.mjs";

const phrases = (text) => scanText(text).map((f) => f.phrase);

test("catches every tracked retired phrase stated as live guidance", () => {
  // The acceptance test for the whole guard: each entry is a string that
  // actually appeared as a live instruction in this repo and had to be swept
  // by hand. If one stops being caught, the guard has regressed to the state
  // that made it necessary.
  for (const entry of RETIRED) {
    assert.ok(
      scanText(`The loop dispatches ${entry.phrase} when a round returns findings.`).length > 0,
      `regression — no longer caught: "${entry.phrase}"`,
    );
  }
});

test("matching is case-insensitive — prose capitalizes what code does not", () => {
  assert.deepEqual(phrases("Beyond The First round, the adjudicator rules."), ["beyond the first"]);
});

test("a finding carries the line, the reason it was retired, and what replaced it", () => {
  const [finding] = scanText("dispatch beyond the first round");
  assert.equal(finding.line, 1);
  assert.ok(finding.why, "finding missing why");
  assert.ok(finding.instead, "finding missing the current rule");
  assert.ok(finding.retired, "finding missing the retirement date");
});

test("reports the line number of each hit, and every hit on a multi-line file", () => {
  const text = ["clean prose", "the minPasses floor applies", "clean", "adjudicatedStop is set"].join("\n");
  assert.deepEqual(
    scanText(text).map((f) => [f.line, f.phrase]),
    [
      [2, "minPasses"],
      [4, "adjudicatedStop"],
    ],
  );
});

test("two retired phrases on one line are both reported", () => {
  assert.deepEqual(phrases("minPasses and adjudicatedStop were paired"), ["minPasses", "adjudicatedStop"]);
});

test("a line-level retired-ok marker suppresses that line only", () => {
  const text = ["adjudicatedStop was deleted <!-- retired-ok -->", "adjudicatedStop is set on the tier"].join("\n");
  const found = scanText(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test("a block marker suppresses everything between its ends", () => {
  const text = [
    "<!-- retired-ok:start -->",
    "The old rule dispatched beyond the first round.",
    "It carried minPasses and adjudicatedStop.",
    "<!-- retired-ok:end -->",
    "the record still names distinctReviewedCommits",
  ].join("\n");
  assert.deepEqual(phrases(text), ["distinctReviewedCommits"]);
});

test("a stray :end with no matching :start is flagged, not silently honored", () => {
  // Guarding the guard: an unmatched end marker must not read as an exemption
  // for the line it sits on.
  assert.deepEqual(phrases("minPasses applies <!-- retired-ok:end -->"), ["<!-- retired-ok:end -->", "minPasses"]);
});

test("an unterminated :start is reported, not left as a silent hole", () => {
  // `:start` with no `:end` suppresses to end-of-file. That is a hole in the
  // guard exactly where someone was writing about a retired rule, so the
  // stranded marker is itself a finding.
  const text = ["<!-- retired-ok:start -->", "the old minPasses floor", "and adjudicatedStop"].join("\n");
  const found = scanText(text);
  assert.deepEqual(phrases(text), ["<!-- retired-ok:start -->"]);
  assert.equal(found[0].line, 1, "reports the line carrying the unmatched start");
});

test("a nested :start does not un-suppress the block when the inner one closes", () => {
  const text = [
    "<!-- retired-ok:start -->",
    "<!-- retired-ok:start -->",
    "minPasses",
    "<!-- retired-ok:end -->",
    "adjudicatedStop",
  ].join("\n");
  // The block opened at line 1 is still the one in force; the inner marker is
  // treated as noise rather than as a second scope. Whichever way that lands,
  // it must not leave a phrase unreported AND unflagged.
  assert.deepEqual(phrases(text), ["adjudicatedStop"]);
});

test("clean prose stating the CURRENT rule produces no findings", () => {
  const text = [
    "From round 3 onward, dispatch the adjudicator on any round that returned",
    "findings, before anything is written for them. Every tier self-serves a",
    "3-round leash past its budget; the David gate stands at budget + leash.",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("scanText takes the retired list as a parameter, so a caller can test one rule in isolation", () => {
  const custom = [{ phrase: "old rule", retired: "2026-01-01", why: "replaced", instead: "the new rule" }];
  assert.deepEqual(scanText("we follow the old rule here", custom).map((f) => f.phrase), ["old rule"]);
  assert.deepEqual(scanText("we follow the old rule here", []), []);
});

test("every RETIRED entry is well-formed — a half-written entry would fail open", () => {
  const seen = new Set();
  for (const entry of RETIRED) {
    assert.ok(entry.phrase && entry.phrase.length > 2, `phrase too short to be distinctive: ${entry.phrase}`);
    assert.ok(entry.retired, `missing retirement date: ${entry.phrase}`);
    assert.ok(entry.why, `missing why: ${entry.phrase}`);
    assert.ok(entry.instead, `missing replacement: ${entry.phrase}`);
    assert.ok(!seen.has(entry.phrase.toLowerCase()), `duplicate phrase: ${entry.phrase}`);
    seen.add(entry.phrase.toLowerCase());
  }
});

test("no retired phrase is a substring of another — that would double-report one hit", () => {
  for (const a of RETIRED) {
    for (const b of RETIRED) {
      if (a === b) continue;
      assert.ok(
        !a.phrase.toLowerCase().includes(b.phrase.toLowerCase()),
        `"${b.phrase}" is contained in "${a.phrase}" — one occurrence would report twice`,
      );
    }
  }
});

test("the scanned corpus actually includes the contract surfaces this guard exists for", () => {
  // Regression insurance for the walker itself: a silently-empty file list
  // makes the guard pass forever. PR #553's ten contradictions lived in
  // exactly these places, including an agent definition's frontmatter.
  const files = collectFiles();
  assert.ok(files.length > 20, `suspiciously small corpus: ${files.length} file(s)`);
  for (const expected of [
    "CLAUDE.md",
    "docs/ai-context/working-modes.md",
    ".claude/skills/pr-watch/SKILL.md",
    ".claude/agents/review-loop-adjudicator.md",
    "scripts/review-budget.mjs",
  ]) {
    assert.ok(files.includes(expected), `not scanned: ${expected}`);
  }
});

test("archives and the guard's own source are exempt wholesale", () => {
  const files = collectFiles();
  for (const exempt of [
    "docs/ai-context/decisions.md",
    ".agents/metrics/loop-ledger.md",
    "scripts/check-contract-consistency.mjs",
  ]) {
    assert.ok(!files.includes(exempt), `should be exempt but is scanned: ${exempt}`);
  }
});

test("test files are not scanned — this file names every retired phrase by construction", () => {
  assert.ok(!collectFiles().some((f) => f.includes("__tests__")));
});

test("the live corpus is clean — the guard passes on the repo as committed", () => {
  // This is the check CI runs, asserted here too so a failure names the file
  // and line in the same output as the rest of the suite.
  const offenders = collectFiles().flatMap((file) =>
    scanText(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).map(
      (f) => `${file}:${f.line} “${f.phrase}”`,
    ),
  );
  assert.deepEqual(offenders, []);
});
