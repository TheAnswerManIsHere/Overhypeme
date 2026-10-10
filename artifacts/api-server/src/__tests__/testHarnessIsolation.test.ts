/**
 * The email test-harness substitution must have no path from the deployment
 * entrypoint.
 *
 * Phase 2 keeps two mechanisms apart: a deployment-selectable double is chosen
 * by configuration and refuses a production boot, while the email transport
 * replacement is not selectable at all — it exists only because
 * `src/testing/productionModeLauncher.ts` imports the app and installs it.
 * That guarantee is structural, so it is checked structurally: no module
 * outside `src/testing/` may import from it, and only the launcher may call the
 * installer. `index.ts` is the esbuild entry, so nothing it can reach includes
 * the launcher.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: fs.readFileSync(full, "utf8"),
}));

describe("test-harness isolation", () => {
  it("no module outside src/testing imports from it", () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith("testing/"))
      .filter((f) => /from\s+["'][^"']*\/testing\/|import\(\s*["'][^"']*\/testing\//.test(f.text))
      .map((f) => f.rel);
    assert.deepEqual(offenders, []);
  });

  it("only the launcher calls the email transport installer", () => {
    const callers = files
      .filter((f) => f.text.includes("installEmailTransportForTestHarness"))
      .map((f) => f.rel)
      .sort();
    assert.deepEqual(callers, ["lib/email.ts", "testing/productionModeLauncher.ts"]);
  });

  it("the deployment build has a single entry, index.ts", () => {
    const build = fs.readFileSync(path.resolve(SRC, "../build.mjs"), "utf8");
    const entries = build.match(/entryPoints:\s*\[([^\]]*)\]/);
    assert.ok(entries, "build.mjs declares entryPoints");
    assert.match(entries[1], /src\/index\.ts/);
    assert.doesNotMatch(entries[1], /testing/);
  });
});
