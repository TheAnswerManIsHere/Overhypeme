import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/** The stages a deletion request moves through, each reached only from the one before (plan S14). */
export const ACCOUNT_DELETION_STAGES = ["accepted", "subscription_cancelled", "notified", "held", "purging", "done"] as const;
export type AccountDeletionStage = (typeof ACCOUNT_DELETION_STAGES)[number];

/** Who asked: the person, an admin, or the worker for a sign-up never finished (David's answer 6). */
export const ACCOUNT_DELETION_REQUESTERS = ["self", "admin", "unonboarded"] as const;
export type AccountDeletionRequester = (typeof ACCOUNT_DELETION_REQUESTERS)[number];

/**
 * One row per account asked to be deleted (launch Phase 5, 0117). Every
 * transition belongs to `lib/accountDeletion.ts`. A request is active while
 * `cancelled_at` is null and `stage` is not `done`; while it is, the owner's
 * content is not live (`lib/contentVisibility.ts`).
 */
export const accountDeletionRequestsTable = pgTable("account_deletion_requests", {
  userId: varchar("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  /**
   * The request's generation: every stage change is fenced to it, so a cancel
   * and re-request (the same row rewritten) can never be advanced by work
   * decided for the old one. Always written by the engine from JavaScript, so
   * it round-trips exactly; the default is only a backstop.
   */
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  /** When the destructive stage may run: 14 days after the request, or now for an admin's purge-now. */
  purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
  requestedBy: varchar("requested_by", { length: 16 }).notNull().$type<AccountDeletionRequester>(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  stage: varchar("stage", { length: 24 }).notNull().default("accepted").$type<AccountDeletionStage>(),
  stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Why the purge is held (an open billing dispute); admin-visible only. */
  holdReason: text("hold_reason"),
  /** The last stage failure, for the admin panel; cleared when a stage succeeds. */
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  /** True from the first Stripe cancel until every source is refreshed; survives a cancel (the worker settles it). */
  billingUnsettled: boolean("billing_unsettled").notNull().default(false),
  /** Bumped before the cancels and after each returns; a settlement clears the flag only at the version it read first. */
  billingVersion: integer("billing_version").notNull().default(0),
}, (t) => [
  check("account_deletion_requests_stage_check", sql`${t.stage} IN ('accepted', 'subscription_cancelled', 'notified', 'held', 'purging', 'done')`),
  check("account_deletion_requests_requested_by_check", sql`${t.requestedBy} IN ('self', 'admin', 'unonboarded')`),
]);

export type AccountDeletionRequest = typeof accountDeletionRequestsTable.$inferSelect;
