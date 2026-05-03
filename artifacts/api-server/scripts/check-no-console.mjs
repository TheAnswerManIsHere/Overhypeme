#!/usr/bin/env node
/**
 * Fail the build if any production source file under src/ uses raw console.*
 * for logging. All server logs must route through the safe pino-based logger
 * in src/lib/logger.ts so that:
 *   - log lines are structured JSON in production
 *   - stdio errors (EIO/EPIPE on torn-down pipes) cannot crash the process
 *   - sensitive fields are scrubbed via the redact rules in logger.ts
 *
 * Allowlisted call sites are tracked explicitly below with a justification.
 * Tests under src/__tests__/** are exempt because they intentionally stub
 * console.* to capture diagnostic output.
 *
 * Scripts under scripts/*.ts are NOT covered by this check — they are CLI
 * tools and are expected to write to stdout. They MUST import the stdio
 * guard at the top so a torn-down pipe cannot crash them either; that is
 * verified separately at review time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiServerRoot = path.resolve(__dirname, "..");
const SRC_DIR = path.join(apiServerRoot, "src");

/**
 * Each entry pins a known, intentional console.* usage to a specific file
 * and 1-indexed line number. The check fails if the call moves, disappears,
 * or a new console.* call appears that is not on this list. To add a new
 * entry, also leave a code comment at the call site explaining why the
 * pino logger cannot be used.
 */
const ALLOWED = [
  {
    file: "src/lib/email.ts",
    line: 158,
    reason:
      "Last-resort console.error inside the Resend 401 fallback path: the " +
      "logger pipeline itself may be the failing component, and we still " +
      "want a record of an unauthorized email-provider response surfacing " +
      "in workflow logs.",
  },
  {
    file: "src/lib/email.ts",
    line: 171,
    reason:
      "Same Resend permanent-failure path as above — duplicated to cover " +
      "the catch-all final delivery attempt.",
  },
  {
    file: "src/instrument.ts",
    line: 64,
    reason:
      "Sentry preload runs before src/lib/logger.ts is initialized. The " +
      "single 'SENTRY_DSN_BACKEND not set' notice must use console.log so " +
      "we never get into a circular init dependency with the logger.",
  },
];

const CALL_RE = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const allowedKey = (file, line) => `${file}:${line}`;
const allowedSet = new Set(ALLOWED.map((a) => allowedKey(a.file, a.line)));
const allowedSeen = new Set();

const violations = [];
for (const fullPath of listTsFiles(SRC_DIR)) {
  const rel = path.relative(apiServerRoot, fullPath);
  const src = fs.readFileSync(fullPath, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    CALL_RE.lastIndex = 0;
    if (!CALL_RE.test(line)) continue;
    const lineNo = i + 1;
    const key = allowedKey(rel, lineNo);
    if (allowedSet.has(key)) {
      allowedSeen.add(key);
      continue;
    }
    violations.push({ file: rel, line: lineNo, snippet: line.trim() });
  }
}

const stale = [...allowedSet].filter((k) => !allowedSeen.has(k));

if (violations.length > 0) {
  console.error(
    `\nFAIL: Found ${violations.length} disallowed console.* call${violations.length === 1 ? "" : "s"} in src/:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    "\nAll server logs must use the pino logger from src/lib/logger.ts.\n" +
    "Replace console.log → logger.info, console.warn → logger.warn,\n" +
    "console.error → logger.error({ err }, 'message'). If the call MUST\n" +
    "stay on console.* (e.g. it runs before the logger is initialized),\n" +
    "add it to the ALLOWED list in scripts/check-no-console.mjs with a\n" +
    "written justification AND leave a comment at the call site.\n",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    `\nFAIL: ${stale.length} allowlisted console.* entr${stale.length === 1 ? "y is" : "ies are"} stale ` +
    `(no console.* call on the listed line). Update scripts/check-no-console.mjs:\n`,
  );
  for (const k of stale) {
    console.error(`  ${k}`);
  }
  process.exit(1);
}

console.log(
  `[check-no-console] OK: no disallowed console.* calls in src/ (${ALLOWED.length} allowlisted entries verified).`,
);
