import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrNumberFromTestRunPath,
  extractWorkstreamIssueNumber,
  hasUatDoc,
  computeTransition,
  swapPrefixedLabel,
  updateStateOfPlayBody,
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

test("extractWorkstreamIssueNumber reads the plain-text marker", () => {
  assert.equal(extractWorkstreamIssueNumber("Workstream: #317\n\n## What & why"), 317);
});

test("extractWorkstreamIssueNumber returns null when the marker is absent or malformed", () => {
  assert.equal(extractWorkstreamIssueNumber("## What & why\nno marker here"), null);
  assert.equal(extractWorkstreamIssueNumber("**Workstream:** #317"), null);
  assert.equal(extractWorkstreamIssueNumber(undefined), null);
});

test("hasUatDoc finds a same-numbered UAT doc among mixed filenames", () => {
  const files = ["PR308_codeql-rate-limiter_UAT.md", "PR309_other_TEST_RUN.md", "decisions.md"];
  assert.equal(hasUatDoc(files, 308), true);
  assert.equal(hasUatDoc(files, 309), false);
  assert.equal(hasUatDoc(files, 999), false);
});

test("computeTransition routes to uat only when a UAT doc exists, else close-out", () => {
  assert.deepEqual(computeTransition(true), { stage: "uat", stageDisplay: "🛑 UAT" });
  assert.deepEqual(computeTransition(false), { stage: "close-out", stageDisplay: "Close-out" });
});

test("swapPrefixedLabel replaces the one matching label and leaves others untouched", () => {
  assert.deepEqual(
    swapPrefixedLabel(["stage:test-run", "waiting:replit", "mode:feature"], "stage:", "uat"),
    ["waiting:replit", "mode:feature", "stage:uat"],
  );
});

test("swapPrefixedLabel adds the label when none of that prefix exists", () => {
  assert.deepEqual(swapPrefixedLabel(["mode:feature"], "waiting:", "david"), [
    "mode:feature",
    "waiting:david",
  ]);
});

test("swapPrefixedLabel throws on more than one label sharing the prefix", () => {
  assert.throws(
    () => swapPrefixedLabel(["stage:test-run", "stage:uat"], "stage:", "close-out"),
    /2 "stage:" labels/,
  );
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
