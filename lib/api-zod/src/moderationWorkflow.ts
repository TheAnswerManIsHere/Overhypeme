/**
 * Moderation workflow stages (leaf module — no cross-package imports).
 *
 * Overhype's fact moderation is a three-gate, cost-gated lifecycle:
 *
 *   triage_pending ──reject──> triage_rejected
 *         │
 *  provisional approve (creates inactive staging fact; starts enrichment + Pexels)
 *         ▼
 *   prep_pending ──enrichment terminal abandon──> prep_failed ──retry──> prep_pending
 *         │
 *  enrichment success (enqueues Visual-Idea candidates; NO renders yet)
 *         ▼
 *   concept_review                                        ← Step 2: Visual Concept gate
 *         │                ↑ back-to-visual-concept
 *  approve the visual gag (saved non-empty coreScene + ideas terminal-OK)
 *   → force-enqueues the default render batch (auto-fire)
 *         ▼
 *   production_review                                     ← Step 3: Test Renders gate
 *         │
 *  production approve (flips staging fact active, embeds, notifies user)
 *         ▼
 *   production_approved
 *
 * A first-time submission can only be rejected during triage (Step 1) — once
 * it clears triage, there is no reject path: a failed prep, a Visual Concept
 * that isn't working, or a render that isn't ready all just leave the
 * candidate parked (pending / prep_failed) until an admin resolves the
 * underlying issue. The one exception is a REFRESH cycle (re-enrichment of an
 * already-live fact): its "reject" means "don't promote this refresh," never
 * touches the live fact, and is allowed at any stage since a refresh always
 * starts past triage (see `canReject` below).
 *
 * Step 2 = Visual Concept gate (a saved concept + generated Visual Ideas gate the
 * gag approval; Visual Ideas are a blocking prep artifact, not best-effort).
 * Step 3 = Test Renders gate (render grid + final production approval).
 *
 * `pending_reviews.status` (pending|approved|rejected) stays as a coarse bucket;
 * `workflowStage` is the fine-grained driver. The string values are also the
 * Postgres enum labels (see migrations 0074 + 0083) and the FE display keys, so
 * this is the single source of truth shared by schema, routes, jobs, and UI.
 */

export const REVIEW_WORKFLOW_STAGE_VALUES = [
  "triage_pending",
  "triage_rejected",
  "prep_pending",
  "prep_failed",
  "concept_review",
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
  "concept_review",
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
 * and from concept_review / production_review (re-run prep / re-derive the
 * staging fact). The coarse status must still be "pending" — a resolved review
 * can't be re-prepped.
 */
export function canProvisionallyApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return (
    status === "pending" &&
    (stage === "triage_pending" ||
      stage === "prep_failed" ||
      stage === "concept_review" ||
      stage === "production_review")
  );
}

/** Retry prep after a terminal enrichment failure. */
export function canRetryPrep(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "prep_failed";
}

/**
 * Step 2 gate — "approve the visual gag". Advances concept_review →
 * production_review and force-enqueues the default render batch. Only the
 * saved concept + generated Visual Ideas (checked at the route) gate this;
 * here we only assert the stage/status shape.
 */
export function canApproveVisualConcept(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "concept_review";
}

/** Third moderator gate — only a fully-rendered fact can go live. */
export function canProductionApprove(stage: ReviewWorkflowStage, status: string): boolean {
  return status === "pending" && stage === "production_review";
}

/**
 * A refresh-cycle candidate's enrichment/Visual-Concept is editable in BOTH
 * Step 2 (concept_review) and Step 3 (production_review) — the moderator tunes
 * the concept in Step 2 and the render inputs in Step 3. Promotion, by contrast,
 * stays Step-3-only (canProductionApprove). Stage-only (mirrors the pre-existing
 * production_review-only check it replaces).
 */
export function canEditRefreshCandidate(stage: ReviewWorkflowStage): boolean {
  return stage === "concept_review" || stage === "production_review";
}

/**
 * Reject a candidate. A first-time submission may only be rejected during
 * triage (Step 1) — once triage passes, a stuck candidate (failed prep, a
 * Visual Concept or render that isn't working) stays pending until an admin
 * resolves it; it is never rejected again. A refresh cycle is the one
 * exception: rejecting it means "don't promote this refresh" (the live fact
 * is left untouched), which is safe at any stage since a refresh always
 * starts past triage.
 */
export function canReject(stage: ReviewWorkflowStage, status: string, isRefreshCycle: boolean): boolean {
  return status === "pending" && (isRefreshCycle || stage === "triage_pending");
}

/**
 * Coarse, list-level render state for a Step-3 (production_review) row, derived
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
  group: "needs_first_pass" | "prep" | "concept_review" | "production_review" | "resolved";
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
    hint: "Enrichment failed after retries — retry prep to continue.",
    group: "prep",
  },
  concept_review: {
    label: "Visual Concept",
    hint: "Accept, edit, or write the Visual Concept and approve the visual gag — no renders spend yet.",
    group: "concept_review",
  },
  production_review: {
    label: "Test Renders",
    hint: "Inspect the test-render grid, tweak enrichment/CPP, then approve for production.",
    group: "production_review",
  },
  production_rejected: {
    // Only reachable via a refresh cycle's "don't promote" decline — a
    // first-time submission can never reach this stage (see `canReject`).
    // The live fact is NOT touched by this: it stays exactly as published.
    label: "Refresh Not Promoted",
    hint: "This refresh candidate was declined — the live fact is unaffected and stays published as-is.",
    group: "resolved",
  },
  production_approved: {
    label: "Live",
    hint: "Approved for production — visible to users.",
    group: "resolved",
  },
};
