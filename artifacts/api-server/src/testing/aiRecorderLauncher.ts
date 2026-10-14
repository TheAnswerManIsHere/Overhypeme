/**
 * Boots the real API server to record the AI baseline (Launch Phase 2,
 * increment 4, #631; design D6). Started only by `scripts/acceptance-run.ts` (record and live modes)
 * with an explicitly constructed environment; never in CI. Refuses, before the
 * application is imported, anything `./aiRecorderGuard.ts` refuses and any
 * database not marked as a test database.
 */
import { testDatabaseRefusal } from "@workspace/db/test-database";

import { recorderLaunchRefusals } from "./aiRecorderGuard";

const databaseRefusal = await testDatabaseRefusal(process.env);
const refusals = [...recorderLaunchRefusals(process.env), ...(databaseRefusal ? [databaseRefusal] : [])];
if (refusals.length > 0) {
  process.stderr.write(`[ai-recorder launcher] refusing to start:\n${refusals.map((r) => `  - ${r}`).join("\n")}\n`);
  process.exit(1);
}

// Only after the refusals: this reaches the database and, through the recorder, the vendors.
await import("../index");
