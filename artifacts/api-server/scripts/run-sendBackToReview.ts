/**
 * One-off script: send an active fact back to review for a versioned
 * enrichment refresh (PR160 UAT helper).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/run-sendBackToReview.ts --fact-id <id>
 */

import process from "node:process";

import { sendFactBackToReview } from "../src/lib/sendBackToReview.js";

const args = process.argv.slice(2);
const factIdArg = args
  .find((a) => a.startsWith("--fact-id="))
  ?.split("=")[1];

if (!factIdArg) {
  console.error("Usage: tsx scripts/run-sendBackToReview.ts --fact-id=<id>");
  process.exit(1);
}

const factId = Number.parseInt(factIdArg, 10);
if (!Number.isFinite(factId) || factId <= 0) {
  console.error(`Invalid fact-id: ${factIdArg}`);
  process.exit(1);
}

const result = await sendFactBackToReview({ factId, adminId: null });
console.log(JSON.stringify(result, null, 2));
