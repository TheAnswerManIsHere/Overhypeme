/**
 * Pure guard tests for the three-gate moderation lifecycle (no DB).
 *
 * Covers the concept_review stage added for the Visual Concept step:
 *  - concept_review counts as an unresolved submission stage,
 *  - canApproveVisualConcept gates concept_review only,
 *  - canProductionApprove stays production_review-only,
 *  - canRejectAfterPrep + canProvisionallyApprove include concept_review,
 *  - canEditRefreshCandidate spans concept_review + production_review.
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
  canRejectAfterPrep,
  canEditRefreshCandidate,
} from "@workspace/api-zod";

describe("moderationWorkflow — concept_review stage", () => {
  it("is a first-class stage value with display metadata", () => {
    assert.ok(REVIEW_WORKFLOW_STAGE_VALUES.includes("concept_review"));
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.concept_review.label, "Visual Concept");
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

  it("canRejectAfterPrep: true at concept_review", () => {
    assert.equal(canRejectAfterPrep("concept_review", "pending"), true);
    assert.equal(canRejectAfterPrep("concept_review", "rejected"), false);
  });

  it("canProvisionallyApprove: re-prep allowed from concept_review", () => {
    assert.equal(canProvisionallyApprove("concept_review", "pending"), true);
  });

  it("canEditRefreshCandidate: true for concept_review AND production_review only", () => {
    assert.equal(canEditRefreshCandidate("concept_review"), true);
    assert.equal(canEditRefreshCandidate("production_review"), true);
    assert.equal(canEditRefreshCandidate("prep_pending"), false);
    assert.equal(canEditRefreshCandidate("triage_pending"), false);
    assert.equal(canEditRefreshCandidate("production_approved"), false);
  });
});
