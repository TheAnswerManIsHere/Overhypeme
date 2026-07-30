/**
 * The write path: entitlement sources in, one derived tier out.
 *
 * Every mutation converges here. Nothing else writes `users.membership_tier` or
 * `users.membership_valid_until` — that is the whole point of the model, and the
 * defect it replaces was fifteen call sites each maintaining a derived field by
 * hand with its own ad-hoc guards.
 *
 * The shape of every authoritative write is the prepare/apply split in
 * `membershipRefresh.ts`: retrieve from Stripe with no transaction open, then
 * apply under `runBoundedApply` (`membershipLease.ts`), which sets the bounded
 * `lock_timeout` and re-checks the source's fence before any of the writers
 * below run.
 */

import { db } from "@workspace/db";
import {
  entitlementSourceDisputesTable,
  membershipEntitlementsTable,
  membershipHistoryTable,
  usersTable,
  isRecognisedDisputeStatus,
  isTerminalDisputeStatus,
  type EntitlementSourceType,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

import {
  deriveEffectiveMembership,
  qualifySource,
  GRACE_WINDOW_MS,
  type DerivedMembership,
  type EntitlementSourceSnapshot,
  type MembershipTier,
} from "./membershipState.js";
import { logger } from "./logger.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

// ---------------------------------------------------------------------------
// Reading the source set.
// ---------------------------------------------------------------------------

/**
 * Every source for a user, with its dispute hold resolved.
 *
 * The hold is a QUERY — a non-terminal row exists in
 * `entitlement_source_disputes` — not a column, because two answers to "is this
 * source held" is one more than a derived model may have.
 */
export async function loadSourceSnapshots(
  tx: Db,
  userId: string,
): Promise<EntitlementSourceSnapshot[]> {
  const rows = await tx
    .select({
      id: membershipEntitlementsTable.id,
      sourceType: membershipEntitlementsTable.sourceType,
      providerRef: membershipEntitlementsTable.providerRef,
      isMembershipProduct: membershipEntitlementsTable.isMembershipProduct,
      lifecycleStatus: membershipEntitlementsTable.lifecycleStatus,
      graceExpiresAt: membershipEntitlementsTable.graceExpiresAt,
      disputeLossRevokedAt: membershipEntitlementsTable.disputeLossRevokedAt,
      hasOpenDispute: sql<boolean>`EXISTS (
        SELECT 1 FROM ${entitlementSourceDisputesTable} d
        WHERE d.source_id = ${membershipEntitlementsTable.id} AND NOT d.is_terminal
      )`,
    })
    .from(membershipEntitlementsTable)
    .where(eq(membershipEntitlementsTable.userId, userId));

  return rows.map((row) => ({
    ...row,
    sourceType: row.sourceType as EntitlementSourceType,
    hasOpenDispute: row.hasOpenDispute === true,
  }));
}

// ---------------------------------------------------------------------------
// The single tier writer.
// ---------------------------------------------------------------------------

export interface RecomputeResult extends DerivedMembership {
  previousTier: MembershipTier;
  previousValidUntil: Date | null;
  changed: boolean;
}

export interface RecomputeOptions {
  asOf?: Date;
  /**
   * Recorded in `membership_history` **only when the tier actually transitions.**
   * That is the structural version of the `wasLegendary` guard each handler used
   * to carry by hand, and it is what keeps the in-app revocation notice
   * (`REVOCATION_EVENTS`) firing exactly once, on an actual loss of access.
   *
   * Payment FACTS — a purchase, a renewal — are recorded by their caller
   * unconditionally instead, because they happened regardless of the tier.
   */
  transitionEvent?: { event: string; stripeSubscriptionId?: string; stripePaymentIntentId?: string; stripeDisputeId?: string };
}

/**
 * Derive the user's tier from their sources and write it — but only when it
 * differs, so an idempotent replay writes nothing and emits no history.
 *
 * Takes the user row `FOR UPDATE` first: per-user serialization means two
 * sources changing at once cannot interleave into a tier computed from a
 * half-applied set.
 */
export async function recomputeMembership(
  tx: Tx,
  userId: string,
  opts: RecomputeOptions = {},
): Promise<RecomputeResult | null> {
  const asOf = opts.asOf ?? new Date();

  const [user] = await tx
    .select({
      tier: usersTable.membershipTier,
      validUntil: usersTable.membershipValidUntil,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .for("update")
    .limit(1);

  if (!user) return null;

  const sources = await loadSourceSnapshots(tx, userId);
  const derived = deriveEffectiveMembership(sources, asOf);

  // `unregistered` is an auth state, not an entitlement one — the derivation
  // never produces it, and it must never be overwritten by one that qualifies
  // nobody. A user who is unregistered stays unregistered.
  const nextTier = user.tier === "unregistered" ? "unregistered" : derived.tier;

  const tierChanged = nextTier !== user.tier;
  const horizonChanged =
    (user.validUntil?.getTime() ?? null) !== (derived.validUntil?.getTime() ?? null);

  if (tierChanged || horizonChanged) {
    await tx
      .update(usersTable)
      .set({ membershipTier: nextTier, membershipValidUntil: derived.validUntil })
      .where(eq(usersTable.id, userId));
  }

  if (tierChanged && opts.transitionEvent) {
    await tx.insert(membershipHistoryTable).values({
      userId,
      event: opts.transitionEvent.event,
      stripeSubscriptionId: opts.transitionEvent.stripeSubscriptionId ?? null,
      stripePaymentIntentId: opts.transitionEvent.stripePaymentIntentId ?? null,
      stripeDisputeId: opts.transitionEvent.stripeDisputeId ?? null,
    });
  }

  return {
    ...derived,
    tier: nextTier,
    previousTier: user.tier as MembershipTier,
    previousValidUntil: user.validUntil,
    changed: tierChanged || horizonChanged,
  };
}

// ---------------------------------------------------------------------------
// Writing a source.
// ---------------------------------------------------------------------------

/** What an authoritative refresh writes for a subscription source. */
export interface SubscriptionSourceState {
  sourceType: "stripe_subscription";
  userId: string;
  providerRef: string;
  isMembershipProduct: boolean;
  lifecycleStatus: string;
  plan: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** What a verified one-time purchase writes. Frozen after creation. */
export interface LifetimeSourceState {
  sourceType: "stripe_lifetime_payment";
  userId: string;
  providerRef: string;
  isMembershipProduct: boolean;
  lifecycleStatus: "active" | "refunded";
  amount: number | null;
  currency: string | null;
}

async function nextSourceStateToken(tx: Db): Promise<number> {
  const result = await tx.execute<{ token: string }>(
    sql`SELECT nextval('membership_source_state_seq') AS token`,
  );
  return Number(result.rows[0].token);
}

/**
 * Apply a refreshed subscription source.
 *
 * Writes only the cells a subscription refresh OWNS. Everything else — the
 * dispute revocation, the W1b provenance columns, the identity columns — is left
 * byte-identical, which is the ownership matrix expressed as code rather than as
 * a table an implementer has to remember.
 *
 * The grace window is *maintained* here: the refresh may open, extend or clear
 * the episode in this same fenced apply. Classifying it as never-touched
 * forbade both the repair of a missed `invoice.payment_failed` and the clearing
 * of a stale window after recovery.
 */
export async function applySubscriptionSource(
  tx: Tx,
  state: SubscriptionSourceState,
  opts: { graceStartedAt?: Date | null } = {},
): Promise<{
  applied: boolean;
  created: boolean;
  sourceId: number | null;
  /** The status this row carried BEFORE this write, or null when there was no prior row. */
  previousLifecycleStatus: string | null;
}> {
  const token = await nextSourceStateToken(tx);

  // Grace is an EPISODE: it starts on first entry to past_due and duplicate
  // events do not extend it. Recovery clears it.
  const [existing] = await tx
    .select({
      id: membershipEntitlementsTable.id,
      lifecycleStatus: membershipEntitlementsTable.lifecycleStatus,
      graceStartedAt: membershipEntitlementsTable.graceStartedAt,
      graceExpiresAt: membershipEntitlementsTable.graceExpiresAt,
      sourceStateAsOf: membershipEntitlementsTable.sourceStateAsOf,
    })
    .from(membershipEntitlementsTable)
    .where(
      and(
        eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
        eq(membershipEntitlementsTable.providerRef, state.providerRef),
      ),
    )
    .limit(1);

  let graceStartedAt: Date | null = null;
  let graceExpiresAt: Date | null = null;

  if (state.lifecycleStatus === "past_due") {
    // Prefer the episode already open; else the caller's resolved first-failure
    // timestamp. When neither is available the first failed attempt was
    // unresolvable, so NO deadline is derived — the source keeps qualifying and
    // the case is reported. A guessed start can only be early, and early means
    // revoking a paying customer.
    const anchor = existing?.graceStartedAt ?? opts.graceStartedAt ?? null;
    if (anchor) {
      graceStartedAt = anchor;
      graceExpiresAt = new Date(anchor.getTime() + GRACE_WINDOW_MS);
    }
  }

  if (existing) {
    const result = await tx
      .update(membershipEntitlementsTable)
      .set({
        isMembershipProduct: state.isMembershipProduct,
        lifecycleStatus: state.lifecycleStatus,
        plan: state.plan,
        currentPeriodEnd: state.currentPeriodEnd,
        cancelAtPeriodEnd: state.cancelAtPeriodEnd,
        graceStartedAt,
        graceExpiresAt,
        sourceStateAsOf: token,
      })
      .where(
        and(
          eq(membershipEntitlementsTable.id, existing.id),
          // The version guard, unconditional. Defence in depth behind the lease
          // and its fence, for any path that somehow bypassed them.
          sql`${membershipEntitlementsTable.sourceStateAsOf} < ${token}`,
        ),
      )
      .returning({ id: membershipEntitlementsTable.id });

    return {
      applied: result.length > 0,
      created: false,
      sourceId: existing.id,
      previousLifecycleStatus: existing.lifecycleStatus,
    };
  }

  const inserted = await tx
    .insert(membershipEntitlementsTable)
    .values({
      userId: state.userId,
      sourceType: "stripe_subscription",
      providerRef: state.providerRef,
      isMembershipProduct: state.isMembershipProduct,
      lifecycleStatus: state.lifecycleStatus,
      plan: state.plan,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      graceStartedAt,
      graceExpiresAt,
      sourceStateAsOf: token,
    })
    .onConflictDoNothing()
    .returning({ id: membershipEntitlementsTable.id });

  return {
    applied: inserted.length > 0,
    created: inserted.length > 0,
    sourceId: inserted[0]?.id ?? null,
    previousLifecycleStatus: null,
  };
}

/**
 * Create a lifetime source from a verified purchase.
 *
 * `is_membership_product` is FROZEN here: it describes what was bought, which is
 * a completed fact that a later product-metadata edit cannot retroactively
 * revoke or grant. Idempotent on the payment-intent unique index, which is what
 * makes a duplicate webhook a no-op with no new mechanism.
 */
export async function createLifetimeSource(
  tx: Tx,
  state: LifetimeSourceState,
): Promise<{ created: boolean; sourceId: number | null }> {
  const token = await nextSourceStateToken(tx);

  const inserted = await tx
    .insert(membershipEntitlementsTable)
    .values({
      userId: state.userId,
      sourceType: "stripe_lifetime_payment",
      providerRef: state.providerRef,
      isMembershipProduct: state.isMembershipProduct,
      lifecycleStatus: state.lifecycleStatus,
      amount: state.amount,
      currency: state.currency,
      sourceStateAsOf: token,
    })
    .onConflictDoNothing()
    .returning({ id: membershipEntitlementsTable.id });

  return { created: inserted.length > 0, sourceId: inserted[0]?.id ?? null };
}

/**
 * Move a lifetime source to `refunded`.
 *
 * *Maintained*, not untouched: the vocabulary (`active`/`refunded`) is ours but
 * the FACT is Stripe's, and reconciliation must be able to repair a refund whose
 * webhook was dropped. Under a never-touched rule that repair is forbidden and a
 * refunded lifetime purchase grants Legendary indefinitely.
 *
 * Only a FULL refund moves the source. A partial one records history and leaves
 * the entitlement active.
 */
export async function markLifetimeRefunded(
  tx: Tx,
  paymentIntentId: string,
): Promise<{ applied: boolean; userId: string | null }> {
  const token = await nextSourceStateToken(tx);

  const result = await tx
    .update(membershipEntitlementsTable)
    .set({ lifecycleStatus: "refunded", sourceStateAsOf: token })
    .where(
      and(
        eq(membershipEntitlementsTable.sourceType, "stripe_lifetime_payment"),
        eq(membershipEntitlementsTable.providerRef, paymentIntentId),
        sql`${membershipEntitlementsTable.sourceStateAsOf} < ${token}`,
      ),
    )
    .returning({ userId: membershipEntitlementsTable.userId });

  return { applied: result.length > 0, userId: result[0]?.userId ?? null };
}

// ---------------------------------------------------------------------------
// Disputes — one transition writer for all three events.
// ---------------------------------------------------------------------------

export type DisputeTransitionOutcome =
  | { outcome: "applied"; isTerminal: boolean; lostRevocationWritten: boolean }
  | { outcome: "no_op_terminal"; lostRevocationWritten: boolean }
  | { outcome: "unrecognised_status"; status: string }
  | { outcome: "source_unknown" };

/**
 * The single writer `charge.dispute.created`, `.updated` and `.closed` all route
 * through — and the one reconciliation uses to repair a missed `lost`.
 *
 * Three dispositions that are deliberately NOT errors, because raising one would
 * roll back the idempotency claim and make Stripe retry the same event forever:
 *
 *   - a terminal row re-observed as non-terminal: the terminal row is retained,
 *     the write is a silent no-op, and the anomaly is reported;
 *   - an unrecognised status: no state change, reported. A first observation
 *     creates no row, so nothing is held — an indefinite hold nobody can clear
 *     is a worse failure than a reported gap;
 *   - an unresolvable source: nothing held, reported.
 */
export async function applyDisputeTransition(
  tx: Tx,
  input: { stripeDisputeId: string; status: string; sourceId: number },
): Promise<DisputeTransitionOutcome> {
  if (!isRecognisedDisputeStatus(input.status)) {
    return { outcome: "unrecognised_status", status: input.status };
  }

  const isTerminal = isTerminalDisputeStatus(input.status);

  // `lost` writes the terminal revocation FIRST, then clears the hold. Written
  // the other way round there is a window in which the source is neither held
  // nor revoked, and a recompute landing in it hands access back.
  let lostRevocationWritten = false;
  if (input.status === "lost") {
    const token = await nextSourceStateToken(tx);
    const revoked = await tx
      .update(membershipEntitlementsTable)
      .set({ disputeLossRevokedAt: sql`now()`, sourceStateAsOf: token })
      .where(
        and(
          eq(membershipEntitlementsTable.id, input.sourceId),
          // Set-once. The database trigger enforces this too; the predicate here
          // keeps a repeat pass from even attempting a write it would reject.
          sql`${membershipEntitlementsTable.disputeLossRevokedAt} IS NULL`,
        ),
      )
      .returning({ id: membershipEntitlementsTable.id });
    lostRevocationWritten = revoked.length > 0;
  }

  // The conditional upsert: DO UPDATE carries a WHERE on the EXISTING row, so a
  // terminal row is a silent no-op and RETURNING yields nothing — which is the
  // signal that the anomaly occurred.
  const applied = await tx.execute<{ stripe_dispute_id: string }>(sql`
    INSERT INTO entitlement_source_disputes
      (stripe_dispute_id, source_id, status, is_terminal, first_seen_at, resolved_at)
    VALUES (
      ${input.stripeDisputeId},
      ${input.sourceId},
      ${input.status},
      ${isTerminal},
      now(),
      ${isTerminal ? sql`now()` : sql`NULL`}
    )
    ON CONFLICT (stripe_dispute_id) DO UPDATE
      SET status = EXCLUDED.status,
          is_terminal = EXCLUDED.is_terminal,
          resolved_at = CASE WHEN EXCLUDED.is_terminal THEN now() ELSE NULL END
      WHERE NOT entitlement_source_disputes.is_terminal
    RETURNING stripe_dispute_id
  `);

  if (applied.rows.length === 0) {
    // The dispute row itself was a no-op (already terminal), but the source's
    // permanent `disputeLossRevokedAt` write above is unconditional on THIS
    // row's terminal state — it can still have just been written. The caller
    // must recompute on that, not skip recompute because the dispute-row upsert
    // happened to no-op.
    return { outcome: "no_op_terminal", lostRevocationWritten };
  }

  return { outcome: "applied", isTerminal, lostRevocationWritten };
}

/**
 * Does this user hold a lifetime entitlement that currently QUALIFIES?
 *
 * The seven callers this replaces all asked "does a lifetime row exist", which
 * is the wrong question under a model that deliberately RETAINS refunded and
 * dispute-revoked rows for the audit trail. A refunded purchase keeps its row
 * forever, so bare existence would report the user as a lifetime member
 * indefinitely — and, at the routes that block lifetime members from cancelling,
 * would lock a refunded user out of managing a subscription they do have.
 *
 * Answered by the same derivation as the tier, so the two cannot disagree.
 *
 * Counts both `stripe_lifetime_payment` and `admin_grant`: both are permanent,
 * non-recurring entitlements from the caller's perspective (no subscription to
 * cancel, no renewal date), which is exactly the distinction every caller of
 * this helper is drawing. A comped Legendary-for-Life member is not a paying
 * subscriber and should read the same as one who paid, everywhere this is used
 * — the checkout allowlist, the cancel-subscription guard, and the admin
 * membership screen alike.
 */
export async function hasQualifyingLifetimeSource(userId: string): Promise<boolean> {
  const sources = await loadSourceSnapshots(db, userId);
  const asOf = new Date();
  return sources.some(
    (source) =>
      (source.sourceType === "stripe_lifetime_payment" || source.sourceType === "admin_grant") &&
      qualifySource(source, asOf).qualifies,
  );
}

/** Resolve the EXACT source a dispute attaches to. A hold on the wrong source revokes the wrong thing. */
export async function findSourceByProviderRef(
  tx: Db,
  sourceType: EntitlementSourceType,
  providerRef: string,
): Promise<{ id: number; userId: string } | null> {
  const [row] = await tx
    .select({
      id: membershipEntitlementsTable.id,
      userId: membershipEntitlementsTable.userId,
    })
    .from(membershipEntitlementsTable)
    .where(
      and(
        eq(membershipEntitlementsTable.sourceType, sourceType),
        eq(membershipEntitlementsTable.providerRef, providerRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// W1b — admin grants.
// ---------------------------------------------------------------------------

/**
 * Write an authorized admin grant and recompute.
 *
 * The partial unique index on active admin grants is what makes a duplicate
 * submission — or a retry after an uncertain response — a no-op rather than a
 * second qualifying row that survives a later revoke.
 */
export async function writeAdminGrant(
  tx: Tx,
  grant: {
    userId: string;
    grantedByAdminId: string;
    grantedByAdminLabel: string;
    grantReason: string;
  },
): Promise<{ created: boolean; sourceId: number | null }> {
  const token = await nextSourceStateToken(tx);

  const inserted = await tx
    .insert(membershipEntitlementsTable)
    .values({
      userId: grant.userId,
      sourceType: "admin_grant",
      providerRef: null,
      isMembershipProduct: null,
      lifecycleStatus: "active",
      grantedByAdminId: grant.grantedByAdminId,
      grantedByAdminLabel: grant.grantedByAdminLabel,
      grantReason: grant.grantReason,
      sourceStateAsOf: token,
    })
    .onConflictDoNothing()
    .returning({ id: membershipEntitlementsTable.id });

  return { created: inserted.length > 0, sourceId: inserted[0]?.id ?? null };
}

export async function writeAdminRevocation(
  tx: Tx,
  userId: string,
  revocation: {
    revokedByAdminId: string;
    revokedByAdminLabel: string;
    revokedReason: string;
    revokedAt: Date;
  },
): Promise<{ revoked: boolean }> {
  const token = await nextSourceStateToken(tx);

  const result = await tx
    .update(membershipEntitlementsTable)
    .set({
      lifecycleStatus: "revoked",
      revokedByAdminId: revocation.revokedByAdminId,
      revokedByAdminLabel: revocation.revokedByAdminLabel,
      revokedReason: revocation.revokedReason,
      revokedAt: revocation.revokedAt,
      sourceStateAsOf: token,
    })
    .where(
      and(
        eq(membershipEntitlementsTable.userId, userId),
        eq(membershipEntitlementsTable.sourceType, "admin_grant"),
        eq(membershipEntitlementsTable.lifecycleStatus, "active"),
      ),
    )
    .returning({ id: membershipEntitlementsTable.id });

  return { revoked: result.length > 0 };
}
