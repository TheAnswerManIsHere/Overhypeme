import { pgTable, varchar, timestamp, integer, boolean, text, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// App-level subscriptions table — tracks Stripe subscription lifecycle for each user
export const subscriptionsTable = pgTable("subscriptions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => usersTable.id),
  stripeSubscriptionId: varchar("stripe_subscription_id").notNull().unique(),
  stripeCustomerId: varchar("stripe_customer_id").notNull(),
  plan: varchar("plan").notNull(),
  status: varchar("status").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Subscription = typeof subscriptionsTable.$inferSelect;
export type InsertSubscription = typeof subscriptionsTable.$inferInsert;

// Lifetime entitlements table — durable record of one-time lifetime purchases
export const lifetimeEntitlementsTable = pgTable("lifetime_entitlements", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => usersTable.id),
  stripePaymentIntentId: varchar("stripe_payment_intent_id").notNull().unique(),
  stripeCustomerId: varchar("stripe_customer_id").notNull(),
  amount: integer("amount"),
  currency: varchar("currency").default("usd"),
  // 'active' (default) or 'refunded' — set to 'refunded' when a charge.refunded event
  // is received for this payment intent. Kept for audit trail; never deleted.
  status: varchar("status").notNull().default("active"),
  // Set for admin-granted lifetime memberships; null for self-purchased ones.
  grantedByAdminId: varchar("granted_by_admin_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LifetimeEntitlement = typeof lifetimeEntitlementsTable.$inferSelect;
export type InsertLifetimeEntitlement = typeof lifetimeEntitlementsTable.$inferInsert;

export const membershipHistoryTable = pgTable("membership_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => usersTable.id),
  event: varchar("event").notNull(),
  plan: varchar("plan"),
  amount: integer("amount"),
  currency: varchar("currency").default("usd"),
  stripePaymentIntentId: varchar("stripe_payment_intent_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  stripeInvoiceId: varchar("stripe_invoice_id"),
  stripeDisputeId: varchar("stripe_dispute_id"),
  performedByAdminId: varchar("performed_by_admin_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_membership_history_user_id").on(table.userId),
]);

export type MembershipHistory = typeof membershipHistoryTable.$inferSelect;
export type InsertMembershipHistory = typeof membershipHistoryTable.$inferInsert;

export const stripeProcessedEventsTable = pgTable("stripe_processed_events", {
  eventId: text("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StripeProcessedEvent = typeof stripeProcessedEventsTable.$inferSelect;

export const stripeWebhookAuditTable = pgTable("stripe_webhook_audit", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  state: varchar("state").notNull(), // received | processed | ignored_duplicate | failed
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_stripe_webhook_audit_event_id").on(table.eventId),
  index("idx_stripe_webhook_audit_created_at").on(table.createdAt),
]);

export const stripeCheckoutRequestLedgerTable = pgTable("stripe_checkout_request_ledger", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => usersTable.id),
  priceId: varchar("price_id").notNull(),
  requestKey: varchar("request_key").notNull().unique(),
  sessionId: varchar("session_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_checkout_request_ledger_user_id").on(table.userId),
]);
