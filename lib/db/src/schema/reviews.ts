import { pgTable, text, serial, timestamp, varchar, integer, jsonb, pgEnum, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

export const reviewStatusEnum = pgEnum("review_status", ["pending", "approved", "rejected"]);
export const reviewReasonEnum = pgEnum("review_reason", ["duplicate", "spam", "offensive", "lame", "visual"]);

// Fine-grained two-gate moderation lifecycle (see @workspace/api-zod
// moderationWorkflow). The labels here MUST stay in sync with
// REVIEW_WORKFLOW_STAGE_VALUES.
export const reviewWorkflowStageEnum = pgEnum("review_workflow_stage", [
  "triage_pending",
  "triage_rejected",
  "prep_pending",
  "prep_failed",
  "concept_review",
  "production_review",
  "production_rejected",
  "production_approved",
]);

export const pendingReviewsTable = pgTable("pending_reviews", {
  id: serial("id").primaryKey(),
  submittedText: text("submitted_text").notNull(),
  submittedById: varchar("submitted_by_id").references(() => usersTable.id),
  /** When the submitter deleted their account (0119): carried onto the fact an approval creates, so it stays credited to a former member. */
  submitterDeletedAt: timestamp("submitter_deleted_at", { withTimezone: true }),
  matchingFactId: integer("matching_fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  matchingSimilarity: integer("matching_similarity").notNull().default(0),
  /**
   * The server's duplicate check of the CURRENT wording (0149): "duplicate" |
   * "distinct" | "unavailable"; null = not checked. Written only by
   * lib/duplicateVerdict.ts, and only while the wording it checked is still the
   * wording. Never inferred from matchingSimilarity.
   */
  duplicateOutcome: varchar("duplicate_outcome", { length: 16 }).$type<"duplicate" | "distinct" | "unavailable">(),
  /** The other pending review an exact match found (null when the match is a fact). */
  matchingReviewId: integer("matching_review_id").references((): AnyPgColumn => pendingReviewsTable.id, { onDelete: "set null" }),
  duplicateCheckedAt: timestamp("duplicate_checked_at", { withTimezone: true }),
  hashtags: jsonb("hashtags").$type<string[]>().default([]),
  /** Visual-taxonomy enrichment blob (FactEnrichment from @workspace/api-zod). Null until the async enrichment job writes it. */
  enrichment: jsonb("enrichment"),
  /** Enrichment lifecycle for the admin UI: "pending" | "ok" | "failed". Null before the job starts. */
  enrichmentStatus: varchar("enrichment_status", { length: 16 }),
  status: reviewStatusEnum("status").notNull().default("pending"),
  /**
   * Fine-grained two-gate lifecycle stage. `status` stays as the coarse bucket;
   * this drives provisional vs production gates and the moderation UI. New rows
   * start at "triage_pending" (cheap human triage, no paid prep work).
   */
  workflowStage: reviewWorkflowStageEnum("workflow_stage").notNull().default("triage_pending"),
  /**
   * The inactive (isActive=false) staging fact created at provisional approval.
   * All production-prep tooling (enrichment, CPP, test memes, override
   * editing) runs against this factId; production approval flips it active.
   */
  stagingFactId: integer("staging_fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  reason: reviewReasonEnum("reason"),
  adminNote: text("admin_note"),
  reviewedById: varchar("reviewed_by_id").references(() => usersTable.id),
  approvedFactId: integer("approved_fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  // Production-rejection audit (reject after prep has begun).
  productionRejectedAt: timestamp("production_rejected_at", { withTimezone: true }),
  productionRejectedById: varchar("production_rejected_by_id").references(() => usersTable.id),
  productionRejectionNote: text("production_rejection_note"),
  /**
   * Audit record written when a moderator approves for production despite one or
   * more required visual-render scenarios being missing/running/failed/blocked/
   * stale (admin-waivable gate). Null = no waiver was needed. Shape
   * (VisualRenderApprovalWaiver) is validated server-side before write; see
   * factRenderScenarios.ts. Kept here (not on the attempt) so the approval
   * decision and its waiver live together.
   */
  visualRenderApprovalWaiver: jsonb("visual_render_approval_waiver"),
  /**
   * The wording as submitted, kept when an admin edits it at triage (migration
   * 0141, plan PLAN_THREE_GAGS.md increment 3). Null when it was never edited.
   */
  submittedTextOriginal: text("submitted_text_original"),
  /** Who last edited the wording at triage, and when (migration 0141). */
  wordingEditedBy: varchar("wording_edited_by").references(() => usersTable.id, { onDelete: "set null" }),
  wordingEditedAt: timestamp("wording_edited_at", { withTimezone: true }),
  /**
   * Withdraw: wording needs replacing (migration 0141). Set once, when a
   * moderator ends a submission past triage whose wording is wrong; the review
   * is terminal and its staging fact can never go live.
   */
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnBy: varchar("withdrawn_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (table) => [
  index("idx_pending_reviews_status").on(table.status),
  index("idx_pending_reviews_submitted_by").on(table.submittedById),
  index("idx_pending_reviews_workflow_stage").on(table.workflowStage),
  index("idx_pending_reviews_staging_fact").on(table.stagingFactId),
  // The approved-fact-text-lock protection predicate asks, per text-bearing
  // PATCH, "does a production-approved review point at this fact?" — an
  // approvedFactId existence lookup that this index serves.
  index("idx_pending_reviews_approved_fact").on(table.approvedFactId),
]);

export type PendingReview = typeof pendingReviewsTable.$inferSelect;
export type InsertPendingReview = typeof pendingReviewsTable.$inferInsert;
