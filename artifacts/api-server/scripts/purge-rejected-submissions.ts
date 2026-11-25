/**
 * The one-time purge of submissions rejected before Issue #1304's increment A
 * (plan docs/plans/PLAN_RENDER_HISTORY.md D7; David, Q52, 2026-11-25). Each
 * rejected submission's never-approved staging fact goes, with its renders,
 * gags, readings and taxonomy runs, and its picture files go onto the durable
 * cleanup list; the rejection the submitter sees in their Library stays.
 * Submissions rejected from this release on are purged by Reject itself.
 *
 * Run (on the Repl, dev then production at the publish that carries it):
 *   pnpm --filter @workspace/api-server exec tsx scripts/purge-rejected-submissions.ts            # dry run: counts only, deletes nothing
 *   pnpm --filter @workspace/api-server exec tsx scripts/purge-rejected-submissions.ts --apply    # purges, and prints the same counts
 *
 * A second --apply finds nothing to purge. Files left on the cleanup list are
 * retried by the hourly sweep and shown on Queue Health.
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { fileURLToPath } from "node:url";
import { runRejectedSubmissionPurge } from "../src/lib/rejectedSubmissionPurge.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const counts = await runRejectedSubmissionPurge({ apply });
  console.log(JSON.stringify(counts));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
