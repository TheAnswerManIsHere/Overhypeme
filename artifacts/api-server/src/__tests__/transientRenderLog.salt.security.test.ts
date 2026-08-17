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
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { assertIpSaltConfigured } from "../lib/transientRenderLog.js";

const ENV_KEYS = ["IP_HASH_SALT", "REPLIT_DEPLOYMENT", "NODE_ENV"] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const k of ENV_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const GOOD_SALT = "a".repeat(16);

// IMPORTANT: keep beforeEach/afterEach inside a describe(). Under
// `--test-isolation=none` the api-server suite shares one root TAP test across
// files, so a hook registered at module scope fires after every OTHER file's
// tests in the same shard — restoring NODE_ENV / REPLIT_DEPLOYMENT to whatever
// they were when THIS module loaded and silently resetting a sibling suite's
// env mid-run. `siteUrl.test.ts` carries the same note for the same reason: a
// module-scoped hook there once deleted SITE_BASE_URL out from under
// adminNotify.abandonedEmail.test.ts. Saving in beforeEach (not at module
// load) also means the restore is a genuine round-trip of this suite's own
// mutations rather than a snapshot taken at an arbitrary earlier moment.
describe("assertIpSaltConfigured", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("production via REPLIT_DEPLOYMENT", () => {
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

  describe("production via NODE_ENV", () => {
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

  describe("non-production keeps the dev fallback", () => {
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
});

/**
 * The wiring, not the helper.
 *
 * Every case above calls `assertIpSaltConfigured()` directly, so all of them
 * still pass if the call in `index.ts` is deleted or moved below `listen()` —
 * which is precisely the regression that matters: the helper exists, the suite
 * is green, and production boots with the public fallback salt anyway.
 *
 * This is a static check rather than an execution probe because importing
 * `index.ts` boots the real server — it runs migrations, binds a port, and
 * starts the async-jobs worker — so "exercise the entrypoint" is not available
 * to a unit test here. Reading the entrypoint's AST answers the same question
 * the execution probe would: is the assertion a top-level statement, and does
 * it precede the first statement that can accept traffic or touch the database?
 *
 * **Why checking source is sufficient for what actually ships.** Production runs
 * `dist/index.mjs`, not this file, so a source-order check is only meaningful if
 * the bundler preserves that order. Verified against a real build: `build.mjs`
 * runs esbuild with `bundle: true` and **no** `minify`, and a bare call whose
 * result is unused is a side effect esbuild will not tree-shake, so
 * `assertIpSaltConfigured()` survives at the head of the bundle, ahead of
 * `runMigrations()`, `ensureSchema()`, `app.listen()` and
 * `runAsyncJobsWorker()`. **Residual limit:** turning on `minify`, annotating
 * the call as side-effect-free (esbuild's pure-call annotation), or moving
 * production off this entrypoint would make the source and the shipped artifact
 * diverge without failing this test.
 */
describe("index.ts boot wiring for assertIpSaltConfigured", () => {
  const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
  const source = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );

  /** True when `node` (or anything under it) calls the named function. */
  function callsFunction(node: ts.Node, name: string): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }

  /** Index of the first top-level statement matching `pred`, or -1. */
  function topLevelIndex(pred: (s: ts.Statement) => boolean): number {
    return source.statements.findIndex(pred);
  }

  it("imports the assertion from lib/transientRenderLog", () => {
    const imported = source.statements.some((s) => {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
      if (!s.moduleSpecifier.text.includes("transientRenderLog")) return false;
      const bindings = s.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return false;
      return bindings.elements.some((e) => e.name.text === "assertIpSaltConfigured");
    });
    assert.equal(imported, true, "index.ts must import assertIpSaltConfigured");
  });

  it("calls it as a top-level statement, not inside a function or a conditional", () => {
    const idx = topLevelIndex(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        ts.isIdentifier(s.expression.expression) &&
        s.expression.expression.text === "assertIpSaltConfigured",
    );
    assert.notEqual(
      idx,
      -1,
      "assertIpSaltConfigured() must be a bare top-level call in index.ts — " +
        "wrapping it in a function or an `if` means it may never run at boot",
    );
  });

  it("calls it before migrations, before listen(), and before the jobs worker", () => {
    const assertionIdx = topLevelIndex(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        ts.isIdentifier(s.expression.expression) &&
        s.expression.expression.text === "assertIpSaltConfigured",
    );
    assert.notEqual(assertionIdx, -1);

    // Each of these is a point of no return: after it the process has touched
    // the database, accepted a request, or started hashing IPs for real.
    const gates: Array<[string, (s: ts.Statement) => boolean]> = [
      ["runMigrations()", (s) => callsFunction(s, "runMigrations")],
      ["ensureSchema()", (s) => callsFunction(s, "ensureSchema")],
      ["app.listen()", (s) => /\.listen\s*\(/.test(s.getText(source))],
      ["runAsyncJobsWorker()", (s) => callsFunction(s, "runAsyncJobsWorker")],
    ];

    for (const [label, pred] of gates) {
      const idx = topLevelIndex(pred);
      assert.notEqual(idx, -1, `expected to find the ${label} boot step in index.ts`);
      assert.ok(
        assertionIdx < idx,
        `assertIpSaltConfigured() must run before ${label} (found at statement ` +
          `${assertionIdx}, ${label} at ${idx})`,
      );
    }
  });
});
