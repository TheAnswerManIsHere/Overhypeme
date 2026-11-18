/** deriveModerationQueueState — the §8 label table, as a pure unit test. */

import { describe, it, expect } from "vitest";
import { deriveModerationQueueState, stageToWizardStep } from "./moderationQueueState";

describe("deriveModerationQueueState — label table", () => {
  it("terminal statuses short-circuit regardless of stage", () => {
    expect(deriveModerationQueueState({ status: "approved", workflowStage: "approved" }))
      .toMatchObject({ label: "Approved", spinner: false, actionStep: null, tone: "resolved" });
    expect(deriveModerationQueueState({ status: "rejected", workflowStage: "rejected" }))
      .toMatchObject({ label: "Rejected", spinner: false, actionStep: null, tone: "resolved" });
  });

  it("triage_pending → Needs triage (no spinner, triage step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "triage" }))
      .toMatchObject({ label: "Needs triage", spinner: false, actionStep: "triage" });
  });

  it("prep_pending → Preparing… (spinner)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "prep_pending" }))
      .toMatchObject({ label: "Preparing…", spinner: true, actionStep: "triage", tone: "working" });
  });

  it("prep_failed → Prep failed (attention)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "prep_failed" }))
      .toMatchObject({ label: "Prep failed", spinner: false, tone: "attention" });
  });

  it("concept_review pending → Generating visual ideas… (spinner, concept step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "pending" }))
      .toMatchObject({ label: "Generating visual ideas…", spinner: true, actionStep: "concept", tone: "working" });
  });

  it("concept_review ok → Ready for concept review", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "ok" }))
      .toMatchObject({ label: "Ready for concept review", spinner: false, actionStep: "concept", tone: "ready" });
  });

  it("concept_review failed → Visual-ideas generation failed", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "failed" }))
      .toMatchObject({ label: "Visual-ideas generation failed", spinner: false, tone: "attention" });
  });

  it("concept_review with no ideas → Visual ideas not generated", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: null }))
      .toMatchObject({ label: "Visual ideas not generated", spinner: false, actionStep: "concept", tone: "attention" });
  });

  it("production_review running → Rendering test images… (spinner, render step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "running" }))
      .toMatchObject({ label: "Rendering test images…", spinner: true, actionStep: "render", tone: "working" });
  });

  it("production_review not_started (fresh force batch) also spins", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "not_started" }))
      .toMatchObject({ label: "Rendering test images…", spinner: true, actionStep: "render" });
  });

  it("production_review ready → Renders ready — needs review", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "ready" }))
      .toMatchObject({ label: "Renders ready — needs review", spinner: false, tone: "ready" });
  });

  it("production_review needs_attention → Renders need attention", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "needs_attention" }))
      .toMatchObject({ label: "Renders need attention", spinner: false, tone: "attention" });
  });
});

describe("stageToWizardStep", () => {
  it("maps prep/triage stages to triage, concept_review to concept, production_review to render", () => {
    expect(stageToWizardStep("triage")).toBe("triage");
    expect(stageToWizardStep("prep_pending")).toBe("triage");
    expect(stageToWizardStep("prep_failed")).toBe("triage");
    expect(stageToWizardStep("gags")).toBe("concept");
    expect(stageToWizardStep("test_renders")).toBe("render");
    expect(stageToWizardStep("approved")).toBeNull();
    expect(stageToWizardStep("rejected")).toBeNull();
  });
});
