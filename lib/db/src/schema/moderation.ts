import {
  bigserial,
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  varchar,
  integer,
} from "drizzle-orm/pg-core";
import { isNull, sql } from "drizzle-orm";
import { usersTable } from "./auth";
import { memesTable } from "./memes";

/**
 * Quarantine ledger. Separated from `memes` so we can record holds that
 * happen *before* a meme row exists (failed Arachnid scan on upload, fal
 * safety trip during generation, classifier reject). Rows are soft-deleted
 * only — preservation rules are enforced via {@link ncmecReportsTable}.
 */
export const quarantinedMemesTable = pgTable("quarantined_memes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  memeId: integer("meme_id").references(() => memesTable.id, { onDelete: "set null" }),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Object-storage path under the `restricted/quarantine/...` prefix. Never publicly served. */
  evidenceObjectPath: text("evidence_object_path").notNull(),
  /** Which check produced the hit. */
  source: varchar("source", { length: 20 }).notNull(),
  /** Match precision when `source = 'arachnid'`. */
  matchType: varchar("match_type", { length: 10 }),
  /** Vendor classification label when applicable. */
  classification: varchar("classification", { length: 40 }),
  classifierScore: numeric("classifier_score", { precision: 6, scale: 4 }),
  classifierModel: text("classifier_model"),
  /** Full vendor payload for audit. */
  rawResponse: jsonb("raw_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete tombstone. Live rows have NULL. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("IDX_quarantined_user_created").on(t.userId, t.createdAt.desc()),
  index("IDX_quarantined_source_created").on(t.source, t.createdAt.desc()),
  index("IDX_quarantined_live").on(t.id).where(isNull(t.deletedAt)),
]);

export type QuarantinedMeme = typeof quarantinedMemesTable.$inferSelect;
export type InsertQuarantinedMeme = typeof quarantinedMemesTable.$inferInsert;

/**
 * NCMEC CyberTipline report ledger. Real submission is out-of-band (operator
 * task); this table stubs the interface so the future submission worker is
 * a drop-in. Rows hold the evidence path that legal preservation (US 18 USC
 * § 2258A) requires us to keep for ≥90 days.
 */
export const ncmecReportsTable = pgTable("ncmec_reports", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Tipline report id once real submission lands. NULL while `pending`. */
  reportId: varchar("report_id", { length: 64 }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  /** Which signal triggered the report. `arachnid` matches are always reported; `classifier` reports are gated by config. */
  matchSource: varchar("match_source", { length: 16 }).notNull(),
  /** Path to preserved evidence in the restricted prefix. Must NOT be publicly readable. */
  evidenceUri: text("evidence_uri").notNull(),
  /** Earliest moment the evidence may be deleted (default now() + 90 days). */
  evidenceRetentionUntil: timestamp("evidence_retention_until", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '90 days'`),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  requestMetadata: jsonb("request_metadata"),
  submissionStatus: varchar("submission_status", { length: 16 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_ncmec_status_created").on(t.submissionStatus, t.createdAt),
]);

export type NcmecReport = typeof ncmecReportsTable.$inferSelect;
export type InsertNcmecReport = typeof ncmecReportsTable.$inferInsert;

/** Legal moderation source values. Keep in lockstep with the SQL CHECK constraint in 0043. */
export const QUARANTINE_SOURCES = ["arachnid", "fal_safety", "classifier", "manual"] as const;
export type QuarantineSource = typeof QUARANTINE_SOURCES[number];

export const NCMEC_MATCH_SOURCES = ["arachnid", "classifier"] as const;
export type NcmecMatchSource = typeof NCMEC_MATCH_SOURCES[number];

export const NCMEC_SUBMISSION_STATUSES = ["pending", "submitted", "failed"] as const;
export type NcmecSubmissionStatus = typeof NCMEC_SUBMISSION_STATUSES[number];

/** Meme moderation lifecycle. Mirrors the CHECK constraint in 0043. */
export const MEME_STATUSES = ["live", "quarantined", "rejected"] as const;
export type MemeStatus = typeof MEME_STATUSES[number];
