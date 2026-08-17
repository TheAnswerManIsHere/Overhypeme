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

import { assertIpSaltConfigured } from "../lib/ipSalt.js";

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
 * still pass if the entrypoint never invokes it — the regression where the
 * helper exists, the suite is green, and production boots with the public
 * fallback salt anyway.
 *
 * **Why the wiring is an IMPORT and not a call.** ES module imports are all
 * evaluated before the importing module's first statement runs, so a call at
 * the top of `index.ts` executes *after* every module it imports. That is not
 * theoretical here: in the production bundle `lib/db/src/migrate.ts` is folded
 * into `dist/index.mjs`, where its `process.argv[1] === fileURLToPath(
 * import.meta.url)` CLI guard is TRUE, so it opens a pool during module
 * evaluation. Running the built bundle with an unreachable database proved it —
 * the process died on ECONNREFUSED from `migrate.ts` and never reached a
 * statement-form assertion. So the check lives in `lib/bootChecks.ts`, imported
 * for its side effect ahead of the database-backed graph.
 *
 * These cases pin that arrangement from two directions: the module really does
 * throw at import time (executed), and `index.ts` really does import it early
 * enough (static). Neither alone is sufficient — the first can't see the
 * entrypoint, and the second can't see evaluation semantics.
 *
 * **What is NOT guarded here, stated so nobody reads this block as complete.**
 * These cases pin the *direct* imports of `index.ts` by exact name and
 * position. They say nothing about the graphs beneath them, so the invariant
 * breaks silently if a database reach is ever added inside `./instrument`'s
 * graph, or inside `bootChecks`'s own (`ipSalt` → `node:crypto`, `./env`,
 * `./logger`) — the assertion would still run second and still be too late.
 * Closing that needs a transitive import-graph walk, which is a bigger guard
 * than this fix warranted; the end-to-end bundle run (production env, no salt,
 * unreachable DB → the salt error rather than ECONNREFUSED) is what verifies
 * the graph as it stands today, and it is a manual check, not a test.
 */
describe("boot wiring: the assertion runs before the database graph loads", () => {
  const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
  const source = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );

  /** Module specifiers of `index.ts`'s imports, in declaration order. */
  const importSpecifiers: string[] = source.statements
    .filter(ts.isImportDeclaration)
    .map((s) => (ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : ""));

  describe("bootChecks throws at import time, not at call time", () => {
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

    it("rejects the import in production with no salt", async () => {
      setEnv({ REPLIT_DEPLOYMENT: "1", NODE_ENV: undefined, IP_HASH_SALT: undefined });
      // Cache-busting query so each case gets a fresh module evaluation.
      await assert.rejects(
        () => import(`../lib/bootChecks.js?case=missing-${Date.now()}`),
        /IP_HASH_SALT is required in production/,
      );
    });

    it("resolves the import in production with a usable salt", async () => {
      setEnv({ REPLIT_DEPLOYMENT: "1", NODE_ENV: undefined, IP_HASH_SALT: GOOD_SALT });
      await assert.doesNotReject(() => import(`../lib/bootChecks.js?case=ok-${Date.now()}`));
    });

    it("resolves the import outside production with no salt", async () => {
      setEnv({ REPLIT_DEPLOYMENT: "0", NODE_ENV: "development", IP_HASH_SALT: undefined });
      await assert.doesNotReject(() => import(`../lib/bootChecks.js?case=dev-${Date.now()}`));
    });
  });

  // Both specifiers are compared EXACTLY, everywhere in this block. A substring
  // or regex match is what lets a near-miss module satisfy an invariant it does
  // not actually uphold — `./lib/preinstrument` matches /instrument/, and
  // `./lib/bootChecksLater` contains "bootChecks", so either could sit in the
  // pinned position while the real module loads too late. Names, not patterns.
  const INSTRUMENT = "./instrument";
  const BOOT_CHECKS = "./lib/bootChecks.js";

  describe("index.ts imports it before anything that can reach the database", () => {
    it("imports lib/bootChecks at all", () => {
      assert.ok(
        importSpecifiers.includes(BOOT_CHECKS),
        `index.ts must import "${BOOT_CHECKS}" for its side effect`,
      );
    });

    it("imports it as a bare side-effect import, with no bindings", () => {
      const decl = source.statements
        .filter(ts.isImportDeclaration)
        .find((s) => ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === BOOT_CHECKS);
      assert.ok(decl);
      assert.equal(
        decl.importClause,
        undefined,
        "bootChecks must be imported for its side effect (`import \"./lib/bootChecks.js\"`) — " +
          "importing a binding from it invites someone to 'tidy up' the unused import",
      );
    });

    it("imports it at exactly index 1, with ./instrument at index 0", () => {
      // Both positions are pinned exactly, and neither is interchangeable:
      //
      //  - index 0 MUST be ./instrument. Sentry has to register its hooks
      //    before any other module loads, and bootChecks is not exempt —
      //    it reaches the logger, so Pino's graph would load unpatched.
      //  - index 1 MUST be bootChecks. Everything after it can reach
      //    @workspace/db, whose evaluation opens a pool and, in the bundle,
      //    runs migrations before any statement of index.ts executes.
      //
      // Stated as two exact equalities. Every looser form has a hole: a range
      // ("index 0 or 1") accepts the swapped order, and a substring or regex
      // accepts a near-miss name in the pinned slot while the real module
      // loads later.
      assert.ok(importSpecifiers.length >= 2, "index.ts must have at least two imports");
      assert.equal(
        importSpecifiers[0],
        INSTRUMENT,
        `"${INSTRUMENT}" must be import #0 in index.ts (found "${importSpecifiers[0]}") — ` +
          "Sentry patches modules as they load, so anything ahead of it loads unpatched",
      );
      assert.equal(
        importSpecifiers[1],
        BOOT_CHECKS,
        `"${BOOT_CHECKS}" must be import #1 in index.ts (found "${importSpecifiers[1]}") — ` +
          "any import evaluated before it can reach the database before the salt is checked",
      );
    });
  });
});
