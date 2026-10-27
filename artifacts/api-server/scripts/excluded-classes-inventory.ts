/**
 * Read-only inventory of the four excluded row classes for the database at
 * DATABASE_URL (Launch Phase 3, #770; plan §5). Writes nothing — no rows, no
 * files — and prints one JSON report. Run it before any destructive
 * replacement and paste the report onto #770 before proceeding.
 *
 * Live-mode Stripe is read only when STRIPE_SECRET_KEY_LIVE is set; without
 * it the payment class reports itself incomplete, which the verdict treats as
 * blocking.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/excluded-classes-inventory.ts
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import {
  inventoryExcludedClasses,
  OBLIGATING_SUBSCRIPTION_STATUSES,
  type LiveStripeReader,
} from "../src/lib/excludedClassesInventory";
import { createRawStripeClient, stripeSecretVarFor } from "../src/lib/stripeRawClient";

function liveStripeReader(): LiveStripeReader | null {
  const key = process.env[stripeSecretVarFor(true)];
  if (!key) return null;
  const stripe = createRawStripeClient(key);
  return async () => {
    const obligating = new Set<string>(OBLIGATING_SUBSCRIPTION_STATUSES);
    const counts: Record<string, number> = {};
    for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
      if (obligating.has(sub.status)) counts[sub.status] = (counts[sub.status] ?? 0) + 1;
    }
    return { obligatingSubscriptions: counts };
  };
}

const report = await inventoryExcludedClasses(liveStripeReader());
console.log(JSON.stringify(report, null, 2));
process.exit(0);
