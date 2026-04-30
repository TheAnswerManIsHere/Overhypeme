#!/usr/bin/env node
/**
 * Detect circular module dependencies in src/.
 *
 * Madge does not distinguish between static `import` statements and dynamic
 * `import()` expressions when computing cycles. We use a lazy dynamic import
 * in src/lib/email.ts to break the email <-> adminNotify cycle at module-init
 * time (see comments in email.ts), but madge still reports it.
 *
 * This wrapper runs madge, filters out cycles that are explicitly allow-listed
 * below (with reason), and exits non-zero if any *new* cycle appears.
 *
 * To allow a new cycle, you must:
 *   1. Add it to ALLOWED_CYCLES with a written justification.
 *   2. Add an in-source comment at the lazy-import site explaining why it
 *      cannot be statically restructured.
 *   3. Confirm Node does not exit code 13 (unsettled top-level await) at boot.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiServerRoot = path.resolve(__dirname, "..");

/**
 * Each entry is a sorted, comma-joined list of files that participate in the
 * cycle. Sorting makes the comparison order-independent so madge's choice of
 * cycle starting point doesn't matter.
 *
 * Each allowed cycle MUST be paired with a matching `STATIC_IMPORT_BANS` entry
 * below: madge reports cycles by member set, so we must independently verify
 * that the file we expect to use a lazy dynamic import has not regressed to a
 * static import. Without this paired check, a developer could reintroduce a
 * static import and the cycle check would still pass.
 */
const ALLOWED_CYCLES = new Map([
  [
    "lib/adminNotify.ts,lib/email.ts",
    "email.ts uses a lazy dynamic import() of adminNotify to call notifyAdminsOfAbandonedEmail only when an email permanently fails. The static side (adminNotify -> email) is the real direction; the reverse is dynamic and does not deadlock module init.",
  ],
]);

/**
 * Files that must NOT contain a static import of certain modules.
 * { file: relative path under src/, banned: array of import-spec strings }
 *
 * A static `import ... from "<spec>"` (with or without a .js extension) in the
 * named file fails the check. Lazy `await import("...")` calls are allowed.
 */
const STATIC_IMPORT_BANS = [
  {
    file: "lib/email.ts",
    banned: ["./adminNotify", "./adminNotify.js"],
    reason: "Would re-create the email <-> adminNotify init deadlock (Node exit code 13). Use a lazy `await import('./adminNotify')` inside the call site instead — see the comment block at the top of email.ts.",
  },
];

function checkStaticImportBans() {
  const failures = [];
  // Match top-level `import ... from "<spec>"` (single or double quote).
  // Handles default, namespace, and named imports. Ignores dynamic `import(...)`
  // calls because those are function-call expressions, not import declarations.
  const STATIC_IMPORT_RE = /^\s*import(?:\s+[^"';]+\s+from)?\s+["']([^"']+)["']\s*;?\s*$/gm;
  for (const ban of STATIC_IMPORT_BANS) {
    const fullPath = path.join(apiServerRoot, "src", ban.file);
    if (!fs.existsSync(fullPath)) continue;
    const src = fs.readFileSync(fullPath, "utf8");
    for (const match of src.matchAll(STATIC_IMPORT_RE)) {
      const spec = match[1];
      if (ban.banned.includes(spec)) {
        failures.push({ file: ban.file, spec, reason: ban.reason });
      }
    }
  }
  return failures;
}

function normaliseCycle(cycle) {
  return [...cycle].sort().join(",");
}

// 1. Static-import bans run first so even if cycle detection passes via the
//    allow-list, a regressed static import is still caught.
const banFailures = checkStaticImportBans();
if (banFailures.length > 0) {
  console.error(
    `\nFAIL: Found ${banFailures.length} banned static import${banFailures.length === 1 ? "" : "s"}:\n`,
  );
  for (const f of banFailures) {
    console.error(`  ${f.file}: import from "${f.spec}"`);
    console.error(`    ${f.reason}\n`);
  }
  process.exit(1);
}

// 2. Cycle detection via madge.
let raw;
try {
  raw = execSync(
    `npx --no-install madge --extensions ts --circular --json src`,
    { cwd: apiServerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  // madge exits non-zero when cycles are found; its output is on stdout.
  raw = err.stdout?.toString() ?? "";
  if (!raw) {
    console.error("[check-cycles] madge invocation failed:");
    console.error(err.stderr?.toString() ?? err.message);
    process.exit(2);
  }
}

let cycles;
try {
  cycles = JSON.parse(raw);
} catch {
  console.error("[check-cycles] Could not parse madge JSON output:");
  console.error(raw);
  process.exit(2);
}

const unknown = [];
for (const cycle of cycles) {
  const key = normaliseCycle(cycle);
  if (!ALLOWED_CYCLES.has(key)) {
    unknown.push(cycle);
  }
}

if (unknown.length > 0) {
  console.error(
    `\nFAIL: Found ${unknown.length} circular dependenc${unknown.length === 1 ? "y" : "ies"} not on the allow-list:\n`,
  );
  for (const cycle of unknown) {
    console.error(`  ${cycle.join(" -> ")} -> ${cycle[0]}`);
  }
  console.error(
    `\nCircular module imports cause "Detected unsettled top-level await" (Node exit code 13) when esbuild bundles the ESM graph. To fix:`,
  );
  console.error(`  - Convert one direction of the cycle to a lazy 'await import()' inside the call site, OR`);
  console.error(`  - Extract the shared piece into a third module that both sides import, OR`);
  console.error(`  - If neither is feasible, add to ALLOWED_CYCLES in scripts/check-cycles.mjs with a written justification.\n`);
  process.exit(1);
}

if (cycles.length > 0) {
  console.log(
    `[check-cycles] OK: ${cycles.length} known cycle(s) present, all allow-listed.`,
  );
} else {
  console.log(`[check-cycles] OK: no circular dependencies.`);
}
