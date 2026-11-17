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
} from "@workspace/api-zod";

describe("moderationWorkflow — concept_review stage", () => {
  it("is a first-class stage value with display metadata", () => {
    assert.ok(REVIEW_WORKFLOW_STAGE_VALUES.includes("concept_review"));
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.concept_review.label, "Gags");
    // production_review label was repurposed to the render step.
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.production_review.label, "Test Renders");
  });

  it("counts as an unresolved submission stage", () => {
    assert.ok(UNRESOLVED_SUBMISSION_STAGE_VALUES.includes("concept_review"));
    assert.equal(isUnresolvedSubmissionStage("concept_review"), true);
  });

  it("canApproveVisualConcept: true only at concept_review + pending", () => {
    assert.equal(canApproveVisualConcept("concept_review", "pending"), true);
    assert.equal(canApproveVisualConcept("concept_review", "approved"), false);
    assert.equal(canApproveVisualConcept("production_review", "pending"), false);
    assert.equal(canApproveVisualConcept("prep_pending", "pending"), false);
  });

  it("canProductionApprove: still production_review-only (never concept_review)", () => {
    assert.equal(canProductionApprove("production_review", "pending"), true);
    assert.equal(canProductionApprove("concept_review", "pending"), false);
  });

  it("canReject: every step until the fact goes live, never a resolved review", () => {
    for (const stage of ["triage_pending", "prep_pending", "prep_failed", "concept_review", "production_review"] as const) {
      assert.equal(canReject(stage, "pending"), true, stage);
    }
    for (const stage of ["triage_rejected", "production_rejected", "production_approved"] as const) {
      assert.equal(canReject(stage, "pending"), false, stage);
    }
    assert.equal(canReject("triage_pending", "rejected"), false);
    assert.equal(canReject("production_review", "approved"), false);
  });

  it("canProvisionallyApprove: re-prep allowed from concept_review", () => {
    assert.equal(canProvisionallyApprove("concept_review", "pending"), true);
  });
});
