import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrNumberFromTestRunPath,
  extractWorkstreamIssueNumber,
  hasUatDoc,
  findUatDocFilename,
  stillHasTestRunDoc,
  computeTransition,
  updateStateOfPlayBody,
  bodyStageMatches,
  handoffText,
} from "../sync-test-run-completion.mjs";

test("extractPrNumberFromTestRunPath matches the documented naming convention", () => {
  assert.equal(extractPrNumberFromTestRunPath("docs/PR308_codeql-rate-limiter_TEST_RUN.md"), 308);
  assert.equal(extractPrNumberFromTestRunPath("docs/PR12_feature_TEST_RUN.md"), 12);
});

test("extractPrNumberFromTestRunPath rejects non-TEST_RUN docs", () => {
  assert.equal(extractPrNumberFromTestRunPath("docs/PR308_codeql-rate-limiter_UAT.md"), null);
  assert.equal(extractPrNumberFromTestRunPath("docs/ai-context/decisions.md"), null);
  assert.equal(extractPrNumberFromTestRunPath("docs/PR_TEST_RUN.md"), null);
});

test("extractWorkstreamIssueNumber reads the plain-text marker at the start of a line", () => {
  assert.equal(extractWorkstreamIssueNumber("Workstream: #317\n\n## What & why"), 317);
  assert.equal(extractWorkstreamIssueNumber("## What & why\nWorkstream: #42\nmore text"), 42);
});

test("extractWorkstreamIssueNumber returns null when the marker is absent or malformed", () => {
  assert.equal(extractWorkstreamIssueNumber("## What & why\nno marker here"), null);
  assert.equal(extractWorkstreamIssueNumber("**Workstream:** #317"), null);
  assert.equal(extractWorkstreamIssueNumber(undefined), null);
});

test("extractWorkstreamIssueNumber ignores a marker mid-line, not at line start", () => {
  // e.g. an approved-plan oracle illustrating the convention with an example
  assert.equal(extractWorkstreamIssueNumber("See the example: Workstream: #999 in the template."), null);
});

test("extractWorkstreamIssueNumber never crosses a line break to find a #", () => {
  // \s* in an unanchored version of this regex would match the newline and
  // grab #42 on the next line even though it belongs to unrelated prose
  assert.equal(extractWorkstreamIssueNumber("Workstream:\nsome unrelated text #42"), null);
});

test("stillHasTestRunDoc detects a surviving same-numbered TEST_RUN doc", () => {
  const files = ["PR308_codeql-rate-limiter_TEST_RUN.md", "PR309_other_UAT.md", "decisions.md"];
  assert.equal(stillHasTestRunDoc(files, 308), true);
  assert.equal(stillHasTestRunDoc(files, 309), false);
  assert.equal(stillHasTestRunDoc(files, 999), false);
});

test("hasUatDoc finds a same-numbered UAT doc among mixed filenames", () => {
  const files = ["PR308_codeql-rate-limiter_UAT.md", "PR309_other_TEST_RUN.md", "decisions.md"];
  assert.equal(hasUatDoc(files, 308), true);
  assert.equal(hasUatDoc(files, 309), false);
  assert.equal(hasUatDoc(files, 999), false);
});

test("findUatDocFilename returns the exact matching filename, or null", () => {
  const files = ["PR308_codeql-rate-limiter_UAT.md", "PR309_other_TEST_RUN.md", "decisions.md"];
  assert.equal(findUatDocFilename(files, 308), "PR308_codeql-rate-limiter_UAT.md");
  assert.equal(findUatDocFilename(files, 999), null);
});

test("computeTransition routes to uat only when a UAT doc exists, else close-out", () => {
  assert.deepEqual(computeTransition(true), { stage: "uat", stageDisplay: "🛑 UAT" });
  assert.deepEqual(computeTransition(false), { stage: "close-out", stageDisplay: "Close-out" });
});

test("updateStateOfPlayBody rewrites Stage/Waiting on/Last movement in place", () => {
  const body = [
    "## State of Play",
    "",
    "**Stage:** Test run (Replit)",
    "**Waiting on:** Replit",
    "**Last movement:** 2026-08-01 — merged with TEST_RUN doc",
    "",
    "### What this is",
    "Some narrative that must survive untouched.",
  ].join("\n");

  const updated = updateStateOfPlayBody(body, {
    stageDisplay: "🛑 UAT",
    lastMovementLine: "2026-08-05 — TEST_RUN doc for PR #308 cleared; auto-transitioned to 🛑 UAT.",
  });

  assert.match(updated, /\*\*Stage:\*\* 🛑 UAT/);
  assert.match(updated, /\*\*Waiting on:\*\* David/);
  assert.match(updated, /\*\*Last movement:\*\* 2026-08-05 — TEST_RUN doc for PR #308 cleared/);
  assert.match(updated, /Some narrative that must survive untouched\./);
});

test("updateStateOfPlayBody returns null when the block isn't in the expected shape", () => {
  assert.equal(updateStateOfPlayBody("no state of play block here", { stageDisplay: "🛑 UAT" }), null);
});

test("updateStateOfPlayBody also rewrites What's blocking / What you need to do when given text", () => {
  const body = [
    "**Stage:** Test run (Replit)",
    "**Waiting on:** Replit",
    "**Last movement:** 2026-08-01 — merged with TEST_RUN doc",
    "",
    "### What's blocking",
    "",
    "Waiting on Replit to run the TEST_RUN checklist.",
    "",
    "### What you need to do",
    "",
    "Nothing — this is Replit's turn.",
    "",
    "### Artifacts",
    "",
    "PR #308",
  ].join("\n");

  const updated = updateStateOfPlayBody(body, {
    stageDisplay: "🛑 UAT",
    lastMovementLine: "2026-08-05 — cleared",
    blockingText: "Nothing structural — ready for your UAT click-through.",
    todoText: "Run through `docs/PR308_feature_UAT.md`.",
  });

  assert.match(updated, /### What's blocking\n\nNothing structural — ready for your UAT click-through\.\n\n### What you need to do/);
  assert.match(updated, /### What you need to do\n\nRun through `docs\/PR308_feature_UAT\.md`\.\n\n### Artifacts/);
  assert.doesNotMatch(updated, /Waiting on Replit/);
  assert.match(updated, /PR #308/); // untouched trailing section survives
});

test("updateStateOfPlayBody leaves blocking/todo sections alone when their headings are absent", () => {
  const body = "**Stage:** Test run (Replit)\n**Waiting on:** Replit\n**Last movement:** x\n";
  const updated = updateStateOfPlayBody(body, {
    stageDisplay: "🛑 UAT",
    lastMovementLine: "y",
    blockingText: "should not appear",
    todoText: "should not appear either",
  });
  assert.doesNotMatch(updated, /should not appear/);
});

test("handoffText gives UAT-routing text referencing the exact filename for uat", () => {
  const { blockingText, todoText } = handoffText("uat", "PR308_feature_UAT.md");
  assert.match(blockingText, /ready for your UAT click-through/);
  assert.match(todoText, /docs\/PR308_feature_UAT\.md/);
});

test("handoffText gives close-out text with no UAT reference for close-out", () => {
  const { blockingText, todoText } = handoffText("close-out", null);
  assert.match(blockingText, /no UAT is due/);
  assert.match(todoText, /Nothing right now/);
});

test("bodyStageMatches detects an already-reconciled Stage line", () => {
  const body = "**Stage:** 🛑 UAT\n**Waiting on:** David\n";
  assert.equal(bodyStageMatches(body, "🛑 UAT"), true);
  assert.equal(bodyStageMatches(body, "Close-out"), false);
});

test("bodyStageMatches is false when there's no Stage line at all", () => {
  assert.equal(bodyStageMatches("no state of play block here", "🛑 UAT"), false);
  assert.equal(bodyStageMatches(undefined, "🛑 UAT"), false);
});
