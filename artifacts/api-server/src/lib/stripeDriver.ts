/**
 * The Stripe driver seam (#566, plan `docs/plans/PLAN_STRIPE_FAKE.md`).
 *
 * Exactly two things sit below this seam, and nothing else in the app does
 * either of them:
 *
 *   1. reading a Stripe credential or the account id declared for one, and
 *   2. constructing a Stripe SDK client or a `StripeSync`.
 *
 * Everything that decides whether a credential may be used — mode capture, the
 * throttle, account verification, invalidation, the boot state machine — stays
 * ABOVE it, one copy, and runs unchanged whichever driver is active. That is
 * what lets the real driver be today's code moved rather than rewritten, and
 * what keeps #571's guarantees from depending on which driver is selected.
 *
 * The inventory that fixed this boundary (plan, *Preflight*, O1–O3) was run on
 * the tracked set: every Stripe credential read and every construction lived in
 * `stripeClient.ts`, `stripeAccountGuard.ts`, `stripeRawClient.ts`, `index.ts`
 * and `routes/admin.ts`. They now reach Stripe only through `stripeDriver()`.
 */
import type { StripeDriver } from "./stripeDriverTypes.js";
import { realStripeDriver } from "./stripeRealDriver.js";

export type * from "./stripeDriverTypes.js";

let override: StripeDriver | null = null;

/** The active driver. */
export function stripeDriver(): StripeDriver {
  return override ?? realStripeDriver;
}

/** Test seam. Returns a restore function. */
export function __setStripeDriverForTests(driver: StripeDriver): () => void {
  const previous = override;
  override = driver;
  return () => {
    override = previous;
  };
}
