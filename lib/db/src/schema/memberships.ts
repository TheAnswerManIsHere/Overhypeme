import { pgTable, varchar, timestamp, integer, boolean } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MembershipHistory = typeof membershipHistoryTable.$inferSelect;
export type InsertMembershipHistory = typeof membershipHistoryTable.$inferInsert;
