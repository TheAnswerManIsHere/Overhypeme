/**
 * Backfill the engine comparison's render times for pictures drawn before
 * migration 0128 recorded them (David, 2026-11-10: "Backfill them please.").
 *
 * Round 1's render run started before PR #906, so its cells have no
 * `submitted_at` / `completed_at`. fal's own request history holds each
 * request's send and end times; they were read through the fal connector into
 * `scripts/data/comparison-round1-fal-timing.json` as
 * `[{ request_id, sent_at, ended_at }]`. This script matches them to cells by
 * `fal_request_id` and fills only cells whose times are still empty, so a
 * second run changes nothing and a cell timed by the app is never overwritten.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-backfill-timing.ts            # dry run: counts only
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-backfill-timing.ts --apply    # writes
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { backfillTimings, parseTimings } from "../src/lib/comparison/backfillTiming.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const file = fileURLToPath(new URL("./data/comparison-round1-fal-timing.json", import.meta.url));
  const timings = parseTimings(JSON.parse(await readFile(file, "utf8")));
  const counts = await backfillTimings(timings, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", rows: timings.length, ...counts }));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
