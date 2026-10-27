/**
 * Read-only inventory of the four excluded row classes for the database at
 * DATABASE_URL (Launch Phase 3, #770; plan §5). Writes nothing — no rows, no
 * files — and prints one JSON report. Run it before any destructive
 * replacement and paste the report onto #770 before proceeding.
 *
 * Live-mode Stripe is read only when STRIPE_SECRET_KEY_LIVE is set, and only
 * after the key's account matches STRIPE_ACCOUNT_ID_LIVE; without either, or on
 * a mismatch, the payment class reports itself incomplete, which the verdict
 * treats as blocking.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/excluded-classes-inventory.ts
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import {
  createLiveStripeReader,
  inventoryExcludedClasses,
  type LiveStripeReader,
} from "../src/lib/excludedClassesInventory";
import { createRawStripeClient, stripeAccountVarFor, stripeSecretVarFor } from "../src/lib/stripeRawClient";

function liveStripeReader(): LiveStripeReader | null {
  const key = process.env[stripeSecretVarFor(true)];
  if (!key) return null;
  const accountVar = stripeAccountVarFor(true);
  return createLiveStripeReader(
    createRawStripeClient(key),
    process.env[accountVar],
    accountVar,
  );
}

const report = await inventoryExcludedClasses(liveStripeReader());
console.log(JSON.stringify(report, null, 2));
process.exit(0);
