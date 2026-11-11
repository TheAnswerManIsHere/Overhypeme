/**
 * Backfill what fal actually charged for every engine-comparison picture
 * (David, 2026-11-11: "Please backfill all the generations with the actual
 * costs."). Reads fal's Billing Events API with the read-only key in
 * `FAL_BILLING_API_KEY`, matches by `fal_request_id`, and fills only cells
 * whose bill is still empty, so a second run changes nothing.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-backfill-cost.ts            # dry run: counts only
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-backfill-cost.ts --apply    # writes
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { fileURLToPath } from "node:url";
import { falBillingFetcher, syncBilledCosts } from "../src/lib/comparison/billedCost.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const apiKey = process.env.FAL_BILLING_API_KEY?.trim();
  if (!apiKey) throw new Error("FAL_BILLING_API_KEY is not set");
  const counts = await syncBilledCosts(falBillingFetcher(apiKey), { apply });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
