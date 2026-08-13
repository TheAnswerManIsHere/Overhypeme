import { pgTable, varchar, boolean, timestamp, primaryKey, serial, integer, text, bigint, jsonb, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";

export const featureFlagsTable = pgTable("feature_flags", {
  key: varchar("key", { length: 100 }).primaryKey(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  description: varchar("description", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FeatureFlag = typeof featureFlagsTable.$inferSelect;
export type InsertFeatureFlag = typeof featureFlagsTable.$inferInsert;

export const tierFeaturePermissionsTable = pgTable("tier_feature_permissions", {
  tier: varchar("tier", { length: 50 }).notNull(),
  featureKey: varchar("feature_key", { length: 100 }).notNull().references(() => featureFlagsTable.key, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tier, t.featureKey] }),
}));

export type TierFeaturePermission = typeof tierFeaturePermissionsTable.$inferSelect;
export type InsertTierFeaturePermission = typeof tierFeaturePermissionsTable.$inferInsert;

/**
 * Append-only audit trail for grid mutations. `setTierFeature` previously
 * recorded only `updated_at` — no actor, no prior value — so a cell change was
 * unattributable after the fact.
 *
 * `feature_key` is deliberately plain text with NO foreign key. A live FK would
 * either block feature deletion once any audit row referenced it (NO ACTION) or
 * destroy the history along with the feature (CASCADE) — both wrong for an
 * append-only history table. It is a denormalized historical fact, the same
 * reasoning `actor_id`'s ON DELETE SET NULL applies to the actor: the record
 * must survive its referent.
 */
export const tierFeaturePermissionAuditTable = pgTable("tier_feature_permission_audit", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  tier: varchar("tier", { length: 50 }).notNull(),
  featureKey: varchar("feature_key", { length: 100 }).notNull(),
  enabledBefore: boolean("enabled_before"),
  enabledAfter: boolean("enabled_after").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Must match migration 0099's raw-SQL index exactly (same name, same
  // column) — drizzle-kit push reconciles the live DB against this schema,
  // not against migration history, so an index the migration created but
  // this declaration omits reads as drift and gets silently dropped on the
  // next push. Round 3 of PR #425's review caught this.
  index("tier_feature_permission_audit_created_at_idx").on(t.createdAt),
]);

export type TierFeaturePermissionAudit = typeof tierFeaturePermissionAuditTable.$inferSelect;
export type InsertTierFeaturePermissionAudit = typeof tierFeaturePermissionAuditTable.$inferInsert;

/**
 * Singleton revision counter — the client contract's version source.
 *
 * A second row is rejected by the primary key and a wrong-keyed row by the
 * CHECK. The bump (`UPDATE ... SET revision = revision + 1 WHERE id = 1`) is
 * issued inside each grid write's transaction; being a single-row update,
 * concurrent writers serialize on the row lock and cannot produce the same
 * revision.
 *
 * Making the bump unskippable is Plan 1b's scope (PR #422). Until it ships the
 * invariant holds because `featureAccess.ts` is the only writer — a convention,
 * not a boundary.
 */
export const entitlementGridRevisionTable = pgTable("entitlement_grid_revision", {
  id: integer("id").primaryKey().default(1),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
}, (t) => [
  check("entitlement_grid_revision_singleton", sql`${t.id} = 1`),
]);

export type EntitlementGridRevision = typeof entitlementGridRevisionTable.$inferSelect;

/**
 * The grid backfill's observable outcome.
 *
 * The canonical migration runner (`lib/db/src/migrate.ts`) ignores statement
 * result rows, installs no notice handler, and skips an already-applied
 * migration by hash rather than re-executing it — so an in-migration SELECT or
 * RAISE NOTICE is invisible on a normal run. The counts go somewhere durable
 * instead.
 *
 * Three separate counts, because the three outcomes answer different questions
 * and a combined number answers neither: how much drift was repaired, whether
 * the database was clean going in, and whether the deliberate
 * `engine_experiments` exception was honoured.
 */
export const featurePermissionsMigrationLogTable = pgTable("feature_permissions_migration_log", {
  id: serial("id").primaryKey(),
  migrationName: varchar("migration_name", { length: 200 }).notNull(),
  insertedCount: integer("inserted_count").notNull().default(0),
  alreadyCompleteCount: integer("already_complete_count").notNull().default(0),
  engineExperimentsSkippedCount: integer("engine_experiments_skipped_count").notNull().default(0),
  /** The `meme_upload_photo` rows captured before deletion, so recovery is answerable from the database. */
  deletedRows: jsonb("deleted_rows"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FeaturePermissionsMigrationLog = typeof featurePermissionsMigrationLogTable.$inferSelect;
