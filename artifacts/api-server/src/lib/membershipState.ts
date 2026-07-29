/**
 * The one place membership is decided.
 *
 * Membership is **derived** from durable entitlement sources, never assigned by
 * whichever event handler happens to fire. Every writer converges here; every
 * reader of a tier goes through `effectiveTierExpr` or `getEffectiveMembership`.
 *
 * Two halves, deliberately separate:
 *
 *   - `deriveEffectiveMembership` — pure, time-parameterised, no I/O. The policy
 *     lives here and only here, so it is unit-testable without a database.
 *   - `effectiveTierExpr` / `getEffectiveMembership` — the read path, which
 *     applies the *stored* horizon against a clock. This is NOT a second
 *     derivation: no policy is duplicated in the hot path. The derivation
 *     computes both the tier and the instant its validity lapses in the absence
 *     of new events; the read path compares one stored timestamp. Synchronously
 *     re-deriving on every request was rejected for exactly the reason this
 *     avoids — it would put a second copy of the policy where it can drift.
 */

import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import type { EntitlementSourceType } from "@workspace/db/schema";

export type MembershipTier = "unregistered" | "registered" | "legendary";

/** The tier a user holds when no source qualifies. Never `unregistered`: that is an auth state, not an entitlement one. */
export const NON_QUALIFYING_TIER = "registered" as const;
export const QUALIFYING_TIER = "legendary" as const;

/**
 * Bounded grace: 14 days from the FIRST failed payment attempt of a delinquency
 * episode (David). Not from the latest attempt — an invoice with several dunning
 * retries has several failed charges, and anchoring to the latest restarts the
 * window on every retry, so a permanently failing card would never expire.
 *
 * The window's *length* lives here; resolving the episode's *start* is the
 * refresh path's job (it needs Stripe), and the deadline it computes is stored
 * on the source. This constant is not re-applied on the read path.
 */
export const GRACE_WINDOW_DAYS = 14;
export const GRACE_WINDOW_MS = GRACE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Subscription lifecycle statuses that qualify outright.
 *
 * `past_due` is deliberately absent — it qualifies only inside the grace window,
 * which is a different question and is answered separately below. `paused` is
 * the trial-ended-without-a-payment-method status, not `pause_collection`
 * (unused here), and does not qualify.
 */
const OUTRIGHT_QUALIFYING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
]);

/** The one subscription status that qualifies conditionally, on the grace deadline. */
const GRACE_BOUND_SUBSCRIPTION_STATUS = "past_due";

/** Why a source did not qualify. Reported, and used to explain a tier in admin surfaces. */
export type DisqualificationReason =
  | "not_membership_product"
  | "access_hold"
  | "dispute_loss"
  | "lifecycle"
  | "grace_expired";

/**
 * The minimum a source must expose for the derivation to judge it.
 *
 * Deliberately not the table row type: the derivation must stay callable from a
 * unit test with a hand-built object, and `hasOpenDispute` is a *query result*
 * (a non-terminal row exists in `entitlement_source_disputes`) rather than a
 * column — there is no hold flag, because two answers to "is this source held"
 * is one more than a derived model may have.
 */
export interface EntitlementSourceSnapshot {
  id: number;
  sourceType: EntitlementSourceType;
  /** Subscription or payment-intent id; null for admin grants. Identity, never re-pointed. */
  providerRef: string | null;
  /** Allowlist result. Null only for admin grants, which are authorized by W1b instead. */
  isMembershipProduct: boolean | null;
  lifecycleStatus: string;
  /** The 14-day deadline for a `past_due` episode. Null when no episode is open — or when the first attempt could not be resolved, in which case the source keeps qualifying and the case is reported. */
  graceExpiresAt: Date | null;
  /** Set once when a chargeback is lost. Permanent, and survives every subsequent provider refresh. */
  disputeLossRevokedAt: Date | null;
  /** True while a non-terminal dispute row exists for this source. */
  hasOpenDispute: boolean;
}

export interface SourceQualification {
  qualifies: boolean;
  reason?: DisqualificationReason;
  /**
   * The instant this source stops qualifying with no further events, or null for
   * "indefinitely valid". Only meaningful when `qualifies` is true.
   */
  validUntil: Date | null;
}

/**
 * Qualification is a conjunction of four independent concepts. Each is checked,
 * in order, and the first failure is the reported reason.
 *
 * Encoding only the lifecycle term — which an earlier revision of this model did
 * — makes **every active subscription qualify, including one for a product
 * outside the allowlist**, defeating the positive-allowlist boundary this whole
 * model is supposed to protect.
 */
export function qualifySource(
  source: EntitlementSourceSnapshot,
  asOf: Date,
): SourceQualification {
  // 1. Allowlist — required for BOTH Stripe source types. Admin grants qualify
  //    independently of it: they are authorized by W1b, not by a product.
  if (source.sourceType !== "admin_grant" && source.isMembershipProduct !== true) {
    return { qualifies: false, reason: "not_membership_product", validUntil: null };
  }

  // 2. Access hold — any non-terminal dispute. Preserves today's behaviour, where
  //    charge.dispute.created revokes access immediately and deliberately.
  if (source.hasOpenDispute) {
    return { qualifies: false, reason: "access_hold", validUntil: null };
  }

  // 3. Terminal dispute loss — separate from the hold because it is permanent and
  //    must survive every subsequent authoritative refresh. Folding it into the
  //    hold would let a won-then-lost sequence, or a refresh, clear a chargeback
  //    revocation.
  if (source.disputeLossRevokedAt !== null) {
    return { qualifies: false, reason: "dispute_loss", validUntil: null };
  }

  // 4. Lifecycle, per source type.
  switch (source.sourceType) {
    case "stripe_subscription": {
      if (OUTRIGHT_QUALIFYING_SUBSCRIPTION_STATUSES.has(source.lifecycleStatus)) {
        return { qualifies: true, validUntil: null };
      }
      if (source.lifecycleStatus === GRACE_BOUND_SUBSCRIPTION_STATUS) {
        // No deadline means the first failed attempt was unresolvable. The source
        // keeps qualifying and the case is reported: a guessed start can only be
        // early, and early means revoking a paying customer.
        if (source.graceExpiresAt === null) {
          return { qualifies: true, validUntil: null };
        }
        if (asOf.getTime() < source.graceExpiresAt.getTime()) {
          return { qualifies: true, validUntil: source.graceExpiresAt };
        }
        return { qualifies: false, reason: "grace_expired", validUntil: null };
      }
      return { qualifies: false, reason: "lifecycle", validUntil: null };
    }
    case "stripe_lifetime_payment":
      return source.lifecycleStatus === "active"
        ? { qualifies: true, validUntil: null }
        : { qualifies: false, reason: "lifecycle", validUntil: null };
    case "admin_grant":
      return source.lifecycleStatus === "active"
        ? { qualifies: true, validUntil: null }
        : { qualifies: false, reason: "lifecycle", validUntil: null };
  }
}

export interface DerivedMembership {
  tier: MembershipTier;
  /** Every source carrying the tier — set union, not priority. */
  qualifyingSourceIds: number[];
  /**
   * The horizon over the WHOLE qualifying set, which is what makes this
   * well-defined when a user holds more than one source:
   *
   *   - any indefinitely-valid source qualifying  -> null
   *   - only grace-bound sources                  -> the MAX of their deadlines
   *   - none qualifying                           -> null (tier already non-qualifying)
   *
   * Persisting one source's deadline instead would revoke a user who also holds
   * a lifetime entitlement that never expires.
   */
  validUntil: Date | null;
  /** Per-source disqualification reasons, for reporting. Keyed by source id. */
  reasons: Map<number, DisqualificationReason>;
}

/**
 * Set union, not priority: Legendary if ANY valid source qualifies.
 */
export function deriveEffectiveMembership(
  sources: readonly EntitlementSourceSnapshot[],
  asOf: Date,
): DerivedMembership {
  const qualifyingSourceIds: number[] = [];
  const reasons = new Map<number, DisqualificationReason>();
  let anyIndefinite = false;
  let latestDeadlineMs: number | null = null;

  for (const source of sources) {
    const result = qualifySource(source, asOf);
    if (!result.qualifies) {
      if (result.reason) reasons.set(source.id, result.reason);
      continue;
    }
    qualifyingSourceIds.push(source.id);
    if (result.validUntil === null) {
      anyIndefinite = true;
    } else {
      const ms = result.validUntil.getTime();
      if (latestDeadlineMs === null || ms > latestDeadlineMs) latestDeadlineMs = ms;
    }
  }

  if (qualifyingSourceIds.length === 0) {
    return { tier: NON_QUALIFYING_TIER, qualifyingSourceIds, validUntil: null, reasons };
  }

  return {
    tier: QUALIFYING_TIER,
    qualifyingSourceIds,
    validUntil:
      anyIndefinite || latestDeadlineMs === null ? null : new Date(latestDeadlineMs),
    reasons,
  };
}

/**
 * The read-path primitive: a SQL **expression** evaluating to the effective tier
 * for any `users` row.
 *
 * An expression, not a predicate. A predicate (`membership_tier = $1 AND not
 * expired`) is correct only at `'legendary'` — instantiate it with
 * `'registered'` and a lapsed member matches nothing, because the raw column
 * still says `legendary`, so that user falls out of *both* counts. An expiry
 * filter answers "is this user still X"; the readers ask "**what is this user's
 * tier**", and only the second question has an answer for every user.
 *
 * The `membership_tier = 'legendary'` conjunct is not redundant: without it a
 * stale horizon on an `unregistered` row would silently *promote* it to
 * `registered`. Expiry may only demote, and only from the tier the horizon
 * describes.
 *
 * @param asOf Bind this when two surfaces must agree. `now()` in PostgreSQL is
 * the TRANSACTION timestamp, so two statements in a `Promise.all` get two
 * different instants and a user crossing the horizon between them is counted
 * twice or not at all. Any claim that two effective-tier surfaces agree is
 * meaningless unless they are evaluated at the same instant.
 */
export function effectiveTierExpr(asOf?: Date): SQL<MembershipTier> {
  const instant = asOf ? sql`${asOf.toISOString()}::timestamptz` : sql`now()`;
  return sql<MembershipTier>`CASE
    WHEN ${usersTable.membershipTier} = 'legendary'
     AND ${usersTable.membershipValidUntil} IS NOT NULL
     AND ${usersTable.membershipValidUntil} <= ${instant}
    THEN 'registered'
    ELSE ${usersTable.membershipTier}
  END`;
}

/**
 * Convenience wrapper for set readers that filter on one tier. Defined FROM the
 * expression rather than hand-written per tier, so the two cannot drift.
 */
export function effectiveTierPredicate(tier: MembershipTier, asOf?: Date): SQL<boolean> {
  return sql<boolean>`${effectiveTierExpr(asOf)} = ${tier}`;
}

/** The minimum a row must carry for `effectiveTierForRow` to judge it. */
export interface MembershipRow {
  membershipTier: MembershipTier | string;
  membershipValidUntil: Date | null;
}

/**
 * The row helper, for request-path consumers that already hold a user row.
 * Defined from the same rule as `effectiveTierExpr` — expiry demotes a lapsed
 * `legendary` to `registered` and touches nothing else.
 */
export function effectiveTierForRow(row: MembershipRow, asOf: Date = new Date()): MembershipTier {
  if (
    row.membershipTier === QUALIFYING_TIER &&
    row.membershipValidUntil !== null &&
    row.membershipValidUntil.getTime() <= asOf.getTime()
  ) {
    return NON_QUALIFYING_TIER;
  }
  return row.membershipTier as MembershipTier;
}

/**
 * The row helper's fetching form, for request-path consumers holding only an id.
 * Evaluated in the database from `effectiveTierExpr`, so it cannot disagree with
 * the set readers even at the same instant.
 *
 * Returns `null` when the user does not exist — the caller decides what an
 * absent user means, rather than this helper inventing a tier for one.
 */
export async function getEffectiveMembership(
  userId: string,
  opts: { asOf?: Date } = {},
): Promise<{ tier: MembershipTier; validUntil: Date | null } | null> {
  const [row] = await db
    .select({
      tier: effectiveTierExpr(opts.asOf),
      validUntil: usersTable.membershipValidUntil,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  return row ? { tier: row.tier, validUntil: row.validUntil } : null;
}
