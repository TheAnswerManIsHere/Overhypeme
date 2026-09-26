// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
//
// check-docs-accuracy.mjs runs its checks at import time against the repository
// it is installed in -- ROOT comes from the script's own location, so it cannot
// be pointed anywhere else. Rather than restructure a working script to make it
// importable, each case here builds a miniature repository in a temp directory,
// copies the REAL script into its scripts/ directory, and runs it there. What is
// under test is therefore the shipped file, not a re-implementation of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "check-docs-accuracy.mjs");

/**
 * Build a temp repo from { "docs/ai-context/x.md": "body" }, run the real
 * checker inside it, and return { code, out }.
 */
function runIn(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-accuracy-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "check-docs-accuracy.mjs"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    const r = spawnSync(process.execPath, [join(root, "scripts", "check-docs-accuracy.mjs")], {
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The exact citation shapes measured on the 2026-09-19 cutover rehearsal.
const RETIRED_LINK = "[`plan-review-contract.md`](./plan-review-contract.md#the-review-oracle-the-pr-body)";
const RETIRED_PATH = "`scripts/review-budget.mjs`";

test("decisions.md may link a retired document: append-only history cannot be repaired", () => {
  const { code, out } = runIn({
    "docs/ai-context/decisions.md": `# Decisions\n\n2026-09-07 — the loop\n\nRouted through ${RETIRED_LINK}.\n`,
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /broken link/);
});

test("decisions.md may cite a retired path in backticks", () => {
  const { code, out } = runIn({
    "docs/ai-context/decisions.md": `# Decisions\n\nThe budget lived in ${RETIRED_PATH}.\n`,
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /does not exist/);
});

// known-failure-patterns.md was exempted from the path pass in an earlier
// revision of this change and is NOT exempt now. Both halves are asserted,
// because the reason is that the file is overwhelmingly live instruction: on
// the cutover rehearsal it named 41 checkable paths, 37 of them live in the
// consumer. Exempting it would have switched those 37 checks off to permit 4.
test("known-failure-patterns.md is NOT exempt from the path check", () => {
  const { code, out } = runIn({
    "docs/ai-context/known-failure-patterns.md": `# Known Failure Patterns\n\nRun ${RETIRED_PATH} nightly.\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /known-failure-patterns\.md: cited path does not exist/);
});

test("known-failure-patterns.md is NOT exempt from the link check", () => {
  const { code, out } = runIn({
    "docs/ai-context/known-failure-patterns.md":
      "# Known Failure Patterns\n\nSee [the contract](./gone.md).\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /known-failure-patterns\.md: broken link → \.\/gone\.md/);
});

// The convention that replaces the exemption: a retired path is written
// without backticks, so it makes no claim for the checker to test.
test("an un-backticked retired path in that file is not a path claim", () => {
  const { code, out } = runIn({
    "docs/ai-context/known-failure-patterns.md":
      "# Known Failure Patterns\n\nRun scripts/review-budget.mjs nightly (since retired).\n",
  });
  assert.equal(code, 0, out);
});

test("a broken live link in an ordinary library doc still fails", () => {
  const { code, out } = runIn({
    "docs/ai-context/architecture-map.md": "# Architecture\n\nSee [the queue](./queue.md).\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /architecture-map\.md: broken link → \.\/queue\.md/);
});

test("a broken live path in an ordinary library doc still fails", () => {
  const { code, out } = runIn({
    "docs/ai-context/architecture-map.md": "# Architecture\n\nRuns `scripts/nonexistent.mjs` nightly.\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /architecture-map\.md: cited path does not exist → `scripts\/nonexistent\.mjs`/);
});

// The exemption names files, never directories: a directory exemption would
// silently cover the next document added beside them.
test("a neighbouring doc beside decisions.md is not exempt", () => {
  const { code, out } = runIn({
    "docs/ai-context/decisions-appendix.md": `# Appendix\n\n${RETIRED_PATH} and [gone](./gone.md).\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /decisions-appendix\.md: broken link/);
  assert.match(out, /decisions-appendix\.md: cited path does not exist/);
});

test("a live link from an exempt file to a file that exists still resolves", () => {
  const { code, out } = runIn({
    "docs/ai-context/decisions.md": "# Decisions\n\nSee [the map](./architecture-map.md).\n",
    "docs/ai-context/architecture-map.md": "# Architecture\n",
  });
  assert.equal(code, 0, out);
});
