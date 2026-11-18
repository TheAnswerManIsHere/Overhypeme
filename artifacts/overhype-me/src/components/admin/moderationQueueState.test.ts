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

  it("triage → Needs triage (no spinner, triage step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "triage" }))
      .toMatchObject({ label: "Needs triage", spinner: false, actionStep: "triage" });
  });

  it("reading, run pending → Reading the fact… (spinner, reading step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "reading", readingStatus: "pending" }))
      .toMatchObject({ label: "Reading the fact…", spinner: true, actionStep: "reading", tone: "working" });
  });

  it("reading, run ok → Ready to check the reading", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "reading", readingStatus: "ok" }))
      .toMatchObject({ label: "Ready to check the reading", spinner: false, actionStep: "reading", tone: "ready" });
  });

  it("reading, run failed → The reading failed (attention)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "reading", readingStatus: "failed" }))
      .toMatchObject({ label: "The reading failed", spinner: false, tone: "attention" });
  });

  it("reading, no run → Reading not written yet (attention)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "reading", readingStatus: null }))
      .toMatchObject({ label: "Reading not written yet", actionStep: "reading", tone: "attention" });
  });

  it("gags, ideas pending → Generating visual ideas… (spinner, concept step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "pending" }))
      .toMatchObject({ label: "Generating visual ideas…", spinner: true, actionStep: "concept", tone: "working" });
  });

  it("gags, ideas ok → Ready for gags", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "ok" }))
      .toMatchObject({ label: "Ready for gags", spinner: false, actionStep: "concept", tone: "ready" });
  });

  it("gags, ideas failed → Visual-ideas generation failed", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: "failed" }))
      .toMatchObject({ label: "Visual-ideas generation failed", spinner: false, tone: "attention" });
  });

  it("gags with no ideas → Visual ideas not generated", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "gags", visualConceptStatus: null }))
      .toMatchObject({ label: "Visual ideas not generated", spinner: false, actionStep: "concept", tone: "attention" });
  });

  it("test_renders running → Rendering test images… (spinner, render step)", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "running" }))
      .toMatchObject({ label: "Rendering test images…", spinner: true, actionStep: "render", tone: "working" });
  });

  it("test_renders not_started (fresh force batch) also spins", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "not_started" }))
      .toMatchObject({ label: "Rendering test images…", spinner: true, actionStep: "render" });
  });

  it("test_renders ready → Renders ready — needs review", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "ready" }))
      .toMatchObject({ label: "Renders ready — needs review", spinner: false, tone: "ready" });
  });

  it("test_renders needs_attention → Renders need attention", () => {
    expect(deriveModerationQueueState({ status: "pending", workflowStage: "test_renders", renderReviewState: "needs_attention" }))
      .toMatchObject({ label: "Renders need attention", spinner: false, tone: "attention" });
  });
});

describe("stageToWizardStep", () => {
  it("maps each step's stage to its wizard step, and terminal stages to none", () => {
    expect(stageToWizardStep("triage")).toBe("triage");
    expect(stageToWizardStep("reading")).toBe("reading");
    expect(stageToWizardStep("gags")).toBe("concept");
    expect(stageToWizardStep("test_renders")).toBe("render");
    expect(stageToWizardStep("approved")).toBeNull();
    expect(stageToWizardStep("rejected")).toBeNull();
  });
});
