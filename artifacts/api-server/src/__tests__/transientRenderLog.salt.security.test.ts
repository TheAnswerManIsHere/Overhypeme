/**
 * Security regression: production must not boot with an unset `IP_HASH_SALT`.
 *
 * `transient_renders.ip_hash` exists so source-IP abuse queries work without
 * retaining PII. That only holds if the salt is secret. `FALLBACK_SALT` is a
 * literal in this repository, which is public, so hashing production IPs with
 * it makes the hashes reversible by anyone while the schema still presents
 * them as a privacy control.
 *
 * A WARN was the only signal for two years, and it could not have been
 * upgraded to a runtime throw: `logTransientRender` catches and swallows its
 * own errors by design, so a throw from `getIpSalt` would be absorbed by that
 * same catch and never surface. Boot is the only loud moment.
 *
 * These tests pin BOTH branches of the canonical production predicate
 * (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"`) independently,
 * because a check written against only one of them passes a test suite while
 * leaving the other deployment shape unguarded — which is the specific
 * regression `deferred-work.md` asked for coverage on.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { assertIpSaltConfigured } from "../lib/transientRenderLog.js";

const ENV_KEYS = ["IP_HASH_SALT", "REPLIT_DEPLOYMENT", "NODE_ENV"] as const;

const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const k of ENV_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = original[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const GOOD_SALT = "a".repeat(16);

describe("assertIpSaltConfigured — production via REPLIT_DEPLOYMENT", () => {
  it("throws when the salt is absent", () => {
    setEnv({ REPLIT_DEPLOYMENT: "1", NODE_ENV: undefined, IP_HASH_SALT: undefined });
    assert.throws(() => assertIpSaltConfigured(), /IP_HASH_SALT is required in production/);
  });

  it("throws when the salt is present but too short", () => {
    // The old predicate accepted any non-empty string for the fallback check's
    // purposes; a 15-char salt is the boundary case that must still fail.
    setEnv({ REPLIT_DEPLOYMENT: "1", NODE_ENV: undefined, IP_HASH_SALT: "a".repeat(15) });
    assert.throws(() => assertIpSaltConfigured(), /at least 16 characters/);
  });

  it("passes at exactly the minimum length", () => {
    setEnv({ REPLIT_DEPLOYMENT: "1", NODE_ENV: undefined, IP_HASH_SALT: GOOD_SALT });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });
});

describe("assertIpSaltConfigured — production via NODE_ENV", () => {
  // The second branch of the `||`. Asserted separately and with
  // REPLIT_DEPLOYMENT explicitly unset, so a check that only consulted
  // REPLIT_DEPLOYMENT would fail here rather than passing by accident.
  it("throws when the salt is absent", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: "production", IP_HASH_SALT: undefined });
    assert.throws(() => assertIpSaltConfigured(), /IP_HASH_SALT is required in production/);
  });

  it("throws when the salt is too short", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: "production", IP_HASH_SALT: "short" });
    assert.throws(() => assertIpSaltConfigured(), /at least 16 characters/);
  });

  it("passes with a usable salt", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: "production", IP_HASH_SALT: GOOD_SALT });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });
});

describe("assertIpSaltConfigured — non-production keeps the dev fallback", () => {
  // Dev, test and preview must not need a secret to boot. This is the half
  // that makes the assertion safe to add at all.
  it("does not throw in development with no salt", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: "development", IP_HASH_SALT: undefined });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });

  it("does not throw in test with no salt", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: "test", IP_HASH_SALT: undefined });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });

  it("does not throw with neither variable set", () => {
    setEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: undefined, IP_HASH_SALT: undefined });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });

  it("does not treat REPLIT_DEPLOYMENT=0 as production", () => {
    // The predicate tests for the string "1" specifically. A Replit preview
    // sets this to "0", and must keep booting without a salt.
    setEnv({ REPLIT_DEPLOYMENT: "0", NODE_ENV: undefined, IP_HASH_SALT: undefined });
    assert.doesNotThrow(() => assertIpSaltConfigured());
  });
});
