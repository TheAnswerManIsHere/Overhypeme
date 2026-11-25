import test from "node:test";
import assert from "node:assert/strict";

import { envFiles, nonPublicLines, TRACKED_ENV_FILES } from "../check-tracked-env.mjs";

test("finds .env files at any depth and with any suffix, and nothing else", () => {
  assert.deepEqual(
    envFiles([".env", "a/.env.local", "b/c/.env.production", "docs/env.md", "src/.environment.ts", "x/.envrc"]),
    [".env", "a/.env.local", "b/c/.env.production"],
  );
});

test("public VITE_ names pass; comments, blanks and export prefixes are understood", () => {
  assert.deepEqual(nonPublicLines("# comment\n\nVITE_FLAG=true\nexport VITE_ADSENSE_ID=\n"), []);
});

test("a planted server name is refused by line number", () => {
  assert.deepEqual(nonPublicLines("VITE_FLAG=true\nSTRIPE_SECRET_KEY_TEST=sk_test_x\n"), [2]);
});

test("lowercase, look-alike and malformed lines are refused", () => {
  assert.deepEqual(nonPublicLines("vite_flag=1\nVITEFLAG=1\nNOT A LINE\nVITE_=x\n"), [1, 2, 3, 4]);
});

test("only the web app's build values are allowed to be tracked", () => {
  assert.deepEqual([...TRACKED_ENV_FILES], ["artifacts/overhype-me/.env.local"]);
});
