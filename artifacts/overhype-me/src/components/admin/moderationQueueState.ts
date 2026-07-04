import {
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  type ReviewWorkflowStage,
  type RenderReviewState,
} from "@workspace/api-zod";

/** The three moderation wizard steps a non-terminal review moves through. */
export type WizardStep = "triage" | "concept" | "render";

/** Coarse visual tone for the queue-state chip. */
export type QueueTone = "neutral" | "working" | "ready" | "attention" | "resolved";

type PrepStatusLike = "pending" | "ok" | "failed" | null | undefined;
type RenderReviewStateLike = RenderReviewState | null | undefined;

/**
 * Pure, list/modal-shared derivation of a review's queue state — the single
 * place the §8 label table lives, so it isn't duplicated/buried in JSX. Unit
 * tested against the full label table.
 *
 * `spinner` drives both the queue chip AND the list-poll trigger (poll while any
 * row spins), so a fresh force render batch (`renderReviewState: "not_started"`)
 * keeps the list polling until attempts materialize.
 * `actionStep` is which wizard step the primary action lives on (null = terminal).
 */
export interface ModerationQueueState {
  label: string;
  spinner: boolean;
  actionStep: WizardStep | null;
  tone: QueueTone;
}

export function deriveModerationQueueState(review: {
  status: "pending" | "approved" | "rejected";
  workflowStage: ReviewWorkflowStage;
  /** From the staging fact (facts.visual_concept_status). */
  visualConceptStatus?: PrepStatusLike;
  /** Coarse Step-3 render state from the list aggregate. */
  renderReviewState?: RenderReviewStateLike;
}): ModerationQueueState {
  const { status, workflowStage } = review;

  if (status === "approved") return { label: "Approved", spinner: false, actionStep: null, tone: "resolved" };
  if (status === "rejected") return { label: "Rejected", spinner: false, actionStep: null, tone: "resolved" };

  // status === "pending"
  switch (workflowStage) {
    case "triage_pending":
      return { label: "Needs triage", spinner: false, actionStep: "triage", tone: "neutral" };
    case "prep_pending":
      return { label: "Preparing…", spinner: true, actionStep: "triage", tone: "working" };
    case "prep_failed":
      return { label: "Prep failed", spinner: false, actionStep: "triage", tone: "attention" };
    case "concept_review": {
      const cs = review.visualConceptStatus;
      if (cs === "pending") return { label: "Generating visual ideas…", spinner: true, actionStep: "concept", tone: "working" };
      if (cs === "ok") return { label: "Ready for concept review", spinner: false, actionStep: "concept", tone: "ready" };
      if (cs === "failed") return { label: "Visual-ideas generation failed", spinner: false, actionStep: "concept", tone: "attention" };
      // null/undefined: never generated (e.g. an old-flow row bounced back to Step 2).
      return { label: "Visual ideas not generated", spinner: false, actionStep: "concept", tone: "attention" };
    }
    case "production_review": {
      const rs = review.renderReviewState;
      if (rs === "ready") return { label: "Renders ready — needs review", spinner: false, actionStep: "render", tone: "ready" };
      if (rs === "needs_attention") return { label: "Renders need attention", spinner: false, actionStep: "render", tone: "attention" };
      // "running" OR "not_started" (a just-forced batch whose attempts haven't
      // materialized yet) — both keep the row spinning + polling.
      return { label: "Rendering test images…", spinner: true, actionStep: "render", tone: "working" };
    }
    default:
      // Terminal stages are unreachable while status === "pending"; fall back to
      // the shared display label so the chip never renders blank.
      return {
        label: REVIEW_WORKFLOW_STAGE_DISPLAY[workflowStage]?.label ?? String(workflowStage),
        spinner: false,
        actionStep: null,
        tone: "neutral",
      };
  }
}

/** Map a workflow stage to its wizard step (null for terminal/resolved stages). */
export function stageToWizardStep(stage: ReviewWorkflowStage): WizardStep | null {
  switch (stage) {
    case "triage_pending":
    case "prep_pending":
    case "prep_failed":
      return "triage";
    case "concept_review":
      return "concept";
    case "production_review":
      return "render";
    default:
      return null;
  }
}
