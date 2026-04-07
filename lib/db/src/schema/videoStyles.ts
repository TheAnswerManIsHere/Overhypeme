import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const videoStylesTable = pgTable("video_styles", {
  id: varchar("id", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 128 }).notNull(),
  description: text("description").notNull().default(""),
  motionPrompt: text("motion_prompt").notNull().default(""),
  gradientFrom: varchar("gradient_from", { length: 32 }).notNull().default("#000000"),
  gradientTo: varchar("gradient_to", { length: 32 }).notNull().default("#333333"),
  previewGifPath: text("preview_gif_path"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VideoStyle = typeof videoStylesTable.$inferSelect;
