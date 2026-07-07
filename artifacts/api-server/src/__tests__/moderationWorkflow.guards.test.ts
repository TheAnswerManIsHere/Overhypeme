/**
 * Pure guard tests for the three-gate moderation lifecycle (no DB).
 *
 * Covers the concept_review stage added for the Visual Concept step:
 *  - concept_review counts as an unresolved submission stage,
 *  - canApproveVisualConcept gates concept_review only,
 *  - canProductionApprove stays production_review-only,
 *  - canReject: a first-time submission is triage_pending-only; a refresh
 *    cycle (isRefreshCycle=true) is allowed at any pending stage,
 *  - canProvisionallyApprove includes concept_review,
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
  canReject,
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

  it("canReject: a first-time submission (isRefreshCycle=false) can't reject past triage", () => {
    assert.equal(canReject("triage_pending", "pending", false), true);
    assert.equal(canReject("prep_pending", "pending", false), false);
    assert.equal(canReject("prep_failed", "pending", false), false);
    assert.equal(canReject("concept_review", "pending", false), false);
    assert.equal(canReject("production_review", "pending", false), false);
  });

  it("canReject: a refresh cycle (isRefreshCycle=true) can reject ('don't promote') at any pending stage", () => {
    assert.equal(canReject("concept_review", "pending", true), true);
    assert.equal(canReject("production_review", "pending", true), true);
    assert.equal(canReject("concept_review", "rejected", true), false);
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
