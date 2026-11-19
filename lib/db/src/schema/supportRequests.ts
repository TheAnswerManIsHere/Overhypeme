/**
 * @purpose The permanent record of every support request the contact page accepts (launch Phase 16, increment 5; plan amendment 3, David's Q17: 1): the Resend inbox is where requests are read and answered, and keeps mail 30 days, so each request is also written here. Append-only.
 * @subsystem operations
 */
import { pgTable, serial, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * One support request, as the visitor sent it. Insert-only; no update and no
 * soft-delete. A deleted account's requests go with it (David, Q19: 1): the
 * account purge deletes those it sent and those sent from its address, and the
 * cascade covers the rest.
 */
export const supportRequestsTable = pgTable("support_requests", {
  id: serial("id").primaryKey(),
  /** The address the visitor asked to be answered at (the inbox's reply-to). */
  email: varchar("email", { length: 320 }).notNull(),
  /** One of SUPPORT_CATEGORIES; a CHECK in the migration keeps it so. */
  category: varchar("category", { length: 20 }).notNull(),
  message: text("message").notNull(),
  /** The signed-in account, when there was a session. */
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  /** The account's state when it wrote (eligible, suspended, unverified, unonboarded, deletion_pending). */
  accountState: varchar("account_state", { length: 20 }),
  /** Whether the request reached the inbox's send queue: 'queued' or 'failed'. */
  inboxDelivery: varchar("inbox_delivery", { length: 10 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_support_requests_created").on(table.createdAt),
  index("idx_support_requests_user").on(table.userId),
]);

export type SupportRequest = typeof supportRequestsTable.$inferSelect;

/** The categories the contact page offers. Kept in sync with the SQL CHECK constraint. */
export const SUPPORT_CATEGORIES = ["account", "billing", "bug", "content", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
