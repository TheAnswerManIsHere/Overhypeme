/**
 * Every quantity the entitlement model depends on, and — more importantly —
 * every RELATIONSHIP between two of them.
 *
 * Individually defensible numbers were not the problem. The defects lived in a
 * *pair*: a lease shorter than the Stripe retrieval phase it must outlive, a
 * waiter that outlived the lease it waits for, an alert that fires before its
 * sweep could have run again. A relationship that holds only because of the
 * current defaults is a defect waiting for an operator to tune one side, so each
 * one is computed and enforced here rather than stated in prose the config route
 * never reads.
 */

import { getConfigFloat, getConfigInt } from "./adminConfig.js";

// ---------------------------------------------------------------------------
// Constants — passed to the SDK and to the apply loop. Not operator-tunable:
// they are the inputs the lease minimum is DERIVED from, so making them editable
// would require validating the inequality from both sides of every one of them.
// ---------------------------------------------------------------------------

/**
 * The pinned SDK defaults are `DEFAULT_TIMEOUT = 80000` with
 * `maxNetworkRetries: 2`, and `stripeClient.ts` overrode neither — so one
 * degraded retrieval could legitimately run 80 seconds, and with retries the
 * worst case was nearer four minutes, against a 60-second lease.
 *
 * The fix is to bound the request, NOT to lengthen the lease. Lengthening it
 * would trade this failure for a longer wedge after a crash and would still lose
 * to a slow-enough day; bounding the request makes the relationship between the
 * two numbers hold by construction rather than by luck.
 */
export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Zero, and that is the only value that makes a request's wall time provable.
 *
 * `timeout` bounds each ATTEMPT, not the call. With any retries enabled,
 * pinned stripe@20's `RequestSender` honours a server-sent integer
 * `Retry-After` of up to **60 seconds** before retrying, so one call could run
 * 10s + 60s + 10s ≈ 80s while an earlier revision here budgeted 22s for it. The
 * sleep is server-directed, so no local constant can bound it — and since the
 * deadline below cannot abort a request already in flight, an unprovable
 * per-request bound makes the phase bound, and the lease floor derived from it,
 * unprovable too.
 *
 * Dropping SDK-level retries costs little that is not already covered a level
 * up: a failed prepare is retried by Stripe's own webhook redelivery, by the
 * caller, or by reconciliation — all of which re-verify from scratch rather
 * than resuming a half-finished phase. Trading a silent in-request retry for a
 * bound we can actually derive from is the right way round.
 */
export const STRIPE_MAX_NETWORK_RETRIES = 0;
/** No retries, so no inter-attempt sleep to allow for. */
export const STRIPE_RETRY_SLEEP_BUDGET_MS = 0;

/**
 * The wall-clock budget for a prepare phase's WHOLE retrieval sequence, not one
 * request.
 *
 * Bounding a single request was necessary and not sufficient. A subscription
 * refresh holds its source lease across `retrieveSubscription`, then
 * `listSubscriptionItems` (up to `MAX_PAGES` pages), then a product lookup per
 * item — and a `past_due` refresh adds `invoices.list`, `invoicePayments.list`
 * and `charges.list` (paginated again) for the grace anchor. Every one of those
 * bounds is a *correctness* bound (see "negative conclusions need complete
 * collections"), deliberately generous; multiplied out they are nowhere near a
 * lease TTL. So the per-request budget was being compared against a phase that
 * could legitimately issue forty of them.
 *
 * A phase-wide deadline is the fix that keeps the module's original stance —
 * bound the work, do not lengthen the lease to cover unbounded work — while
 * making the inequality hold over what the phase ACTUALLY does.
 */
export const RETRIEVAL_PHASE_BUDGET_MS = 45_000;

/** PostgreSQL `lock_timeout` for the apply transaction. Boundable because it holds no network I/O. */
export const APPLY_LOCK_TIMEOUT_MS = 3_000;
export const APPLY_RETRY_ATTEMPTS = 3;
/** Exponential: 100 then 200 between three attempts. */
export const APPLY_RETRY_BACKOFF_MS = 100;

/**
 * Covers what the arithmetic cannot: scheduling jitter, a slow database on the
 * apply, and clock granularity. Named so the reasoning is visible rather than
 * baked into a number.
 */
export const LEASE_BUDGET_MARGIN = 1.5;

/** Sum of the sleeps between `attempts` tries at `baseMs`, doubling each time. */
export function backoffSumMs(baseMs: number, attempts: number): number {
  let total = 0;
  for (let i = 0; i < Math.max(0, attempts - 1); i += 1) total += baseMs * 2 ** i;
  return total;
}

/** Worst-case wall time of ONE bounded Stripe request, including its retry sleep. */
export function singleRequestBudgetMs(): number {
  return (
    STRIPE_REQUEST_TIMEOUT_MS * (1 + STRIPE_MAX_NETWORK_RETRIES) + STRIPE_RETRY_SLEEP_BUDGET_MS
  );
}

/**
 * Worst-case wall time of a whole prepare-phase retrieval, which is what the
 * lease must actually outlive.
 *
 * Equal to the phase budget exactly, with no overrun term, and that is a
 * property of how the deadline is enforced rather than an assumption: a request
 * is issued only while a FULL single-request budget remains (see
 * `RetrievalDeadline.assertCanIssue`). The last `singleRequestBudgetMs()` of the
 * window is therefore deliberately unusable — it is the room the final in-flight
 * request needs to finish inside the budget. Checking merely "is there time
 * left" instead would let a request start with a millisecond to spare and run a
 * further 22s, putting the phase back outside the number the lease is derived
 * from.
 */
export function retrievalBudgetMs(): number {
  return RETRIEVAL_PHASE_BUDGET_MS;
}

/** Raised when a prepare phase's retrieval budget is spent. Always retryable. */
export class RetrievalBudgetExceededError extends Error {
  constructor(label: string, elapsedMs: number) {
    super(
      `retrieval budget of ${RETRIEVAL_PHASE_BUDGET_MS}ms exhausted after ${elapsedMs}ms ` +
        `before "${label}" — abandoning so the lease cannot be outlived`,
    );
    this.name = "RetrievalBudgetExceededError";
  }
}

/**
 * The phase deadline, started when the lease is taken and consulted before every
 * Stripe request the phase makes.
 *
 * Deliberately a wall clock rather than a request counter: what the lease has to
 * outlive is elapsed time, and a count cannot bound that when any individual
 * request may legitimately take twenty seconds.
 */
export interface RetrievalDeadline {
  /**
   * Throws unless a full single-request budget remains. `label` names the call
   * about to be issued, so an exhausted phase says which step it died on.
   */
  assertCanIssue(label: string): void;
  remainingMs(): number;
}

export function startRetrievalDeadline(startedAtMs: number = Date.now()): RetrievalDeadline {
  const elapsed = () => Date.now() - startedAtMs;
  return {
    assertCanIssue(label) {
      if (RETRIEVAL_PHASE_BUDGET_MS - elapsed() < singleRequestBudgetMs()) {
        throw new RetrievalBudgetExceededError(label, elapsed());
      }
    },
    remainingMs: () => Math.max(0, RETRIEVAL_PHASE_BUDGET_MS - elapsed()),
  };
}

/** Worst-case wall time of the apply, including every lock-timeout retry and its backoff. */
export function applyBudgetMs(): number {
  return (
    APPLY_LOCK_TIMEOUT_MS * APPLY_RETRY_ATTEMPTS +
    backoffSumMs(APPLY_RETRY_BACKOFF_MS, APPLY_RETRY_ATTEMPTS)
  );
}

/**
 * The floor `lease_ttl_seconds` may not go below.
 *
 * At the constants above: the retrieval PHASE is capped at 45s (enforced, not
 * assumed — see `retrievalBudgetMs`); apply 3,000 x 3 + 300 = 9.3s; total
 * 54.3s, rounded up to 55; x 1.5 -> 83s.
 *
 * Unchanged by retiring SDK retries: that shrank a single REQUEST's bound from
 * a nominal 22s (in truth unbounded, via `Retry-After`) to a provable 10s, which
 * widens the window in which the phase may still issue but leaves the phase
 * budget — and therefore this floor — exactly where it was.
 *
 * An earlier revision computed this from a SINGLE request's 22s and arrived at
 * 48s. That number was never wrong about one request — it was answering the
 * wrong question, because the phase the lease has to outlive issues many. The
 * floor rose with the honest budget, and the default rose with it; the margin
 * over the floor is unchanged.
 *
 * `admin_config.min_value` for `lease_ttl_seconds` is seeded to this number.
 * A test asserts the two agree, so changing a constant here without re-seeding
 * fails loudly instead of silently rotting.
 */
export function minimumLeaseTtlSeconds(): number {
  const totalMs = retrievalBudgetMs() + applyBudgetMs();
  return Math.ceil(Math.ceil(totalMs / 1000) * LEASE_BUDGET_MARGIN);
}


// ---------------------------------------------------------------------------
// Config keys, defaults, and the relational rules over them.
// ---------------------------------------------------------------------------

export const MEMBERSHIP_CONFIG_DEFAULTS = {
  grace_sweep_interval_seconds: 3600,
  grace_sweep_alert_after_seconds: 21600,
  lease_ttl_seconds: 90,
  lease_waiter_timeout_seconds: 5,
} as const;

export type MembershipConfigKey = keyof typeof MEMBERSHIP_CONFIG_DEFAULTS;

export function isMembershipConfigKey(key: string): key is MembershipConfigKey {
  return Object.prototype.hasOwnProperty.call(MEMBERSHIP_CONFIG_DEFAULTS, key);
}

/** The current values of every membership setting, defaults filled in for absent rows. */
export async function loadMembershipConfig(): Promise<
  Record<MembershipConfigKey, number>
> {
  const entries = await Promise.all(
    (Object.keys(MEMBERSHIP_CONFIG_DEFAULTS) as MembershipConfigKey[]).map(async (key) => {
      const fallback = MEMBERSHIP_CONFIG_DEFAULTS[key];
      const value = Number.isInteger(fallback)
        ? await getConfigInt(key, fallback)
        : await getConfigFloat(key, fallback);
      return [key, value] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<MembershipConfigKey, number>;
}

/**
 * Validate a proposed write against the OTHER settings, not just its own range.
 *
 * Enforced on write of **any** component of a relationship. Enforcing one side
 * only is not enforcing it: an operator could satisfy every individual range and
 * still leave the lease shorter than the retrieval budget, or the waiter longer
 * than the lease it waits for.
 *
 * Returns an error message, or null when the write is admissible.
 */
export function validateMembershipConfigWrite(
  key: MembershipConfigKey,
  proposed: number,
  current: Record<MembershipConfigKey, number>,
): string | null {
  const next = { ...current, [key]: proposed };

  // The lease has to cover the WHOLE operation — the bounded retrieval PHASE
  // (every Stripe request the prepare makes, not one of them), plus every apply
  // attempt and its backoff — with margin.
  const leaseFloor = minimumLeaseTtlSeconds();
  if (next.lease_ttl_seconds < leaseFloor) {
    return (
      `lease_ttl_seconds must be at least ${leaseFloor}s to cover the bounded Stripe ` +
      `retrieval phase (${retrievalBudgetMs()}ms) plus the apply (${applyBudgetMs()}ms) with a ` +
      `${LEASE_BUDGET_MARGIN}x margin`
    );
  }

  // A waiter that outlives the lease it is waiting for is waiting on nothing:
  // by then the lease has expired and the next acquisition steals it anyway.
  if (next.lease_waiter_timeout_seconds >= next.lease_ttl_seconds) {
    return "lease_waiter_timeout_seconds must be less than lease_ttl_seconds";
  }

  // An alert that fires before the sweep has even had a chance to run again
  // reports a healthy system as broken.
  if (next.grace_sweep_alert_after_seconds < next.grace_sweep_interval_seconds) {
    return "grace_sweep_alert_after_seconds must be at least grace_sweep_interval_seconds";
  }

  return null;
}
