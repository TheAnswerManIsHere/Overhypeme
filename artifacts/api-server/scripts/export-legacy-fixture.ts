/**
 * Export the legacy fixture from the database DATABASE_URL names (Launch
 * Phase 2, increment 5; #631; plan `docs/plans/PLAN_PHASE2_INC5_LEGACY_FIXTURE.md`, D6).
 *
 * Run on the Repl against the development database, never in CI:
 *
 *   pnpm exec tsx scripts/export-legacy-fixture.ts --dry-run
 *   pnpm exec tsx scripts/export-legacy-fixture.ts --out /tmp/legacy-fixture
 *
 * `--dry-run` runs every transformer and check and prints only what would stop
 * the export (table, column, row id and path) and the shapes of the media
 * references it saw (digits and ids collapsed) — never a value.
 *
 * Refuses a production environment, a non-empty `--out`, and an `--out` under
 * the repository (the fixture is reviewed before it is committed). Every
 * connection this process opens is read-only: PGOPTIONS is set before any
 * database module loads, and the export reads inside one READ ONLY
 * transaction.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");
const out = arg("--out");

const refusals: string[] = [];
if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production") refusals.push("never in a production environment");
if (!process.env.DATABASE_URL) refusals.push("DATABASE_URL must name the source database");
if (!dryRun && !out) refusals.push("pass --out <empty directory outside the repository>, or --dry-run");
if (out) {
  const abs = path.resolve(out);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + path.sep)) refusals.push("--out must be outside the repository: the fixture is reviewed before it is committed");
  if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) refusals.push("--out must be empty");
}
if (refusals.length) {
  console.error(`[export-legacy-fixture] refusing:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(1);
}

// Every connection — the export's own and the app's pool the predicate pass uses — is read-only.
process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on`.trim();

const sourceCommit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const { runExport, writeFixture } = await import("../src/testing/legacyFixture/export");
const { evaluatePredicates } = await import("../src/testing/legacyFixture/predicates");

const result = await runExport({ sourceUrl: process.env.DATABASE_URL!, sourceCommit, evaluatePredicates });

if (dryRun) {
  console.log(`[export-legacy-fixture] dry run at ${sourceCommit}`);
  console.log(`  stops: ${result.stops.length}`);
  for (const s of result.stops) console.log(`    - ${s}`);
  console.log("  media reference shapes:");
  for (const [k, n] of Object.entries(result.mediaPatterns).sort()) console.log(`    ${n}× ${k}`);
  if (result.manifest) {
    console.log("  row counts:", JSON.stringify(result.manifest.rowCounts));
    console.log("  excluded by predicate:", JSON.stringify(result.manifest.excludedByPredicate));
    console.log("  predicate outcomes:", JSON.stringify(result.manifest.predicateCounts));
    console.log("  checks:", JSON.stringify(result.manifest.checks));
  }
  process.exit(result.stops.length ? 1 : 0);
}

if (result.stops.length) {
  console.error(`[export-legacy-fixture] the export stopped; nothing was written:\n${result.stops.map((s) => `  - ${s}`).join("\n")}`);
  process.exit(1);
}
writeFixture(result, path.resolve(out!));
const m = result.manifest;
console.log(`[export-legacy-fixture] wrote ${Object.keys(m.rowCounts).length} tables to ${path.resolve(out!)}`);
console.log("  row counts:", JSON.stringify(m.rowCounts));
console.log("  excluded by predicate:", JSON.stringify(m.excludedByPredicate));
console.log("  kept fact texts:", m.keptFactTexts, " placeholder fact texts:", m.placeholderFactTexts);
console.log("  embedding-backfill predicate on the source:", m.embeddingBackfillPredicateCount);
console.log("  media placeholders:", m.placeholders.length, " legacy meme images:", m.legacyMemeImages.length);
console.log("  predicate outcomes:", JSON.stringify(m.predicateCounts));
console.log("  checks:", JSON.stringify(m.checks));
process.exit(0);
