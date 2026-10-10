/**
 * Exit non-zero unless DATABASE_URL names a marked test database
 * (see testDatabaseMarker.ts). Runs before `push-force` and the api-server test
 * runners, so the refusal comes before anything destructive.
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
