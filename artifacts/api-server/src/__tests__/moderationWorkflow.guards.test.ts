/**
 * Pure guard tests for the three-gate moderation lifecycle (no DB).
 *
 * Covers the concept_review stage added for the Visual Concept step:
 *  - concept_review counts as an unresolved submission stage,
 *  - canApproveVisualConcept gates concept_review only,
 *  - canProductionApprove stays production_review-only,
 *  - canReject: any step until the fact goes live (PLAN_FACT_LIFECYCLE_REBUILD.md item 13),
 *  - canProvisionallyApprove includes concept_review.
 */

import { reviewReasonEnum } from "@workspace/db/schema";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  REVIEW_WORKFLOW_STAGE_VALUES,
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  isUnresolvedSubmissionStage,
  canProvisionallyApprove,
  canApproveVisualConcept,
  canProductionApprove,
  canReject,
  REJECTION_REASON_VALUES,
} from "@workspace/api-zod";

describe("moderationWorkflow — concept_review stage", () => {
  it("is a first-class stage value with display metadata", () => {
    assert.ok(REVIEW_WORKFLOW_STAGE_VALUES.includes("gags"));
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.concept_review.label, "Gags");
    // production_review label was repurposed to the render step.
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.production_review.label, "Test Renders");
  });

  it("counts as an unresolved submission stage", () => {
    assert.ok(UNRESOLVED_SUBMISSION_STAGE_VALUES.includes("gags"));
    assert.equal(isUnresolvedSubmissionStage("gags"), true);
  });

  it("canApproveVisualConcept: true only at concept_review + pending", () => {
    assert.equal(canApproveVisualConcept("gags", "pending"), true);
    assert.equal(canApproveVisualConcept("gags", "approved"), false);
    assert.equal(canApproveVisualConcept("test_renders", "pending"), false);
    assert.equal(canApproveVisualConcept("prep_pending", "pending"), false);
  });

  it("canProductionApprove: still production_review-only (never concept_review)", () => {
    assert.equal(canProductionApprove("test_renders", "pending"), true);
    assert.equal(canProductionApprove("gags", "pending"), false);
  });

  it("canReject: every step until the fact goes live, never a resolved review", () => {
    for (const stage of ["triage", "prep_pending", "prep_failed", "gags", "test_renders"] as const) {
      assert.equal(canReject(stage, "pending"), true, stage);
    }
    for (const stage of ["rejected", "rejected", "approved"] as const) {
      assert.equal(canReject(stage, "pending"), false, stage);
    }
    assert.equal(canReject("triage", "rejected"), false);
    assert.equal(canReject("test_renders", "approved"), false);
  });

  it("the rejection reasons and the review_reason enum are one list", () => {
    // lib/db cannot import api-zod, so the enum repeats the list; this keeps
    // the two copies from drifting.
    assert.deepEqual([...reviewReasonEnum.enumValues], [...REJECTION_REASON_VALUES]);
  });

  it("canProvisionallyApprove: re-prep allowed from concept_review", () => {
    assert.equal(canProvisionallyApprove("gags", "pending"), true);
  });
});
