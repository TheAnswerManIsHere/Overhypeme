// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// #11: a checkout path that needs URL escaping must not silently no-op a
// script's `main()`.
//
// Every script here decided "was I run directly?" by comparing
// `import.meta.url` against a hand-built `file://${process.argv[1]}`. The
// first is percent-encoded; the second is not. In a checkout whose path
// contains a space or `#` they differ, `main()` never runs, and the process
// exits 0. When the PreToolUse guards existed that meant the merge gate, the
// budget and the destructive-command guard all stopped running at once, with a
// directory name as the entire trigger -- because only exit 2 blocks.
//
// THE GUARDS ARE GONE (#89 cut, #94) AND THE CLASS IS NOT. A CLI that reports
// success having evaluated nothing is the same defect wherever it runs: a
// check in CI goes green; a sync reports nothing to copy; a translation is
// never written and no page says it is missing.
// Ten scripts carried the idiom and only one was ever reachable through a
// hook, so the static check was always what closed the class -- and it is
// what survives.
//
// This file exists because that check lived in `guard-decision.test.mjs`,
// which went with the guard. `scripts/__tests__/entry-point-comparison.test.mjs`
// is the handbook's own copy; this is the payload's, and neither suite can see
// the other's directory.
// ---------------------------------------------------------------------------

test("no payload script reintroduces the raw-string entry-point comparison", () => {
  const offenders = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => readFileSync(join(SCRIPTS, f), "utf8").includes("file://${process.argv[1]}"));

  assert.deepEqual(
    offenders,
    [],
    "compare against pathToFileURL(process.argv[1]).href -- a hand-built file:// URL silently no-ops on any path needing escaping, and a script that never runs exits 0",
  );
});

test("every payload script with a CLI actually uses the correct comparison", () => {
  // The check above is a prohibition, and a prohibition is satisfied by a file
  // that has no entry-point guard at all. This is the positive half: a script
  // that declares a `main()` must guard it the one correct way, so a third
  // spelling cannot pass by being neither the banned string nor the right one.
  const wrong = [];
  for (const f of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    if (!/\bfunction main\s*\(/.test(src)) continue;
    if (!src.includes("pathToFileURL(process.argv[1]).href")) wrong.push(f);
  }
  assert.deepEqual(wrong, [], "these declare a main() but do not compare with pathToFileURL(process.argv[1]).href");
});
