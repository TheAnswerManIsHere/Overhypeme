import { test } from "node:test";
import assert from "node:assert/strict";
import { isInertPath, needsHeavyJobs } from "../classify-ci-paths.mjs";

test("docs, .agents, .claude, and top-level prose are inert", () => {
  assert.equal(isInertPath("docs/ai-context/decisions.md"), true);
  assert.equal(isInertPath("docs/PR334_fixes_UAT.md"), true);
  assert.equal(isInertPath(".agents/metrics/loop-ledger.md"), true);
  assert.equal(isInertPath(".claude/skills/status-all/SKILL.md"), true);
  assert.equal(isInertPath(".claude/guard.sh"), true); // exercised by Build, not the heavy jobs
  assert.equal(isInertPath("CLAUDE.md"), true);
  assert.equal(isInertPath("README.md"), true);
  assert.equal(isInertPath("LICENSE"), true);
});

test("workflows, scripts, product code, and package configs are never inert", () => {
  assert.equal(isInertPath(".github/workflows/build.yml"), false);
  assert.equal(isInertPath(".github/pull_request_template.md"), false); // .github stays heavy wholesale
  assert.equal(isInertPath("scripts/sync-test-run-completion.mjs"), false);
  assert.equal(isInertPath("scripts/__tests__/classify-ci-paths.test.mjs"), false);
  assert.equal(isInertPath("artifacts/api-server/src/index.ts"), false);
  assert.equal(isInertPath("lib/api-zod/src/index.ts"), false);
  assert.equal(isInertPath("package.json"), false);
  assert.equal(isInertPath("pnpm-lock.yaml"), false);
});

test("the generated admin field reference is heavy despite living in docs/", () => {
  // fieldDocs.test.ts (Frontend Test) asserts byte-parity between this
  // committed file and renderAdminFieldReference() — an edit to it is
  // exactly what the heavy suite exists to catch, and Build never checks it.
  assert.equal(isInertPath("docs/ADMIN_FIELD_REFERENCE.md"), false);
  // ...while its neighbors stay inert.
  assert.equal(isInertPath("docs/ADMIN_FIELD_REFERENCE_notes.md"), true);
});

test("a nested markdown file outside an inert directory is not inert", () => {
  // Only TOP-LEVEL prose gets the extension-based pass; a stray .md deep in
  // the tree rides with its directory's classification.
  assert.equal(isInertPath("artifacts/overhype-me/README.md"), false);
});

test("needsHeavyJobs is false only when every file is inert", () => {
  assert.equal(needsHeavyJobs(["docs/ai-context/decisions.md", "CLAUDE.md"]), false);
  assert.equal(needsHeavyJobs([".claude/skills/pr-watch/SKILL.md"]), false);
});

test("one non-inert file among many inert ones forces the full suite", () => {
  assert.equal(
    needsHeavyJobs(["docs/ai-context/decisions.md", "scripts/sync-test-run-completion.mjs", "CLAUDE.md"]),
    true,
  );
});

test("an empty change list fails safe to the full suite", () => {
  // An empty list means the file-listing API call failed or returned
  // nothing — "unknown" must never classify as "skippable."
  assert.equal(needsHeavyJobs([]), true);
});
