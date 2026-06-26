// TEMPORARY — proves the required GitHub CI `Test` check goes red when a test
// fails. DO NOT MERGE. This file is removed immediately after the gate proof.
import { test } from "node:test";
import assert from "node:assert/strict";

test("CI gate proof — intentional failure (DO NOT MERGE)", () => {
  assert.equal(1, 2, "deliberate failure to verify the CI gate reds on a failing test");
});
