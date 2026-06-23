/**
 * Moderation workflow stages (leaf module — no cross-package imports).
 *
 * Overhype's fact moderation is a two-gate, cost-gated lifecycle:
 *
 *   triage_pending ──reject──> triage_rejected
 *         │
 *  provisional approve (creates inactive staging fact; starts enrichment + Pexels)
 *         ▼
 *   prep_pending ──enrichment terminal abandon──> prep_failed ──retry──> prep_pending
 *         │                                              └────reject────> triage_rejected
 *  enrichment success
 *         ▼
 *   production_review ──reject──> production_rejected
 *         │
 *  production approve (flips staging fact active, embeds, notifies user)
 *         ▼
 *   production_approved
 *
 * `pending_reviews.status` (pending|approved|rejected) stays as a coarse bucket;
 * `workflowStage` is the fine-grained driver. The string values are also the
 * Postgres enum labels (see migration 0074) and the FE display keys, so this is
 * the single source of truth shared by schema, routes, jobs, and UI.
 */

export const REVIEW_WORKFLOW_STAGE_VALUES = [
  "triage_pending",
  "triage_rejected",
  "prep_pending",
  "prep_failed",
  "production_review",
  "production_rejected",
  "production_approved",
] as const;

export type ReviewWorkflowStage = (typeof REVIEW_WORKFLOW_STAGE_VALUES)[number];

/** Terminal stages — no further automated or moderator transitions occur. */
const TERMINAL_STAGES: ReadonlySet<ReviewWorkflowStage> = new Set([
  "triage_rejected",
  "production_rejected",
  "production_approved",
]);

/**
 * Stages that count against a user's unresolved-submission cap: the candidate
 * is still occupying moderator attention. Terminal stages do not count.
 * Exported as an array for `IN (...)` DB queries.
 */
export const UNRESOLVED_SUBMISSION_STAGE_VALUES = [
  "triage_pending",
  "prep_pending",
  "prep_failed",
  "production_review",
] as const satisfies readonly ReviewWorkflowStage[];

const UNRESOLVED_SUBMISSION_STAGES: ReadonlySet<ReviewWorkflowStage> = new Set(
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
);

export function isTerminalReviewStage(stage: ReviewWorkflowStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function isUnresolvedSubmissionStage(stage: ReviewWorkflowStage): boolean {
  return UNRESOLVED_SUBMISSION_STAGES.has(stage);
}

/**
 * First moderator gate. Allowed from triage, from a failed prep (re-attempt),
 * and from production_review (re-run prep / re-derive the staging fact). The
 * coarse status must still be "pending" — a resolved review can't be re-prepped.
 */
export function canProvisionallyApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return (
    status === "pending" &&
    (stage === "triage_pending" || stage === "prep_failed" || stage === "production_review")
  );
}

/** Retry prep after a terminal enrichment failure. */
export function canRetryPrep(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "prep_failed";
}

/** Second moderator gate — only a fully-prepped fact can go live. */
export function canProductionApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "production_review";
}

/** Reject a staged candidate after prep work has begun. */
export function canRejectAfterPrep(stage: ReviewWorkflowStage, status: string): boolean {
  return (
    status === "pending" &&
    (stage === "prep_pending" || stage === "prep_failed" || stage === "production_review")
  );
}

/** FE-safe display metadata (label + short helper copy + coarse grouping). */
export interface ReviewWorkflowStageDisplay {
  label: string;
  hint: string;
  /** List-grouping bucket for the moderation queue. */
  group: "needs_first_pass" | "prep" | "production_review" | "resolved";
}

export const REVIEW_WORKFLOW_STAGE_DISPLAY: Record<ReviewWorkflowStage, ReviewWorkflowStageDisplay> = {
  triage_pending: {
    label: "Needs first pass",
    hint: "Cheap human triage — no AI/image work has run yet.",
    group: "needs_first_pass",
  },
  triage_rejected: {
    label: "Rejected (triage)",
    hint: "Rejected before any prep spend.",
    group: "resolved",
  },
  prep_pending: {
    label: "AI prep running",
    hint: "VTE enrichment and image prep are running on the staging fact.",
    group: "prep",
  },
  prep_failed: {
    label: "Prep failed",
    hint: "Enrichment failed after retries — retry or reject.",
    group: "prep",
  },
  production_review: {
    label: "Production review",
    hint: "Tune enrichment, inspect CPP/test memes, then approve for production.",
    group: "production_review",
  },
  production_rejected: {
    label: "Rejected (after prep)",
    hint: "Rejected during production review; staging fact deactivated.",
    group: "resolved",
  },
  production_approved: {
    label: "Live",
    hint: "Approved for production — visible to users.",
    group: "resolved",
  },
};
