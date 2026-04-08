import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, pgEnum, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const membershipTierEnum = pgEnum("membership_tier", ["unregistered", "registered", "legendary"]);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const usersTable = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  pendingEmail: varchar("pending_email"),
  // Used for billing (Stripe customer name on invoices) and order fulfillment
  // (Zazzle shipping/personalization). Distinct from displayName, which is a
  // public-facing display alias. These should reflect the user's legal name.
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  displayName: varchar("display_name"),
  profileImageUrl: varchar("profile_image_url"),
  passwordHash: varchar("password_hash"),
  captchaVerified: boolean("captcha_verified").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  stripeCustomerId: varchar("stripe_customer_id").unique(),
  membershipTier: membershipTierEnum("membership_tier").notNull().default("unregistered"),
  avatarStyle: varchar("avatar_style", { length: 30 }).default("bottts"),
  avatarSource: varchar("avatar_source", { length: 10 }).default("avatar"),
  pronouns: varchar("pronouns", { length: 80 }).default("he/him"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

export const emailVerificationTokensTable = pgTable(
  "email_verification_tokens",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    pendingEmail: varchar("pending_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("IDX_evt_token_hash").on(table.tokenHash)],
);

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("IDX_prt_token_hash").on(table.tokenHash)],
);
