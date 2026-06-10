import { test } from "node:test";
import assert from "node:assert/strict";

import { detectNodeTestRunner } from "./index.js";

test("detectNodeTestRunner: true when NODE_TEST_CONTEXT is set (default isolation)", () => {
  assert.equal(detectNodeTestRunner({ NODE_TEST_CONTEXT: "child-v8" }, []), true);
});

test("detectNodeTestRunner: true with a bare --test in execArgv (isolation=none)", () => {
  assert.equal(
    detectNodeTestRunner({}, ["--import", "tsx/esm", "--test-isolation=none", "--test"]),
    true,
  );
});

test("detectNodeTestRunner: true with --test passed via NODE_OPTIONS", () => {
  assert.equal(detectNodeTestRunner({ NODE_OPTIONS: "--no-warnings --test" }, []), true);
});

test("detectNodeTestRunner: false for a normal dev/prod process", () => {
  assert.equal(
    detectNodeTestRunner({ NODE_ENV: "production" }, ["--import", "tsx/esm"]),
    false,
  );
});

test("detectNodeTestRunner: false when only sibling --test-* flags are present", () => {
  assert.equal(
    detectNodeTestRunner({}, ["--test-concurrency=1", "--test-reporter=spec"]),
    false,
  );
});
