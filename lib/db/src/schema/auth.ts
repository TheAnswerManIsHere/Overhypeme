import { sql } from "drizzle-orm";
import { boolean, index, jsonb, numeric, pgTable, pgEnum, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const membershipTierEnum = pgEnum("membership_tier", ["unregistered", "registered", "legendary"]);

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
  googleLinked: boolean("google_linked").notNull().default(false),
  appleLinked: boolean("apple_linked").notNull().default(false),
  captchaVerified: boolean("captcha_verified").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  adminNotifications: boolean("admin_notifications").notNull().default(true),
  disputeNotifications: boolean("dispute_notifications").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  stripeCustomerId: varchar("stripe_customer_id").unique(),
  membershipTier: membershipTierEnum("membership_tier").notNull().default("registered"),
  avatarStyle: varchar("avatar_style", { length: 30 }).default("bottts"),
  avatarSource: varchar("avatar_source", { length: 10 }).default("avatar"),
  pronouns: varchar("pronouns", { length: 80 }).default("he/him"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  monthlyGenerationLimitOverrideUsd: numeric("monthly_generation_limit_override_usd", { precision: 10, scale: 4 }),
  // When true, NSFW-classified uploads/outputs are accepted and tagged
  // with `is_nsfw` instead of rejected. Plumbed for future tier-gating;
  // downstream surfaces (feed/discovery) do not yet consume it.
  nsfwModeEnabled: boolean("nsfw_mode_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
// userId is nullable — guest/anonymous sessions have no associated user.
// ON DELETE CASCADE: deleting a user automatically removes all their sessions.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
    userId: varchar("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("IDX_session_expire").on(table.expire),
    index("IDX_session_user_id").on(table.userId),
  ],
);

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

// Persists OAuth PKCE state across server restarts so that a restart mid-flow
// does not cause an infinite redirect loop back to the provider.
export const oauthPendingStatesTable = pgTable(
  "oauth_pending_states",
  {
    state: varchar("state").primaryKey(),
    codeVerifier: text("code_verifier").notNull(),
    nonce: text("nonce").notNull(),
    returnTo: text("return_to").notNull().default("/"),
    isPopup: boolean("is_popup").notNull().default(false),
    // When set, the callback links the OAuth provider to this existing user
    // instead of creating/logging-in a new session.
    linkUserId: varchar("link_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("IDX_oauth_pending_states_expires_at").on(table.expiresAt)],
);
