import { pgTable, varchar, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const emailOutboxTable = pgTable(
  "email_outbox",
  {
    id:            integer("id").primaryKey().generatedAlwaysAsIdentity(),
    to:            varchar("to", { length: 320 }).notNull(),
    subject:       varchar("subject", { length: 998 }).notNull(),
    text:          text("text").notNull(),
    html:          text("html"),
    kind:          varchar("kind", { length: 64 }),
    status:        varchar("status", { length: 20 }).notNull().default("pending"),
    attempts:      integer("attempts").notNull().default(0),
    maxAttempts:   integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError:     text("last_error"),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_outbox_pending_idx").on(t.nextAttemptAt).where(sql`status = 'pending'`),
  ],
);

export type EmailOutboxRow = typeof emailOutboxTable.$inferSelect;
export type InsertEmailOutboxRow = typeof emailOutboxTable.$inferInsert;
