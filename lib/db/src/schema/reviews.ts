import { pgTable, text, serial, timestamp, varchar, integer, bigint, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

export const reviewStatusEnum = pgEnum("review_status", ["pending", "approved", "rejected"]);
export const reviewReasonEnum = pgEnum("review_reason", ["duplicate", "spam", "offensive", "lame"]);

// Fine-grained two-gate moderation lifecycle (see @workspace/api-zod
// moderationWorkflow). The labels here MUST stay in sync with
// REVIEW_WORKFLOW_STAGE_VALUES.
export const reviewWorkflowStageEnum = pgEnum("review_workflow_stage", [
  "triage_pending",
  "triage_rejected",
  "prep_pending",
  "prep_failed",
  "production_review",
  "production_rejected",
  "production_approved",
]);

export const pendingReviewsTable = pgTable("pending_reviews", {
  id: serial("id").primaryKey(),
  submittedText: text("submitted_text").notNull(),
  submittedById: varchar("submitted_by_id").references(() => usersTable.id),
  matchingFactId: integer("matching_fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  matchingSimilarity: integer("matching_similarity").notNull().default(0),
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
   * All production-prep tooling (enrichment, Pexels, CPP, test memes, override
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
   * For a refresh (send-back) cycle: the fact_enrichment_versions.id of the
   * candidate this review is reviewing. Null for first-time submission cycles.
   * Its presence is how every surface distinguishes a refresh review from a
   * first-time one. App-managed pointer (no hard FK, to avoid a schema import
   * cycle with fact_enrichment_versions, whose source_review_id points back here).
   */
  candidateVersionId: bigint("candidate_version_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (table) => [
  index("idx_pending_reviews_status").on(table.status),
  index("idx_pending_reviews_submitted_by").on(table.submittedById),
  index("idx_pending_reviews_workflow_stage").on(table.workflowStage),
  index("idx_pending_reviews_staging_fact").on(table.stagingFactId),
]);

export type PendingReview = typeof pendingReviewsTable.$inferSelect;
export type InsertPendingReview = typeof pendingReviewsTable.$inferInsert;
