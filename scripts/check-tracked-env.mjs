#!/usr/bin/env node
/**
 * Tracked `.env*` files may hold only values that are public anyway
 * (launch Phase 15, increment 4).
 * ────────────────────────────────────────────────────────────────────────────
 * One `.env*` file is tracked: `artifacts/overhype-me/.env.local`, the web
 * app's build-time values. Vite exposes a variable to the browser bundle only
 * when its name carries the `VITE_` prefix (the web app sets no `envPrefix`),
 * so a `VITE_` value ships in the public JavaScript whatever this repository
 * does with it. That is the rule this guard holds:
 *
 *   1. Only the files on TRACKED_ENV_FILES may be tracked. A new tracked
 *      `.env*` file anywhere fails.
 *   2. Every key in a tracked file must be a `VITE_` name. Any other name
 *      (a server key, a token, a password) fails, because nothing about it is
 *      public by construction.
 *
 * It reports a failure by FILE AND LINE NUMBER ONLY, never the key or the
 * value: the line it refuses is, by hypothesis, something that should not be
 * printed into a CI log.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TRACKED_ENV_FILES = new Set(["artifacts/overhype-me/.env.local"]);
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const PUBLIC_NAME = /^VITE_[A-Z0-9_]+$/;

/** The tracked paths that are `.env` files. */
export function envFiles(paths) {
  return paths.filter((p) => ENV_FILE.test(p));
}

/**
 * Line numbers (1-based) whose key is not a public `VITE_` name. Blank lines and
 * `#` comments are ignored; `export KEY=…` is read as `KEY`. A line that is not
 * `KEY=…` at all is refused too: the guard does not guess what it means.
 */
export function nonPublicLines(content) {
  const bad = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !PUBLIC_NAME.test(m[1])) bad.push(i + 1);
  });
  return bad;
}

function main() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const failures = [];
  for (const file of envFiles(tracked)) {
    if (!TRACKED_ENV_FILES.has(file)) {
      failures.push(`${file}: a tracked .env file that is not on the allowlist (scripts/check-tracked-env.mjs). Untrack it, and keep its values in environment settings.`);
      continue;
    }
    const lines = nonPublicLines(readFileSync(resolve(ROOT, file), "utf8"));
    if (lines.length > 0) {
      failures.push(`${file}: line(s) ${lines.join(", ")} set a name that is not a public VITE_ build value. Move it to environment settings (and rotate it if it was ever a secret).`);
    }
  }
  if (failures.length > 0) {
    console.error("check:tracked-env FAILED:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`check:tracked-env: ${envFiles(tracked).length} tracked .env file(s), every key a public VITE_ build value.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
