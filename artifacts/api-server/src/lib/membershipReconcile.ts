/**
 * Reconciliation — the answer to *regardless of whether the event arrives at
 * all*.
 *
 * Every other path in this model depends on Stripe telling us something. This
 * one does not: it enumerates authoritative provider state, compares it against
 * the local entitlement sources, and repairs the difference. A permanently
 * dropped webhook — never retried, never delivered — is fixed here or nowhere.
 *
 * Two properties make it safe to run unattended:
 *
 *   1. **Staged, then guarded, then applied.** The whole change set is computed
 *      before anything is written, so the downgrade bound is evaluated over the
 *      complete set rather than incrementally. A run that would revoke too many
 *      people aborts having mutated nothing and reports exactly what it would
 *      have done.
 *   2. **A heartbeated run lease.** A staging run has no bounded duration, so a
 *      fixed TTL would either expire legitimate slow runs — which the fence then
 *      aborts, so the run can *never* complete on a slow day — or let a crashed
 *      run block repair for that whole period. Expiry has to mean *the holder
 *      stopped*, and only a heartbeat gives that.
 */

import type Stripe from "stripe";
import { db } from "@workspace/db";
import { membershipEntitlementsTable, usersTable } from "@workspace/db/schema";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

import {
  RECONCILE_RUN_LEASE_SCOPE,
  acquireLease,
  currentHolderId,
  heartbeatLease,
  releaseLease,
  type LeaseHandle,
} from "./membershipLease.js";
import {
  allowedDowngrades,
  loadMembershipConfig,
  type MembershipConfigKey,
} from "./membershipTiming.js";
import {
  applyPrepared,
  prepareSubscriptionRefresh,
  releasePrepared,
  runNotifications,
  type Prepared,
} from "./membershipRefresh.js";
import { loadSourceSnapshots, recomputeMembership } from "./membershipSources.js";
import {
  deriveEffectiveMembership,
  effectiveTierExpr,
  GRACE_WINDOW_MS,
  type EntitlementSourceSnapshot,
} from "./membershipState.js";
import { logger } from "./logger.js";

/**
 * The row-state matrix this run reports on, per the repo's migration practice.
 * Silent bulk mutation is a bug; so is a bound that truncates without saying so.
 */
export interface ReconcileReport {
  mode: "dry-run" | "apply";
  examined: number;
  unchanged: number;
  upgraded: number;
  downgraded: number;
  /** Sources the pass could not classify — an incomplete enumeration, mostly. */
  ambiguous: number;
  /** Retrieval or pagination failures. */
  failed: number;
  /** Sources skipped because another writer held their lease. */
  skipped: number;
  /** The currently qualifying population the fractional bound is measured against. */
  cohort: number;
  allowedDowngrades: number;
  aborted: boolean;
  abortReason?: string;
  /** Every staged change, so an operator can inspect a run that aborted. */
  staged: StagedChange[];
}

export interface StagedChange {
  userId: string;
  providerRef: string;
  currentTier: string;
  intendedTier: string;
  direction: "upgrade" | "downgrade" | "unchanged";
}

const emptyReport = (mode: ReconcileReport["mode"]): ReconcileReport => ({
  mode,
  examined: 0,
  unchanged: 0,
  upgraded: 0,
  downgraded: 0,
  ambiguous: 0,
  failed: 0,
  skipped: 0,
  cohort: 0,
  allowedDowngrades: 0,
  aborted: false,
  staged: [],
});

/**
 * The denominator, and it is not "users examined".
 *
 * Measured against examined, a run over 10,000 users of whom only 40 currently
 * qualify could revoke all forty and pass both bounds — 40 is under the absolute
 * cap and 0.4% is under the fractional one. A complete wipeout of the
 * membership. The fraction has to be of the thing being protected.
 */
export async function qualifyingPopulation(asOf?: Date): Promise<number> {
  const [row] = await db
    .select({
      cohort: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr(asOf)} = 'legendary')::int`,
    })
    .from(usersTable)
    .where(eq(usersTable.isActive, true));
  return row?.cohort ?? 0;
}

/** Replace one source in a snapshot set, for "what would this user's tier become". */
function withReplacement(
  sources: readonly EntitlementSourceSnapshot[],
  replacement: EntitlementSourceSnapshot,
): EntitlementSourceSnapshot[] {
  return sources.map((source) => (source.id === replacement.id ? replacement : source));
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Default is a dry run. Nothing is written unless this is explicitly true. */
  apply?: boolean;
  /**
   * Proceed even though the downgrade guard tripped. The guard fails CLOSED —
   * not revoking is the safe direction — so overriding it is a deliberate,
   * explicit act by an operator who has read the staged change set.
   */
  overrideDowngradeGuard?: boolean;
  asOf?: Date;
}

export async function reconcileMemberships(
  stripe: Stripe,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const config = await loadMembershipConfig();
  const report = emptyReport(opts.apply ? "apply" : "dry-run");

  const lease = await acquireLease(
    RECONCILE_RUN_LEASE_SCOPE,
    config.reconcile_run_lease_ttl_seconds,
    currentHolderId(),
  );
  if (!lease) {
    report.aborted = true;
    report.abortReason = "another reconciliation run holds the lease";
    return report;
  }

  const heartbeat = startHeartbeat(lease, config);

  try {
    return await runStagedReconciliation(stripe, config, opts, report, heartbeat);
  } finally {
    heartbeat.stop();
    await releaseLease(lease);
  }
}

interface Heartbeat {
  stop(): void;
  /** False once a renewal has failed — the run must abandon rather than continue unfenced. */
  alive(): boolean;
}

function startHeartbeat(
  lease: LeaseHandle,
  config: Record<MembershipConfigKey, number>,
): Heartbeat {
  let alive = true;
  const timer = setInterval(() => {
    void heartbeatLease(lease, config.reconcile_run_lease_ttl_seconds).then((renewed) => {
      if (!renewed) {
        alive = false;
        logger.error(
          { scope: lease.scope },
          "reconciliation lost its run lease — abandoning rather than continuing unfenced",
        );
      }
    });
  }, config.reconcile_heartbeat_interval_seconds * 1000);
  // Never hold the process open for a heartbeat.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    alive: () => alive,
  };
}

async function runStagedReconciliation(
  stripe: Stripe,
  config: Record<MembershipConfigKey, number>,
  opts: ReconcileOptions,
  report: ReconcileReport,
  heartbeat: Heartbeat,
): Promise<ReconcileReport> {
  const asOf = opts.asOf ?? new Date();

  const sources = await db
    .select({
      id: membershipEntitlementsTable.id,
      userId: membershipEntitlementsTable.userId,
      providerRef: membershipEntitlementsTable.providerRef,
    })
    .from(membershipEntitlementsTable)
    .where(eq(membershipEntitlementsTable.sourceType, "stripe_subscription"));

  // Phase 1 — stage. Retrieval only; nothing is written, and the leases taken
  // here are held until the apply so the state cannot move underneath us.
  const prepared: Array<{ prepared: Prepared; userId: string; providerRef: string }> = [];

  for (const source of sources) {
    if (!heartbeat.alive()) {
      report.aborted = true;
      report.abortReason = "run lease lost during staging";
      await releaseAll(prepared);
      return report;
    }
    if (!source.providerRef) continue;

    report.examined += 1;

    let result: Prepared;
    try {
      result = await prepareSubscriptionRefresh(stripe, source.providerRef);
    } catch (error) {
      report.failed += 1;
      logger.warn({ err: error, providerRef: source.providerRef }, "reconcile: retrieval failed");
      continue;
    }

    if (result.kind === "noop") {
      if (result.reason === "source_busy") report.skipped += 1;
      else if (result.reason === "incomplete_enumeration") report.ambiguous += 1;
      else report.failed += 1;
      continue;
    }

    prepared.push({ prepared: result, userId: source.userId, providerRef: source.providerRef });
  }

  // Phase 2 — classify, over the WHOLE staged set. Entry 22's "arriving in
  // pieces" defeat is why this is not incremental.
  const byUser = new Map<string, EntitlementSourceSnapshot[]>();
  for (const item of prepared) {
    if (!byUser.has(item.userId)) {
      byUser.set(item.userId, await loadSourceSnapshots(db, item.userId));
    }
  }

  for (const item of prepared) {
    if (item.prepared.kind !== "subscription") continue;
    const existing = byUser.get(item.userId) ?? [];
    const current = deriveEffectiveMembership(existing, asOf);

    // Match by provider reference — the source's frozen identity. Matching by
    // "the first subscription source" would apply one subscription's refreshed
    // state to a different subscription for users who hold two.
    const replacement = existing.find(
      (source) =>
        source.sourceType === "stripe_subscription" && source.providerRef === item.providerRef,
    );

    const intendedSources = replacement
      ? withReplacement(existing, {
          ...replacement,
          isMembershipProduct: item.prepared.verified.isMembershipProduct,
          lifecycleStatus: item.prepared.verified.lifecycleStatus,
          // The refresh maintains the grace window in the same fenced apply, so
          // the staged view has to model it too — otherwise a subscription that
          // just entered `past_due` would stage as an immediate downgrade and
          // trip the guard for a cohort that has not actually lost anything.
          graceExpiresAt:
            item.prepared.verified.lifecycleStatus === "past_due"
              ? (item.prepared.graceStartedAt
                  ? new Date(item.prepared.graceStartedAt.getTime() + GRACE_WINDOW_MS)
                  : (replacement.graceExpiresAt ?? null))
              : null,
        })
      : existing;

    const intended = deriveEffectiveMembership(intendedSources, asOf);

    const direction: StagedChange["direction"] =
      intended.tier === current.tier
        ? "unchanged"
        : intended.tier === "legendary"
          ? "upgrade"
          : "downgrade";

    report.staged.push({
      userId: item.userId,
      providerRef: item.providerRef,
      currentTier: current.tier,
      intendedTier: intended.tier,
      direction,
    });

    if (direction === "unchanged") report.unchanged += 1;
    else if (direction === "upgrade") report.upgraded += 1;
    else report.downgraded += 1;
  }

  // Phase 3 — the guard, PRE-APPLY. Nothing has been written yet, so an
  // over-threshold run aborts having mutated nothing.
  report.cohort = await qualifyingPopulation(asOf);
  report.allowedDowngrades = allowedDowngrades(report.cohort, config);

  const distinctDowngradedUsers = new Set(
    report.staged.filter((change) => change.direction === "downgrade").map((c) => c.userId),
  ).size;

  const guardTrips = distinctDowngradedUsers > report.allowedDowngrades;
  const ambiguityTrips = report.ambiguous > config.reconcile_max_ambiguous_per_run;
  const errorTrips = report.failed > config.reconcile_max_errors_per_run;

  if ((guardTrips && !opts.overrideDowngradeGuard) || ambiguityTrips || errorTrips) {
    report.aborted = true;
    report.abortReason = guardTrips
      ? `${distinctDowngradedUsers} users would lose access, above the allowance of ${report.allowedDowngrades} ` +
        `for a qualifying population of ${report.cohort}`
      : ambiguityTrips
        ? `${report.ambiguous} sources could not be classified, above ${config.reconcile_max_ambiguous_per_run}`
        : `${report.failed} retrieval failures, above ${config.reconcile_max_errors_per_run}`;

    logger.error(
      { report: { ...report, staged: report.staged.length } },
      "reconciliation aborted before writing anything — failing closed means NOT revoking",
    );
    await releaseAll(prepared);
    return report;
  }

  if (!opts.apply) {
    await releaseAll(prepared);
    return report;
  }

  // Phase 4 — apply. Each source commits under its own fence, so a source whose
  // lease was lost while we staged is abandoned rather than written stale.
  for (const item of prepared) {
    if (!heartbeat.alive()) {
      report.aborted = true;
      report.abortReason = "run lease lost during apply";
      break;
    }
    try {
      const result = await db.transaction((tx) => applyPrepared(tx, item.prepared));
      await runNotifications(result.notifications);
    } catch (error) {
      report.failed += 1;
      logger.warn(
        { err: error, providerRef: item.providerRef },
        "reconcile: apply abandoned — the source will be repaired on the next pass",
      );
    }
  }

  await releaseAll(prepared);
  return report;
}

async function releaseAll(
  prepared: Array<{ prepared: Prepared }>,
): Promise<void> {
  for (const item of prepared) await releasePrepared(item.prepared);
}

// ---------------------------------------------------------------------------
// The grace convergence sweep.
// ---------------------------------------------------------------------------

/**
 * Make the STORED tier agree with what the read path is already enforcing.
 *
 * This is convergence, not enforcement. `effectiveTierExpr` already demotes a
 * lapsed member on every read, so if this sweep dies nobody keeps access past
 * their deadline — what degrades is the accuracy of the stored value, and the
 * alert surfaces that. A guarantee that holds only while a background job is
 * healthy is not a guarantee, which is why this is the cheap half.
 */
export async function sweepExpiredGrace(
  opts: { asOf?: Date; limit?: number } = {},
): Promise<{ examined: number; converged: number }> {
  const asOf = opts.asOf ?? new Date();

  const lapsed = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.membershipTier, "legendary"),
        isNotNull(usersTable.membershipValidUntil),
        lt(usersTable.membershipValidUntil, asOf),
      ),
    )
    .limit(opts.limit ?? 500);

  let converged = 0;
  for (const user of lapsed) {
    const result = await db.transaction((tx) =>
      recomputeMembership(tx, user.id, {
        asOf,
        transitionEvent: { event: "grace_expired" },
      }),
    );
    if (result?.changed) converged += 1;
  }

  return { examined: lapsed.length, converged };
}
