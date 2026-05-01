import test from "node:test";
import assert from "node:assert/strict";
import { anonymizedUserRef } from "../lib/dataLifecycle";

test("anonymizedUserRef is deterministic and removes direct identifiers", () => {
  const userId = "user_1234567890_sensitive";
  const a = anonymizedUserRef(userId);
  const b = anonymizedUserRef(userId);
  assert.equal(a, b);
  assert.match(a, /^anon_/);
  assert.equal(a.includes(userId), false);
});
