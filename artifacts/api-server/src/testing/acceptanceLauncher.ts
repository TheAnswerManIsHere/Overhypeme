/**
 * Boots the real API server for an acceptance or replay run (Launch Phase 2,
 * increment 6, #631; plan D1, D3). Started only by `scripts/acceptance-run.ts`
 * with a constructed environment. Refuses, before the application is
 * imported, anything `./acceptanceGuard.ts` refuses and any database not
 * marked as a test database.
 */
import { testDatabaseRefusal } from "@workspace/db/test-database";

import { acceptanceLaunchRefusals } from "./acceptanceGuard";

const databaseRefusal = await testDatabaseRefusal(process.env);
const refusals = [...acceptanceLaunchRefusals(process.env), ...(databaseRefusal ? [databaseRefusal] : [])];
if (refusals.length > 0) {
  process.stderr.write(`[acceptance launcher] refusing to start:\n${refusals.map((r) => `  - ${r}`).join("\n")}\n`);
  process.exit(1);
}

// Only after the refusals: this reaches the database and the application.
await import("../index");
