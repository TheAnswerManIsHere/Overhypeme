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
import {
  membershipEntitlementsTable,
  membershipReconciliationRunsTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

import {
  RECONCILE_RUN_LEASE_SCOPE,
  acquireLease,
  currentHolderId,
  heartbeatLease,
  releaseLease,
  runBoundedApply,
  type LeaseHandle,
} from "./membershipLease.js";
import {
  allowedDowngrades,
  loadMembershipConfig,
  type MembershipConfigKey,
} from "./membershipTiming.js";
import {
  applyPrepared,
  makeVerificationDeps,
  prepareSubscriptionRefresh,
  releasePrepared,
  resolveGraceEpisodeStart,
  runNotifications,
} from "./membershipRefresh.js";
import { verifyMembershipSubscription, type SubscriptionVerification } from "./entitlementVerification.js";
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
  /**
   * The USER'S overall before/after, not this source's in isolation. Computed
   * once per user from every one of their staged sources applied TOGETHER — a
   * user with two subscriptions that both become canceled must show
   * "downgrade" on both rows, even though replacing either source alone,
   * against the other's still-active baseline, would individually look
   * unchanged. That per-source illusion is what let a real mass-downgrade
   * bypass the guard: two "unchanged" verdicts never registered as one
   * downgraded user.
   */
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

/**
 * The apply-time guard's veto reason. Distinct from a Stripe-side no-op so the
 * report can count it as deferred work rather than a failure.
 */
const UNGUARDED_DOWNGRADE = "unguarded_downgrade";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

  const startedAt = opts.asOf ?? new Date();

  const lease = await acquireLease(
    RECONCILE_RUN_LEASE_SCOPE,
    config.reconcile_run_lease_ttl_seconds,
    currentHolderId(),
  );
  if (!lease) {
    // Deliberately NOT recorded. Losing the lease race is a no-op, not a run —
    // and on a short reconcile interval across several instances these would be
    // the majority of rows, burying the ones that describe real work.
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
    // In `finally`, so a run that ABORTED or THREW is recorded too — those are
    // the runs an operator most needs to read afterwards. `report` is mutated
    // in place throughout, so it carries the final state either way. Recording
    // lives here rather than in the caller because a caller can forget, and the
    // durable record is the whole point.
    await recordReconciliationRun(startedAt, report);
  }
}

/**
 * How many staged changes one run may persist.
 *
 * A bound is necessary — a run staging every source would otherwise write an
 * unbounded JSONB blob — but a bound that hid itself would report a prefix as
 * though it were the whole change set. `stagedTotal` and `stagedTruncated`
 * carry what was dropped, so the cap is legible in the row it applies to.
 */
const MAX_PERSISTED_STAGED = 500;

/** How many runs to retain. Older rows are pruned as new ones land. */
const RETAINED_RUNS = 100;

/**
 * Persist one run at both altitudes.
 *
 * Never throws: this is observability, and failing a reconciliation that
 * actually did its work because we could not write its record would trade a
 * real repair for a log line.
 */
async function recordReconciliationRun(
  startedAt: Date,
  report: ReconcileReport,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(membershipReconciliationRunsTable)
        .values({
          startedAt,
          mode: report.mode,
          examined: report.examined,
          unchanged: report.unchanged,
          upgraded: report.upgraded,
          downgraded: report.downgraded,
          ambiguous: report.ambiguous,
          failed: report.failed,
          skipped: report.skipped,
          cohort: report.cohort,
          allowedDowngrades: report.allowedDowngrades,
          aborted: report.aborted,
          abortReason: report.abortReason ?? null,
          staged: report.staged.slice(0, MAX_PERSISTED_STAGED),
          stagedTotal: report.staged.length,
          stagedTruncated: report.staged.length > MAX_PERSISTED_STAGED,
        })
        .returning({ id: membershipReconciliationRunsTable.id });

      // Retention, in the same transaction as the insert so the table cannot
      // grow without bound if pruning is skipped on a later failure path.
      await tx.execute(sql`
        DELETE FROM membership_reconciliation_runs
        WHERE id IN (
          SELECT id FROM membership_reconciliation_runs
          ORDER BY started_at DESC, id DESC
          OFFSET ${RETAINED_RUNS}
        )
      `);

      return row;
    });
  } catch (error) {
    logger.error(
      { err: error, mode: report.mode, aborted: report.aborted },
      "could not record the reconciliation run — the run itself is unaffected",
    );
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
  const markDead = (reason: string, err?: unknown) => {
    alive = false;
    logger.error(
      { scope: lease.scope, err },
      `reconciliation lost its run lease (${reason}) — abandoning rather than continuing unfenced`,
    );
  };
  const timer = setInterval(() => {
    // A transient DB error here is exactly the ambiguous case a heartbeat
    // exists to resolve: we cannot tell "the lease expired" from "the renewal
    // request itself failed", and continuing on the optimistic assumption of
    // aliveness is precisely the unfenced-continuation this whole mechanism is
    // built to prevent. So a rejection is treated the same as a false renewal —
    // marked dead, not left unhandled (which would otherwise be an unhandled
    // promise rejection, able to crash the process outright).
    heartbeatLease(lease, config.reconcile_run_lease_ttl_seconds).then(
      (renewed) => {
        if (!renewed) markDead("renewal returned false");
      },
      (err) => markDead("renewal threw", err),
    );
  }, config.reconcile_heartbeat_interval_seconds * 1000);
  // Never hold the process open for a heartbeat.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    alive: () => alive,
  };
}

interface VerifiedStagingItem {
  userId: string;
  providerRef: string;
  verified: Extract<SubscriptionVerification, { ok: true }>;
  /** Only resolved when the verified status is `past_due` — see `resolveGraceEpisodeStart`. */
  graceStartedAt: Date | null;
}

async function runStagedReconciliation(
  stripe: Stripe,
  config: Record<MembershipConfigKey, number>,
  opts: ReconcileOptions,
  report: ReconcileReport,
  heartbeat: Heartbeat,
): Promise<ReconcileReport> {
  const asOf = opts.asOf ?? new Date();
  const deps = makeVerificationDeps(stripe);

  const sources = await db
    .select({
      id: membershipEntitlementsTable.id,
      userId: membershipEntitlementsTable.userId,
      providerRef: membershipEntitlementsTable.providerRef,
    })
    .from(membershipEntitlementsTable)
    .where(eq(membershipEntitlementsTable.sourceType, "stripe_subscription"));

  // Phase 1 — stage. VERIFY ONLY, no lease and nothing written.
  //
  // A per-source lease held for the whole staging pass is what let leases
  // expire before this source's own apply phase ever ran (a fixed 60s
  // per-source TTL, no heartbeat, held across however long the REST of the
  // staged set took to classify and guard) — so this phase takes no lease at
  // all, and the apply phase re-acquires and re-verifies fresh, right before
  // writing, exactly like the webhook path does. That also means a staged
  // classification can be based on a snapshot that is mildly stale by the time
  // apply runs; that's accepted, not a regression — the guard's thresholds are
  // safety valves against BULK bad behaviour, not a promise that the exact
  // reported outcome is what gets written, and re-verifying at apply time is
  // strictly MORE correct than writing a possibly-stale staged snapshot would
  // have been.
  const verified: VerifiedStagingItem[] = [];

  for (const source of sources) {
    if (!heartbeat.alive()) {
      report.aborted = true;
      report.abortReason = "run lease lost during staging";
      return report;
    }
    if (!source.providerRef) continue;

    report.examined += 1;

    let result: SubscriptionVerification;
    try {
      result = await verifyMembershipSubscription(source.providerRef, deps);
    } catch (error) {
      report.failed += 1;
      logger.warn({ err: error, providerRef: source.providerRef }, "reconcile: retrieval failed");
      continue;
    }

    if (!result.ok) {
      if (result.code === "incomplete_enumeration") report.ambiguous += 1;
      else report.failed += 1;
      continue;
    }

    let graceStartedAt: Date | null = null;
    if (result.lifecycleStatus === "past_due") {
      const grace = await resolveGraceEpisodeStart(stripe, source.providerRef);
      graceStartedAt = grace.startedAt;
    }

    verified.push({ userId: source.userId, providerRef: source.providerRef, verified: result, graceStartedAt });
  }

  // Phase 2 — classify PER USER, every one of that user's staged replacements
  // applied TOGETHER against one baseline. Simulating one source at a time
  // against the others' unchanged (pre-refresh) state is what let two
  // subscriptions each independently look "unchanged" while their combined
  // effect was a real downgrade — because each simulation still saw the
  // OTHER source as still-active, when in reality both had just cancelled.
  const byUser = new Map<string, EntitlementSourceSnapshot[]>();
  for (const item of verified) {
    if (!byUser.has(item.userId)) {
      byUser.set(item.userId, await loadSourceSnapshots(db, item.userId));
    }
  }

  const itemsByUser = new Map<string, VerifiedStagingItem[]>();
  for (const item of verified) {
    const list = itemsByUser.get(item.userId) ?? [];
    list.push(item);
    itemsByUser.set(item.userId, list);
  }

  for (const [userId, userItems] of itemsByUser) {
    const existing = byUser.get(userId) ?? [];
    const current = deriveEffectiveMembership(existing, asOf);

    // Replace EVERY one of this user's verified sources simultaneously, not
    // one at a time — a single combined view of what this user's whole
    // qualifying set becomes.
    let intendedSources = existing;
    for (const item of userItems) {
      const replacement = intendedSources.find(
        (source) =>
          source.sourceType === "stripe_subscription" && source.providerRef === item.providerRef,
      );
      if (!replacement) continue;
      intendedSources = withReplacement(intendedSources, {
        ...replacement,
        isMembershipProduct: item.verified.isMembershipProduct,
        lifecycleStatus: item.verified.lifecycleStatus,
        // The refresh maintains the grace window in the same fenced apply, so
        // the staged view has to model it too — otherwise a subscription that
        // just entered `past_due` would stage as an immediate downgrade and
        // trip the guard for a cohort that has not actually lost anything.
        graceExpiresAt:
          item.verified.lifecycleStatus === "past_due"
            ? (item.graceStartedAt
                ? new Date(item.graceStartedAt.getTime() + GRACE_WINDOW_MS)
                : (replacement.graceExpiresAt ?? null))
            : null,
      });
    }

    const intended = deriveEffectiveMembership(intendedSources, asOf);

    const direction: StagedChange["direction"] =
      intended.tier === current.tier
        ? "unchanged"
        : intended.tier === "legendary"
          ? "upgrade"
          : "downgrade";

    for (const item of userItems) {
      report.staged.push({
        userId,
        providerRef: item.providerRef,
        currentTier: current.tier,
        intendedTier: intended.tier,
        direction,
      });
    }

    if (direction === "unchanged") report.unchanged += 1;
    else if (direction === "upgrade") report.upgraded += 1;
    else report.downgraded += 1;
  }

  // Phase 3 — the guard, PRE-APPLY. Nothing has been written yet, so an
  // over-threshold run aborts having mutated nothing. Counted per USER (the
  // `report.staged` rows for one user all carry that user's shared direction,
  // so deduplicating by userId is correct and not an undercount).
  report.cohort = await qualifyingPopulation(asOf);
  report.allowedDowngrades = allowedDowngrades(report.cohort, config);

  const distinctDowngradedUserIds = new Set(
    report.staged.filter((change) => change.direction === "downgrade").map((c) => c.userId),
  );
  const distinctDowngradedUsers = distinctDowngradedUserIds.size;

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
    return report;
  }

  if (!opts.apply) {
    return report;
  }

  // Phase 4 — apply. Fresh prepare (retrieve + lease + fence) right before each
  // write, exactly like the webhook path — never the phase-1 staged snapshot.
  // A source whose lease is held by someone else here is SKIPPED, not failed:
  // reconciliation repairs it on the next pass, same as the webhook path's
  // "abandon rather than proceed unordered".
  for (const item of verified) {
    if (!heartbeat.alive()) {
      report.aborted = true;
      report.abortReason = "run lease lost during apply";
      break;
    }

    const prepared = await prepareSubscriptionRefresh(stripe, item.providerRef);
    if (prepared.kind === "noop") {
      if (prepared.reason === "source_busy") report.skipped += 1;
      else if (prepared.reason !== "incomplete_enumeration") report.failed += 1;
      continue;
    }

    // The guard in Phase 3 only ever saw the Phase 1/2 staged snapshot. Between
    // then and now, Stripe state can have moved again — a bulk provider-side
    // change during a long-running pass — and this fresh prepare reflects THAT,
    // not what was guarded. Applying it unconditionally would let a downgrade the
    // guard never evaluated slip through under cover of a report that shows zero
    // (or an already-bounded number of) downgrades.
    //
    // So the classification is redone here — and, critically, INSIDE the apply
    // transaction with this user's row lock already held. Doing it just before
    // the transaction (as a previous revision did) reads state that is fresh and
    // still races: for a user holding subscriptions A and B, the check can see B
    // active and admit A's cancellation while a concurrent writer cancels B, each
    // side observing the other as active, and the resulting recompute downgrades
    // a user Phase 3 never counted. Under the lock that interleaving cannot
    // happen, because every writer able to move this user's tier must take the
    // same lock to recompute.
    // ONE instant for the guard and the recompute it authorizes, taken now
    // rather than at the run's start. Judging against the run-start `asOf`
    // while the recompute ran at `now()` reintroduced the same class of gap by
    // the back door: a grace deadline expiring between staging and here would
    // look qualifying to the guard and expired to the recompute, producing an
    // uncounted downgrade out of a check that had just approved.
    const applyAsOf = new Date();

    const guard = async (tx: Tx, userId: string): Promise<string | null> => {
      // Already counted by Phase 3 — this downgrade IS guarded.
      if (distinctDowngradedUserIds.has(userId)) return null;
      if (prepared.kind !== "subscription") return null;

      const freshExisting = await loadSourceSnapshots(tx, userId);
      const freshReplacement = freshExisting.find(
        (source) =>
          source.sourceType === "stripe_subscription" && source.providerRef === item.providerRef,
      );
      if (!freshReplacement) return null;

      const freshCurrent = deriveEffectiveMembership(freshExisting, applyAsOf);
      const freshIntended = deriveEffectiveMembership(
        withReplacement(freshExisting, {
          ...freshReplacement,
          isMembershipProduct: prepared.verified.isMembershipProduct,
          lifecycleStatus: prepared.verified.lifecycleStatus,
          graceExpiresAt:
            prepared.verified.lifecycleStatus === "past_due"
              ? (prepared.graceStartedAt
                  ? new Date(prepared.graceStartedAt.getTime() + GRACE_WINDOW_MS)
                  : (freshReplacement.graceExpiresAt ?? null))
              : null,
        }),
        applyAsOf,
      );

      return freshCurrent.tier === "legendary" && freshIntended.tier !== "legendary"
        ? UNGUARDED_DOWNGRADE
        : null;
    };

    try {
      const result = await runBoundedApply((tx) =>
        applyPrepared(tx, prepared, { guard, asOf: applyAsOf }),
      );
      if (result.reason === UNGUARDED_DOWNGRADE) {
        report.skipped += 1;
        logger.warn(
          { providerRef: item.providerRef, userId: item.userId },
          "reconcile: apply-time state shows a downgrade the guard never evaluated — deferred to the next run",
        );
      }
      await runNotifications(result.notifications);
    } catch (error) {
      report.failed += 1;
      logger.warn(
        { err: error, providerRef: item.providerRef },
        "reconcile: apply abandoned — the source will be repaired on the next pass",
      );
    } finally {
      await releasePrepared(prepared);
    }
  }

  return report;
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
