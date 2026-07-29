/**
 * Every quantity the entitlement model depends on, and — more importantly —
 * every RELATIONSHIP between two of them.
 *
 * Individually defensible numbers were not the problem. Three separate defects
 * lived in a *pair*: a lease shorter than the Stripe request it must outlive, a
 * run-lease TTL shorter than the heartbeat inside it, and a fractional downgrade
 * bound that fought the absolute cap below a certain cohort size. A relationship
 * that holds only because of the current defaults is a defect waiting for an
 * operator to tune one side, so each one is computed and enforced here rather
 * than stated in prose the config route never reads.
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
export const STRIPE_MAX_NETWORK_RETRIES = 1;
/** Allowance for the SDK's sleep BETWEEN attempts, which the request timeout does not cover. */
export const STRIPE_RETRY_SLEEP_BUDGET_MS = 2_000;

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

/**
 * One interval to send the beat, one to tolerate a MISSED beat, one for
 * scheduling jitter (GC pause, container throttle, a busy event loop).
 */
export const RUN_LEASE_HEARTBEAT_MULTIPLE = 3;

/** Sum of the sleeps between `attempts` tries at `baseMs`, doubling each time. */
export function backoffSumMs(baseMs: number, attempts: number): number {
  let total = 0;
  for (let i = 0; i < Math.max(0, attempts - 1); i += 1) total += baseMs * 2 ** i;
  return total;
}

/** Worst-case wall time of one bounded Stripe retrieval, including retry sleeps. */
export function retrievalBudgetMs(): number {
  return (
    STRIPE_REQUEST_TIMEOUT_MS * (1 + STRIPE_MAX_NETWORK_RETRIES) + STRIPE_RETRY_SLEEP_BUDGET_MS
  );
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
 * At the constants above: retrieval 10,000 x 2 + 2,000 = 22s; apply 3,000 x 3 +
 * 300 = 9.3s; total 31.3s; x 1.5 -> 48s. The 60s default clears it, but only
 * just — which is the finding, since an earlier revision called 60s
 * "comfortable" against a budget nobody had added up.
 *
 * `admin_config.min_value` for `lease_ttl_seconds` is seeded to this number.
 * A test asserts the two agree, so changing a constant here without re-seeding
 * fails loudly instead of silently rotting.
 */
export function minimumLeaseTtlSeconds(): number {
  const totalMs = retrievalBudgetMs() + applyBudgetMs();
  return Math.ceil(Math.ceil(totalMs / 1000) * LEASE_BUDGET_MARGIN);
}

/** The floor `reconcile_run_lease_ttl_seconds` may not go below, given a heartbeat interval. */
export function minimumRunLeaseTtlSeconds(heartbeatIntervalSeconds: number): number {
  return heartbeatIntervalSeconds * RUN_LEASE_HEARTBEAT_MULTIPLE;
}

// ---------------------------------------------------------------------------
// Config keys, defaults, and the relational rules over them.
// ---------------------------------------------------------------------------

export const MEMBERSHIP_CONFIG_DEFAULTS = {
  grace_sweep_interval_seconds: 3600,
  grace_sweep_alert_after_seconds: 21600,
  reconcile_interval_seconds: 21600,
  lease_ttl_seconds: 60,
  lease_waiter_timeout_seconds: 5,
  reconcile_run_lease_ttl_seconds: 120,
  reconcile_heartbeat_interval_seconds: 30,
  reconcile_max_downgrades_per_run: 50,
  reconcile_max_downgrade_fraction: 0.05,
  reconcile_min_downgrade_allowance: 3,
  reconcile_max_ambiguous_per_run: 25,
  reconcile_max_errors_per_run: 10,
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
 * still leave the lease shorter than the request budget, or the run TTL shorter
 * than the heartbeat inside it.
 *
 * Returns an error message, or null when the write is admissible.
 */
export function validateMembershipConfigWrite(
  key: MembershipConfigKey,
  proposed: number,
  current: Record<MembershipConfigKey, number>,
): string | null {
  const next = { ...current, [key]: proposed };

  // The fraction's lower bound is STRICT, which `admin_config.min_value` cannot
  // express — it is an integer column, so the closest it gets is >= 0.
  if (next.reconcile_max_downgrade_fraction <= 0 || next.reconcile_max_downgrade_fraction > 1) {
    return "reconcile_max_downgrade_fraction must be greater than 0 and at most 1";
  }

  // Below 1 there is no allowance at all and an isolated repair becomes
  // impossible at every cohort size; above the absolute cap the two bounds
  // contradict each other.
  if (next.reconcile_min_downgrade_allowance < 1) {
    return "reconcile_min_downgrade_allowance must be at least 1";
  }
  if (next.reconcile_min_downgrade_allowance > next.reconcile_max_downgrades_per_run) {
    return (
      "reconcile_min_downgrade_allowance must not exceed reconcile_max_downgrades_per_run " +
      `(${next.reconcile_max_downgrades_per_run})`
    );
  }

  // The lease has to cover the WHOLE operation — the bounded retrieval including
  // its retry sleep, plus every apply attempt and its backoff — with margin.
  const leaseFloor = minimumLeaseTtlSeconds();
  if (next.lease_ttl_seconds < leaseFloor) {
    return (
      `lease_ttl_seconds must be at least ${leaseFloor}s to cover the bounded Stripe ` +
      `retrieval (${retrievalBudgetMs()}ms) plus the apply (${applyBudgetMs()}ms) with a ` +
      `${LEASE_BUDGET_MARGIN}x margin`
    );
  }

  // A waiter that outlives the lease it is waiting for is waiting on nothing:
  // by then the lease has expired and the next acquisition steals it anyway.
  if (next.lease_waiter_timeout_seconds >= next.lease_ttl_seconds) {
    return "lease_waiter_timeout_seconds must be less than lease_ttl_seconds";
  }

  // Below three heartbeat intervals the run lease expires before its first
  // renewal, or leaves no room for a missed beat — which is the entire property
  // the heartbeat exists to provide.
  const runLeaseFloor = minimumRunLeaseTtlSeconds(next.reconcile_heartbeat_interval_seconds);
  if (next.reconcile_run_lease_ttl_seconds < runLeaseFloor) {
    return (
      `reconcile_run_lease_ttl_seconds must be at least ${runLeaseFloor}s — ` +
      `${RUN_LEASE_HEARTBEAT_MULTIPLE}x reconcile_heartbeat_interval_seconds ` +
      `(${next.reconcile_heartbeat_interval_seconds}s): one interval to send the beat, ` +
      "one to tolerate a missed beat, one for scheduling jitter"
    );
  }

  // An alert that fires before the sweep has even had a chance to run again
  // reports a healthy system as broken.
  if (next.grace_sweep_alert_after_seconds < next.grace_sweep_interval_seconds) {
    return "grace_sweep_alert_after_seconds must be at least grace_sweep_interval_seconds";
  }

  return null;
}

/**
 * The monotone downgrade allowance.
 *
 *   allowed = min(max_downgrades_per_run, max(min_allowance, floor(fraction x cohort)))
 *
 * `cohort` is the **currently qualifying population** — not users examined.
 * Measured against examined, a run over 10,000 users of whom only 40 are members
 * could revoke all forty and pass both bounds: 40 is under 50, and 0.4% is under
 * 5%. A complete wipeout of the membership. The fraction has to be of the thing
 * being protected.
 *
 * Monotone in cohort size, which is what makes it a rule rather than a fourth
 * patch: `allowed` never decreases as the cohort grows, so there is no size at
 * which the guard suddenly tightens. It admits an isolated repair at every
 * cohort size including one, and never admits a wipeout of any cohort larger
 * than the allowance.
 *
 *   cohort      1 -> allowed 3   (all staged proceeds — the cohort IS one user)
 *   cohort     19 -> allowed 3   (all staged aborts)
 *   cohort    100 -> allowed 5   (all staged aborts)
 *   cohort 10,000 -> allowed 50  (capped; all staged aborts)
 */
export function allowedDowngrades(
  cohort: number,
  config: Pick<
    Record<MembershipConfigKey, number>,
    | "reconcile_max_downgrades_per_run"
    | "reconcile_max_downgrade_fraction"
    | "reconcile_min_downgrade_allowance"
  >,
): number {
  const fromFraction = Math.floor(config.reconcile_max_downgrade_fraction * cohort);
  return Math.min(
    config.reconcile_max_downgrades_per_run,
    Math.max(config.reconcile_min_downgrade_allowance, fromFraction),
  );
}

/**
 * `max` is literal: a bound trips when the count EXCEEDS it, so 50 downgrades
 * proceed and 51 aborts.
 */
export function downgradeGuardTrips(staged: number, cohort: number, config: Parameters<typeof allowedDowngrades>[1]): boolean {
  return staged > allowedDowngrades(cohort, config);
}
