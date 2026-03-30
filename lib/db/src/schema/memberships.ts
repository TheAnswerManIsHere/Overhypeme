import { pgTable, varchar, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

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
