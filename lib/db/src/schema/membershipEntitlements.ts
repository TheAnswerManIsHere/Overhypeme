import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * The three source types a membership entitlement can come from.
 *
 * `stripe_subscription` and `stripe_lifetime_payment` are provider-backed and
 * qualify only through the product allowlist (W1a). `admin_grant` is authorized
 * locally by W1b — actor, reason, timestamp and revocation semantics — and
 * never masquerades as a payment.
 */
export const ENTITLEMENT_SOURCE_TYPES = [
  "stripe_subscription",
  "stripe_lifetime_payment",
  "admin_grant",
] as const;
export type EntitlementSourceType = (typeof ENTITLEMENT_SOURCE_TYPES)[number];

/**
 * `lifecycle_status` vocabulary, per source type. Subscriptions mirror Stripe's
 * own status union; the other two use a local vocabulary because Stripe has no
 * equivalent concept for them.
 */
export const SUBSCRIPTION_LIFECYCLE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export const LIFETIME_LIFECYCLE_STATUSES = ["active", "refunded"] as const;
export const ADMIN_GRANT_LIFECYCLE_STATUSES = ["active", "revoked"] as const;

/**
 * Stripe's `Dispute.Status` union, pinned against stripe@20.0.0
 * (`types/Disputes.d.ts`). Four of the eight are terminal.
 */
export const DISPUTE_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const TERMINAL_DISPUTE_STATUSES = [
  "won",
  "lost",
  "warning_closed",
  "prevented",
] as const satisfies readonly DisputeStatus[];

const TERMINAL_DISPUTE_SET: ReadonlySet<string> = new Set(TERMINAL_DISPUTE_STATUSES);

/** True for the four terminal Stripe dispute statuses; false for everything else. */
export function isTerminalDisputeStatus(status: string): boolean {
  return TERMINAL_DISPUTE_SET.has(status);
}

/** True only for the eight statuses this SDK version defines. */
export function isRecognisedDisputeStatus(status: string): status is DisputeStatus {
  return (DISPUTE_STATUSES as readonly string[]).includes(status);
}

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/**
 * One row per durable membership entitlement source.
 *
 * Field ownership is per (column, source type, writer) — see the plan's
 * ownership matrix. The load-bearing invariants enforced in the database rather
 * than in application code:
 *
 *   - `user_id`, `source_type`, `provider_ref` and `created_at` are **frozen**
 *     after creation (BEFORE UPDATE trigger). Nothing may repoint a source at a
 *     different Stripe object or a different user — not a refresh, not a repair
 *     script, not a migration backfill.
 *   - `dispute_loss_revoked_at` is **set-once** (same trigger). A lost chargeback
 *     disqualifies the source permanently, and no provider refresh may clear it.
 *   - At most one *active* `admin_grant` per user (partial unique index), so two
 *     concurrent grants cannot leave a second qualifying row behind a revoke.
 */
export const membershipEntitlementsTable = pgTable(
  "membership_entitlements",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** ON DELETE CASCADE — the admin purge deletes users, and entitlements go with them. */
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    sourceType: varchar("source_type", { length: 32 })
      .notNull()
      .$type<EntitlementSourceType>(),
    /** Subscription id or payment-intent id; null for admin grants. */
    providerRef: varchar("provider_ref"),
    /**
     * Allowlist result. Re-evaluated on every refresh for a subscription (it
     * describes what the user is subscribed to *now*); frozen at creation for a
     * lifetime payment (it describes what was bought). Null only for admin
     * grants, which qualify through W1b instead.
     */
    isMembershipProduct: boolean("is_membership_product"),
    lifecycleStatus: varchar("lifecycle_status", { length: 32 }).notNull(),
    /** Subscription-only: the price/product identifier `subscriptions.plan` carried. */
    plan: varchar("plan"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end"),
    /** Payment-backed only. Deliberately absent for subscriptions — see the matrix. */
    amount: integer("amount"),
    currency: varchar("currency"),
    graceStartedAt: timestamp("grace_started_at", { withTimezone: true }),
    graceExpiresAt: timestamp("grace_expires_at", { withTimezone: true }),
    /** Set once by the dispute-transition path; never cleared. */
    disputeLossRevokedAt: timestamp("dispute_loss_revoked_at", { withTimezone: true }),
    /** W1b grant provenance. The label, not the id, is what the CHECK requires. */
    grantedByAdminId: varchar("granted_by_admin_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    grantedByAdminLabel: text("granted_by_admin_label"),
    grantReason: text("grant_reason"),
    /** W1b revocation provenance. */
    revokedByAdminId: varchar("revoked_by_admin_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    revokedByAdminLabel: text("revoked_by_admin_label"),
    revokedReason: text("revoked_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * The ordering token — allocated from `membership_source_state_seq`, never
     * from a wall clock. Defence in depth behind the per-source lease and its
     * fence, not the fence itself.
     */
    sourceStateAsOf: bigint("source_state_as_of", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Advanced by the BEFORE UPDATE trigger, not by `$onUpdate` — the ownership
     * matrix says "every writer advances it by protocol", and a protocol no
     * mechanism enforces is the failure shape this model exists to remove.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_membership_entitlements_user_id").on(table.userId),
    uniqueIndex("uq_membership_entitlements_provider_ref")
      .on(table.sourceType, table.providerRef)
      .where(sql`provider_ref IS NOT NULL`),
    uniqueIndex("uq_membership_entitlements_active_admin_grant")
      .on(table.userId)
      .where(sql`source_type = 'admin_grant' AND lifecycle_status = 'active'`),
    check(
      "membership_entitlements_source_type_valid",
      sql.raw(`source_type IN (${sqlList(ENTITLEMENT_SOURCE_TYPES)})`),
    ),
    // Payment-backed rows carry a provider reference; admin grants never do.
    check(
      "membership_entitlements_provider_ref_shape",
      sql.raw(
        `(source_type = 'admin_grant' AND provider_ref IS NULL)` +
          ` OR (source_type <> 'admin_grant' AND provider_ref IS NOT NULL)`,
      ),
    ),
    // No fail-open default: the allowlist answer is written explicitly for both
    // Stripe source types, and is inapplicable for admin grants.
    check(
      "membership_entitlements_allowlist_shape",
      sql.raw(
        `(source_type = 'admin_grant' AND is_membership_product IS NULL)` +
          ` OR (source_type <> 'admin_grant' AND is_membership_product IS NOT NULL)`,
      ),
    ),
    check(
      "membership_entitlements_lifecycle_status_valid",
      sql.raw(
        `(source_type = 'stripe_subscription'` +
          ` AND lifecycle_status IN (${sqlList(SUBSCRIPTION_LIFECYCLE_STATUSES)}))` +
          ` OR (source_type = 'stripe_lifetime_payment'` +
          ` AND lifecycle_status IN (${sqlList(LIFETIME_LIFECYCLE_STATUSES)}))` +
          ` OR (source_type = 'admin_grant'` +
          ` AND lifecycle_status IN (${sqlList(ADMIN_GRANT_LIFECYCLE_STATUSES)}))`,
      ),
    ),
    // W1b: an admin grant records actor and reason. The *label* is required, not
    // the id — purging the granting admin nulls a convenience join and leaves the
    // attribution intact.
    check(
      "membership_entitlements_grant_provenance",
      sql.raw(
        `source_type <> 'admin_grant'` +
          ` OR (granted_by_admin_label IS NOT NULL AND grant_reason IS NOT NULL)`,
      ),
    ),
    // W1b's revocation clause: a revoked grant cannot reach that state with null
    // provenance.
    check(
      "membership_entitlements_revoke_provenance",
      sql.raw(
        `NOT (source_type = 'admin_grant' AND lifecycle_status = 'revoked')` +
          ` OR (revoked_by_admin_label IS NOT NULL AND revoked_reason IS NOT NULL` +
          ` AND revoked_at IS NOT NULL)`,
      ),
    ),
    // Subscription-only and payment-only columns stay null elsewhere, so a
    // reader cannot find a plausible-looking value on a source that never had one.
    check(
      "membership_entitlements_subscription_only_columns",
      sql.raw(
        `source_type = 'stripe_subscription'` +
          ` OR (plan IS NULL AND current_period_end IS NULL` +
          ` AND cancel_at_period_end IS NULL AND grace_started_at IS NULL` +
          ` AND grace_expires_at IS NULL)`,
      ),
    ),
    check(
      "membership_entitlements_amount_shape",
      sql.raw(
        `source_type = 'stripe_lifetime_payment' OR (amount IS NULL AND currency IS NULL)`,
      ),
    ),
    // The grace window is an episode: both ends are set together or neither is.
    check(
      "membership_entitlements_grace_window_paired",
      sql.raw(
        `(grace_started_at IS NULL AND grace_expires_at IS NULL)` +
          ` OR (grace_started_at IS NOT NULL AND grace_expires_at IS NOT NULL)`,
      ),
    ),
    // W1b provenance belongs to admin grants and nowhere else.
    check(
      "membership_entitlements_grant_provenance_scope",
      sql.raw(
        `source_type = 'admin_grant'` +
          ` OR (granted_by_admin_id IS NULL AND granted_by_admin_label IS NULL` +
          ` AND grant_reason IS NULL)`,
      ),
    ),
    // Revocation provenance appears only on a row that is actually revoked. A
    // re-grant after a revoke is a new row, so an active grant never
    // legitimately carries a stale revocation timestamp.
    check(
      "membership_entitlements_revoke_provenance_scope",
      sql.raw(
        `(source_type = 'admin_grant' AND lifecycle_status = 'revoked')` +
          ` OR (revoked_by_admin_id IS NULL AND revoked_by_admin_label IS NULL` +
          ` AND revoked_reason IS NULL AND revoked_at IS NULL)`,
      ),
    ),
  ],
);

export type MembershipEntitlement = typeof membershipEntitlementsTable.$inferSelect;
export type InsertMembershipEntitlement = typeof membershipEntitlementsTable.$inferInsert;

/**
 * One row per (source, dispute), ever — `stripe_dispute_id` is the primary key,
 * which is what makes a late `charge.dispute.created` an upsert rather than a
 * re-open.
 *
 * A source is *held* while a row exists for it with a non-terminal status. The
 * hold is this query and nothing else: there is no hold column and no reason
 * column, because two answers to "is this source held" is one more than a
 * derived model may have.
 *
 * `is_terminal` is **absorbing**, enforced by a conditional upsert plus a
 * BEFORE UPDATE trigger. A CHECK cannot express it — a CHECK validates only the
 * row being proposed, and ('needs_response', false) is a perfectly consistent
 * new row.
 */
export const entitlementSourceDisputesTable = pgTable(
  "entitlement_source_disputes",
  {
    stripeDisputeId: varchar("stripe_dispute_id").primaryKey(),
    sourceId: integer("source_id").notNull(),
    status: varchar("status", { length: 32 }).notNull().$type<DisputeStatus>(),
    isTerminal: boolean("is_terminal").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // Named explicitly: Drizzle's derived name for this FK would exceed
    // PostgreSQL's 63-character identifier limit and be silently truncated, so
    // the migration's "does this constraint already exist" guard could not match
    // it and would add a second, duplicate FK on top of the pushed one.
    foreignKey({
      name: "entitlement_source_disputes_source_id_fk",
      columns: [table.sourceId],
      foreignColumns: [membershipEntitlementsTable.id],
    }).onDelete("cascade"),
    index("idx_entitlement_source_disputes_source_id").on(table.sourceId),
    // Makes the qualification path's "is this source held" a cheap existence check.
    index("idx_entitlement_source_disputes_open")
      .on(table.sourceId)
      .where(sql`NOT is_terminal`),
    // Constrains status to the enumerated eight. Without this an unrecognised
    // status classifies as non-terminal, agrees with is_terminal = false, passes,
    // and then holds the source indefinitely because no transition knows how to
    // resolve it.
    check(
      "entitlement_source_disputes_status_valid",
      sql.raw(`status IN (${sqlList(DISPUTE_STATUSES)})`),
    ),
    // Consistency, not transition: is_terminal agrees with status on this row.
    check(
      "entitlement_source_disputes_terminal_consistent",
      sql.raw(`is_terminal = (status IN (${sqlList(TERMINAL_DISPUTE_STATUSES)}))`),
    ),
  ],
);

export type EntitlementSourceDispute = typeof entitlementSourceDisputesTable.$inferSelect;
export type InsertEntitlementSourceDispute =
  typeof entitlementSourceDisputesTable.$inferInsert;

/**
 * Leases, keyed by an opaque scope string.
 *
 * One user today: per-source leases, `source:<source_type>:<provider_ref>`, held
 * across a Stripe retrieval so exactly one retrieval-and-apply is in flight per
 * source. Claimed in a short transaction that commits immediately, so the
 * retrieval itself runs with no transaction open.
 *
 * The scope is an opaque string rather than a foreign key precisely so a second
 * kind of lease can join without a migration — the deferred reconciliation run
 * lease being the concrete case.
 *
 * `fence` comes from `membership_lease_fence_seq`, fresh on every acquisition
 * including one that steals an expired lease. The apply transaction re-reads
 * this row `FOR UPDATE` and requires holder, fence and expiry to still match;
 * the row lock, not the TTL, is what makes ownership and write atomic.
 */
export const membershipLeasesTable = pgTable(
  "membership_leases",
  {
    scope: varchar("scope", { length: 200 }).primaryKey(),
    /** Opaque holder identity — process/run id. Compared, never parsed. */
    holder: varchar("holder", { length: 200 }).notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    /** Advanced by the heartbeat for the run lease; fixed at acquisition for source leases. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_membership_leases_expires_at").on(table.expiresAt)],
);

export type MembershipLease = typeof membershipLeasesTable.$inferSelect;
