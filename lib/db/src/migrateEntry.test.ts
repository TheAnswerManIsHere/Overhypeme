/**
 * The migration runner's module must have no top-level side effect (#486).
 *
 * migrate.ts used to end with the usual "am I the entry point?" block:
 * `if (process.argv[1] === fileURLToPath(import.meta.url)) { …migrate… }`.
 * esbuild folds migrate.ts into the api-server's production bundle, where
 * `import.meta.url` is the bundle and `process.argv[1]` is the bundle too —
 * so the guard held, and every production boot ran the migrations once
 * during module evaluation (outside the startup sequence, exiting the
 * process on failure) and again from `runMigrations()` in index.ts.
 *
 * Running migrate.ts itself as the entry point is the same condition the
 * bundle creates: the file that holds the runner is the file node was
 * started with. So the regression test is that doing so does nothing, while
 * the command-line runner (migrate-cli.ts, what `pnpm run migrate` invokes)
 * still migrates.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATE_MODULE = fileURLToPath(new URL("./migrate.ts", import.meta.url));
const MIGRATE_CLI = fileURLToPath(new URL("./migrate-cli.ts", import.meta.url));

function runAsEntry(file: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", file], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("migration runner entry points (#486)", () => {
  it("migrate.ts does nothing when it is the entry point, as it is inside the bundle", () => {
    // An unreachable database: before the fix, the folded block tried to
    // connect and exited 1 with ECONNREFUSED, as the production bundle did.
    const result = runAsEntry(MIGRATE_MODULE, {
      ...process.env,
      DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
    });
    assert.equal(result.status, 0, `expected a clean exit, got ${result.status}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /\[migrate\]|ECONNREFUSED|DATABASE_URL/);
  });

  it("migrate-cli.ts refuses to run without DATABASE_URL", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = runAsEntry(MIGRATE_CLI, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL is not set/);
  });

  it("migrate-cli.ts still applies migrations against the test database", { skip: !process.env.DATABASE_URL }, () => {
    const result = runAsEntry(MIGRATE_CLI, process.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[migrate\] Done: \d+ applied, \d+ already up-to-date/);
  });
});
