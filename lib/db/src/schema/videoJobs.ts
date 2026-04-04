import { pgTable, serial, integer, text, varchar, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { factsTable } from "./facts";

export const videoJobStatusEnum = pgEnum("video_job_status", ["pending", "completed", "failed"]);

export const videoJobsTable = pgTable("video_jobs", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  imageUrl: text("image_url").notNull(),
  videoUrl: text("video_url"),
  falRequestId: text("fal_request_id"),
  status: videoJobStatusEnum("status").notNull().default("pending"),
  ipAddress: varchar("ip_address", { length: 45 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("video_jobs_fact_id_idx").on(table.factId),
  index("video_jobs_ip_address_idx").on(table.ipAddress),
  index("video_jobs_created_at_idx").on(table.createdAt),
]);

export type VideoJob = typeof videoJobsTable.$inferSelect;
