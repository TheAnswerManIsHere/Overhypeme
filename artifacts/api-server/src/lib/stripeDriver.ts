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
import { selectedBackend } from "./doubleSelection.js";
import type { StripeDriver } from "./stripeDriverTypes.js";
import { fakeStripeDriver } from "./stripeFakeDriver.js";
import { realStripeDriver } from "./stripeRealDriver.js";

export type * from "./stripeDriverTypes.js";

let override: StripeDriver | null = null;
let selected: StripeDriver | null = null;

/**
 * The active driver, chosen once per process from `STRIPE_BACKEND` through the
 * one selection rule every double shares (`doubleSelection.ts`): unset or
 * `stripe` is the real driver, `fake-double` the fake, anything else refuses —
 * and a production boot, or a fake beside a real credential, refuses too.
 * `bootChecks.ts` applies the same refusals before any module loads; this
 * re-applies them at the point of use for code that never booted the server.
 */
export function stripeDriver(): StripeDriver {
  if (override) return override;
  selected ??= selectedBackend("STRIPE_BACKEND") === "fake-double" ? fakeStripeDriver : realStripeDriver;
  return selected;
}

/** Test seam. Returns a restore function. */
export function __setStripeDriverForTests(driver: StripeDriver): () => void {
  const previous = override;
  override = driver;
  return () => {
    override = previous;
  };
}
