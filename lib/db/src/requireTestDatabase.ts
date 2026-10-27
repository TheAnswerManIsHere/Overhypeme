/**
 * Exit non-zero unless DATABASE_URL names a marked test database
 * (see testDatabaseMarker.ts). Runs first in api-server's `pretest` (before it
 * migrates) and in the test runners, so the refusal comes before anything is
 * written.
 */
import { pathToFileURL } from "node:url";

import { testDatabaseRefusal } from "./testDatabaseMarker";

async function main(): Promise<void> {
  const refusal = await testDatabaseRefusal(process.env);
  if (refusal) {
    process.stderr.write(`[require-test-db] refusing: ${refusal}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
