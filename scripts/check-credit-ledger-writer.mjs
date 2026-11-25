#!/usr/bin/env node
/**
 * Credits have one writer in application code.
 * ────────────────────────────────────────────────────────────────────────────
 * Launch Phase 7, plan PLAN_PHASE7_IMAGE_OFFERING.md §1: a member's balance is
 * derived from `credit_ledger`, and every change to it goes through
 * `artifacts/api-server/src/lib/credits/` — the way `membership_tier` has one
 * writer. A second place that inserts rows would be a second, unreviewed
 * definition of when credits are granted, spent or returned.
 *
 * This refuses any non-test source file outside that directory that names the
 * ledger in a write: `creditLedgerTable` passed to insert/update/delete, or the
 * table's SQL name after INSERT INTO / UPDATE / DELETE FROM. Reads are free.
 * The database's own writers (migration 0171's free-credit trigger and
 * backfill) live in migrations, which this does not scan.
 *
 * Limits, stated so a pass is not read as more: it reads text, so a write built
 * from a variable holding the table, or SQL assembled from pieces, is
 * invisible to it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN = ["artifacts/api-server/src", "artifacts/api-server/scripts", "lib"];
const ALLOWED_DIR = ["artifacts", "api-server", "src", "lib", "credits"].join(sep) + sep;
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "migrations", "generated"]);

const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*creditLedgerTable\b/;
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?credit_ledger"?\b/i;

export function findWrites(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (DRIZZLE_WRITE.test(line) || SQL_WRITE.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs|js)$/.test(name)) yield full;
  }
}

function main() {
  const violations = [];
  for (const base of SCAN) {
    for (const file of walk(join(ROOT, base))) {
      const rel = relative(ROOT, file);
      if (rel.startsWith(ALLOWED_DIR)) continue;
      for (const hit of findWrites(readFileSync(file, "utf8"))) violations.push(`${rel}:${hit.line}: ${hit.text}`);
    }
  }
  if (violations.length > 0) {
    console.error("credit_ledger is written outside artifacts/api-server/src/lib/credits/:\n" + violations.map((v) => "  " + v).join("\n"));
    console.error("Move the write into lib/credits/ (plan PLAN_PHASE7_IMAGE_OFFERING.md §1: one writer).");
    process.exit(1);
  }
  console.log("credit_ledger has one writer: lib/credits/.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
