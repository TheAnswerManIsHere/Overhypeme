/**
 * Moderation workflow stages (leaf module — no cross-package imports).
 *
 * A new submission moves through four steps, then ends approved or rejected
 * (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1D; Issue #1018, increment
 * 1.2c-ii):
 *
 *   triage ──"Provisional approval – start prep"──▶ reading
 *     (creates the inactive staging fact; starts the reading job and, beside
 *      it, the taxonomy run, which never moves a review)
 *   reading ──"Approve" the humor note──▶ gags
 *   gags ──"Approve the gags"──▶ test_renders ──"Back to gags"──▶ gags
 *   test_renders ──"Approve for production"──▶ approved
 *   any step before approved ──"Reject"──▶ rejected
 *
 * Background work has no stage of its own: the reading, the gag ideas and the
 * renders each carry their own status, shown on the step that waits for it.
 *
 * `pending_reviews.status` (pending|approved|rejected) stays as a coarse
 * bucket; `workflowStage` is the fine-grained driver. The string values are
 * also the Postgres enum labels (migration 0155) and the FE display keys, so
 * this is the single source of truth shared by schema, routes, jobs and UI.
 */

export const REVIEW_WORKFLOW_STAGE_VALUES = [
  "triage",
  "reading",
  "gags",
  "test_renders",
  "approved",
  "rejected",
] as const;

export type ReviewWorkflowStage = (typeof REVIEW_WORKFLOW_STAGE_VALUES)[number];

/** Terminal stages — no further automated or moderator transitions occur. */
const TERMINAL_STAGES: ReadonlySet<ReviewWorkflowStage> = new Set(["approved", "rejected"]);

/**
 * Stages that count against a user's unresolved-submission cap: the candidate
 * is still occupying moderator attention. Terminal stages do not count.
 * Exported as an array for `IN (...)` DB queries.
 */
export const UNRESOLVED_SUBMISSION_STAGE_VALUES = [
  "triage",
  "reading",
  "gags",
  "test_renders",
] as const satisfies readonly ReviewWorkflowStage[];

/** The unresolved stages past triage: a staging fact exists and is being prepared. */
export const PREPARING_STAGE_VALUES = [
  "reading",
  "gags",
  "test_renders",
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

/** First moderator gate: accept a submission at triage and start its prep. */
export function canProvisionallyApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "triage";
}

/** Run the reading again: while the review waits at the Reading step. */
export function canRetryReading(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "reading";
}

/** Approve the humor note: Reading → Gags. */
export function canApproveReading(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "reading";
}

/** Approve the gags: Gags → Test Renders (the route checks the gags themselves). */
export function canApproveGags(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "gags";
}

/** Correct the approved humor note: on Gags or Test Renders (it is first approved at Reading). */
export function canEditApprovedNote(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && (stage === "gags" || stage === "test_renders");
}

/** Back to gags: Test Renders → Gags. */
export function canSendBackToGags(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "test_renders";
}

/** Final gate — only from Test Renders can a fact go live. */
export function canProductionApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "test_renders";
}

/**
 * Reject a submission: from any step before it goes live (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, oracle item 13; Q2: 1). A resolved review
 * cannot be rejected.
 */
export function canReject(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && !TERMINAL_STAGES.has(stage);
}

/**
 * The refusal every transition gives when the review is no longer where the
 * moderator's screen showed it (another moderator, or a background step, moved
 * it first). One code, so the screen can say "reload" the same way for all.
 */
export const REVIEW_MOVED_CODE = "REVIEW_MOVED" as const;

/** Why a submission was rejected; one is required on every rejection. */
export const REJECTION_REASON_VALUES = ["duplicate", "spam", "offensive", "lame", "visual"] as const;
export type RejectionReason = (typeof REJECTION_REASON_VALUES)[number];

/** The moderator-facing label of each reason. */
export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  duplicate: "Duplicate",
  spam: "Spam",
  offensive: "Offensive",
  lame: "Lame",
  visual: "Couldn't make it work visually",
};

/**
 * A submission's wording bounds: the submission form's, and the triage edit's
 * (plan PLAN_THREE_GAGS.md, increment 3), from one place.
 */
export const SUBMISSION_TEXT_MIN_CHARS = 10;
export const SUBMISSION_TEXT_MAX_CHARS = 2000;

/**
 * A submission's wording may be edited only at triage, before it is accepted
 * (plan PLAN_THREE_GAGS.md, increment 3; David, 2026-11-14, Q6). Acceptance
 * creates the staging fact, and from then on the wording is locked.
 */
export function canEditWording(stage: ReviewWorkflowStage, status: string, hasStagingFact: boolean): boolean {
  return status === "pending" && stage === "triage" && !hasStagingFact;
}

/**
 * Coarse, list-level render state for a Test Renders row, derived
 * from a single aggregate SQL pass over the latest attempt per scenario. This is
 * intentionally cheaper and coarser than the modal's `buildReviewScenarioGrid`:
 *
 *  - `not_started`     — no render attempts exist yet.
 *  - `running`         — at least one scenario's latest attempt is still in flight.
 *  - `ready`           — every existing latest attempt succeeded (has an image).
 *  - `needs_attention` — none running, but at least one latest attempt failed.
 *
 * `"stale"` is deliberately NOT a value here: staleness needs the TS input-hash
 * recompute and is not a pure SQL property, so the modal/grid stays the
 * authoritative place for it.
 */
export const RENDER_REVIEW_STATE_VALUES = [
  "not_started",
  "running",
  "ready",
  "needs_attention",
] as const;

export type RenderReviewState = (typeof RENDER_REVIEW_STATE_VALUES)[number];

/** FE-safe display metadata (label + short helper copy + coarse grouping). */
export interface ReviewWorkflowStageDisplay {
  label: string;
  hint: string;
  /** List-grouping bucket for the moderation queue. */
  group: "needs_first_pass" | "reading" | "gags" | "test_renders" | "resolved";
}

export const REVIEW_WORKFLOW_STAGE_DISPLAY: Record<ReviewWorkflowStage, ReviewWorkflowStageDisplay> = {
  triage: {
    label: "Needs first pass",
    hint: "Cheap human triage — no AI/image work has run yet.",
    group: "needs_first_pass",
  },
  reading: {
    label: "Reading",
    hint: "Check how the fact was read: approve the humor note, written from the reference research beneath it.",
    group: "reading",
  },
  gags: {
    label: "Gags",
    hint: "Write, edit or use an idea for each of the fact's gags (up to three) and approve them — no renders spend yet.",
    group: "gags",
  },
  test_renders: {
    label: "Test Renders",
    hint: "Inspect the test renders, then approve for production.",
    group: "test_renders",
  },
  rejected: {
    label: "Rejected",
    hint: "Rejected before it went live — its gags were deleted, and none of its pictures are shown anywhere.",
    group: "resolved",
  },
  approved: {
    label: "Live",
    hint: "Approved for production — visible to users.",
    group: "resolved",
  },
};
