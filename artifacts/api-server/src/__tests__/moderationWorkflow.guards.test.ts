/**
 * Pure guard tests for the four-step moderation lifecycle (no DB; plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, 1D; Issue #1018, increment 1.2c-ii):
 * Triage → Reading → Gags → Test Renders, then Approved or Rejected.
 */

import { reviewReasonEnum, reviewWorkflowStageEnum } from "@workspace/db/schema";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  PREPARING_STAGE_VALUES,
  REVIEW_WORKFLOW_STAGE_VALUES,
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  isUnresolvedSubmissionStage,
  isTerminalReviewStage,
  canProvisionallyApprove,
  canRetryReading,
  canApproveReading,
  canApproveGags,
  canSendBackToGags,
  canProductionApprove,
  canReject,
  REJECTION_REASON_VALUES,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";

const ALL = REVIEW_WORKFLOW_STAGE_VALUES;

/** The stages a guard allows, with the review still pending. */
function allowed(guard: (stage: ReviewWorkflowStage, status: string) => boolean): ReviewWorkflowStage[] {
  return ALL.filter((s) => guard(s, "pending"));
}

describe("moderationWorkflow — the four steps", () => {
  it("has exactly the six stages, and the database enum is the same list", () => {
    assert.deepEqual([...ALL], ["triage", "reading", "gags", "test_renders", "approved", "rejected"]);
    assert.deepEqual([...reviewWorkflowStageEnum.enumValues], [...ALL]);
  });

  it("every stage has display metadata; the rejected label does not say renders were discarded", () => {
    for (const s of ALL) assert.ok(REVIEW_WORKFLOW_STAGE_DISPLAY[s].label, s);
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.reading.label, "Reading");
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.gags.label, "Gags");
    assert.equal(REVIEW_WORKFLOW_STAGE_DISPLAY.test_renders.label, "Test Renders");
    assert.doesNotMatch(REVIEW_WORKFLOW_STAGE_DISPLAY.rejected.hint, /discarded/i);
    assert.match(REVIEW_WORKFLOW_STAGE_DISPLAY.rejected.hint, /gags were deleted/);
  });

  it("unresolved = the four steps; preparing = the three after triage; terminal = approved and rejected", () => {
    assert.deepEqual([...UNRESOLVED_SUBMISSION_STAGE_VALUES], ["triage", "reading", "gags", "test_renders"]);
    assert.deepEqual([...PREPARING_STAGE_VALUES], ["reading", "gags", "test_renders"]);
    assert.deepEqual(ALL.filter(isUnresolvedSubmissionStage), ["triage", "reading", "gags", "test_renders"]);
    assert.deepEqual(ALL.filter(isTerminalReviewStage), ["approved", "rejected"]);
  });

  it("each transition is allowed from exactly its own step", () => {
    assert.deepEqual(allowed(canProvisionallyApprove), ["triage"]);
    assert.deepEqual(allowed(canRetryReading), ["reading"]);
    assert.deepEqual(allowed(canApproveReading), ["reading"]);
    assert.deepEqual(allowed(canApproveGags), ["gags"]);
    assert.deepEqual(allowed(canSendBackToGags), ["test_renders"]);
    assert.deepEqual(allowed(canProductionApprove), ["test_renders"]);
  });

  it("canReject: every step until the fact goes live, never a resolved review", () => {
    assert.deepEqual(allowed(canReject), ["triage", "reading", "gags", "test_renders"]);
    assert.equal(canReject("triage", "rejected"), false);
    assert.equal(canReject("test_renders", "approved"), false);
  });

  it("no transition is allowed on a resolved review", () => {
    for (const guard of [canProvisionallyApprove, canRetryReading, canApproveReading, canApproveGags, canSendBackToGags, canProductionApprove, canReject]) {
      for (const s of ALL) {
        assert.equal(guard(s, "approved"), false);
        assert.equal(guard(s, "rejected"), false);
      }
    }
  });

  it("the rejection reasons and the review_reason enum are one list", () => {
    // lib/db cannot import api-zod, so the enum repeats the list; this keeps
    // the two copies from drifting.
    assert.deepEqual([...reviewReasonEnum.enumValues], [...REJECTION_REASON_VALUES]);
  });
});
