import { pgTable, serial, integer, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Polymorphic reactions table backing all up/down/heart tracking across the
 * product. Replaces the per-target `ratings` table for fact thumbs and is the
 * sole home for new meme/comment heart reactions.
 *
 * `target_type` is a free-form text column (not a Postgres enum) for cheap
 * forward-compat as new reactable surfaces are added.
 */
export const reactionsTable = pgTable(
  "reactions",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 16 }).notNull(),
    targetId: integer("target_id").notNull(),
    reactionType: varchar("reaction_type", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("UQ_reactions_user_target_type").on(t.userId, t.targetType, t.targetId, t.reactionType),
    index("IDX_reactions_target").on(t.targetType, t.targetId),
    index("IDX_reactions_user").on(t.userId),
  ],
);

export type Reaction = typeof reactionsTable.$inferSelect;
export type InsertReaction = typeof reactionsTable.$inferInsert;

export type ReactionTargetType = "fact" | "meme" | "comment";
export type ReactionType = "up" | "down" | "heart";
