/**
 * Load the committed legacy fixture into the database DATABASE_URL names
 * (Launch Phase 2, increment 5; #631; plan D7).
 *
 *   STORAGE_BACKEND=local-double STORAGE_DOUBLE_DIR=/tmp/overhype-storage \
 *   PRIVATE_OBJECT_DIR=/e2e-bucket/private PUBLIC_OBJECT_SEARCH_PATHS=/e2e-bucket/public \
 *   DATABASE_URL=<a fresh, marked test database> \
 *     pnpm exec tsx scripts/load-legacy-fixture.ts [--fixture fixtures/legacy]
 *
 * Order: schema push → migrations → this → `seed-e2e-test-accounts.ts` → boot.
 *
 * Refuses, before anything that reaches the database is imported: an
 * unmarked database, a production environment, and any storage backend but
 * the local double (the placeholders are written through it).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabaseRefusal } from "@workspace/db/test-database";

import { isProductionEnv } from "../src/lib/env";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--fixture");
const fixtureDir = path.resolve(i >= 0 ? process.argv[i + 1]! : path.join(HERE, "..", "fixtures", "legacy"));

// The environment's refusals come first, so a refused process never opens a connection; only then the marker read.
const refusals = [
  ...(isProductionEnv() ? ["this is a production environment (NODE_ENV=production or REPLIT_DEPLOYMENT=1)"] : []),
  ...(process.env.STORAGE_BACKEND !== "local-double" ? ["STORAGE_BACKEND must be local-double: the media placeholders are written through it"] : []),
];
if (!refusals.length) {
  const databaseRefusal = await testDatabaseRefusal(process.env);
  if (databaseRefusal) refusals.push(databaseRefusal);
}
if (refusals.length) {
  console.error(`[load-legacy-fixture] refusing to load:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(1);
}

const { loadLegacyFixture } = await import("../src/testing/legacyFixture/load");
const report = await loadLegacyFixture(fixtureDir, process.env.DATABASE_URL!);
console.log(`[load-legacy-fixture] loaded ${Object.values(report.rowCounts).reduce((a, b) => a + b, 0)} rows into ${Object.keys(report.rowCounts).length} tables`);
console.log("  row counts:", JSON.stringify(report.rowCounts));
console.log("  media placeholders written:", report.placeholdersWritten);
console.log(`  migrations: fixture taken at ${report.migrationHeads.fixture}, this code has ${report.migrationHeads.code}`);
if (report.predicateProblems.length) {
  console.error(`[load-legacy-fixture] the freshness readers answer differently on the fixture:\n${report.predicateProblems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("  freshness predicates: every recorded outcome restored and re-checked");
process.exit(0);
