/**
 * EnrichmentEditor dual mode — review-mode hashtag curation AND override
 * decoration active at once, which is exactly how the moderation ReviewModal
 * mounts it after the lockstep change (`onFinalHashtagsChange` + a resolved
 * `overrideContext` from the staging fact).
 *
 * Pins the two-write-path contract:
 *  - tracked fields (selects) go through `overrideContext.onOverride`
 *    (instant per-field persistence) in addition to the optimistic onChange;
 *  - the Visual Strategy Override — the only untracked field moderation edits —
 *    goes through `onChange` ONLY (the localStorage-backed draft), never the
 *    override endpoints.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { FactEnrichment } from "@workspace/api-zod";
import { EnrichmentEditor, type EnrichmentOverrideContext } from "./EnrichmentEditor";

const BASELINE: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "legendary"],
  taxonomyConfidence: 0.9,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

// The effective enrichment: visualComplexity is overridden medium → high.
const EFFECTIVE: FactEnrichment = { ...BASELINE, visualComplexity: "high" };

const SEMANTIC_ENTITY = {
  surfaceText: "sign language",
  normalizedText: "sign language",
  entityKind: "abstract_concept" as const,
  visualReferent: "hands signing",
  capitalizationSignal: "not_relevant" as const,
  materiallyAffectsVisualPrompt: true,
  requiresAdminReview: false,
  confidence: 0.96,
  notes: "",
};

function makeOverrideContext(over: Partial<EnrichmentOverrideContext> = {}): EnrichmentOverrideContext {
  return {
    aiDerived: BASELINE,
    overrides: { "/visualComplexity": { value: "high", overriddenFrom: "medium" } },
    summary: {
      overriddenPaths: ["/visualComplexity"],
      baselineChangedPaths: ["/visualComplexity"],
      hasVisualStrategyOverride: false,
    },
    pending: {},
    onOverride: vi.fn(),
    onReset: vi.fn(),
    onAcknowledge: vi.fn(),
    ...over,
  };
}

function renderDualMode(oc: EnrichmentOverrideContext) {
  const onChange = vi.fn();
  const onFinalHashtagsChange = vi.fn();
  render(
    <EnrichmentEditor
      value={EFFECTIVE}
      status="ok"
      onChange={onChange}
      finalHashtags={["earth", "pushups"]}
      onFinalHashtagsChange={onFinalHashtagsChange}
      overrideContext={oc}
    />,
  );
  return { onChange, onFinalHashtagsChange };
}

describe("EnrichmentEditor dual mode (review hashtags + override decoration)", () => {
  it("renders the override summary bar, per-field decoration, needs-review count, and the final-hashtags editor together", () => {
    renderDualMode(makeOverrideContext());

    // Override decoration (Edit-Fact machinery)…
    expect(screen.getByText("Overridden:")).toBeTruthy();
    expect(screen.getByText(/1 needs review/)).toBeTruthy();
    expect(screen.getByText("overridden")).toBeTruthy();
    expect(screen.getByText(/Revert to AI/)).toBeTruthy();
    expect(screen.getByText(/review — AI changed/)).toBeTruthy();
    expect(screen.getByText(/Keep override/)).toBeTruthy();

    // …and the review-mode final-hashtags editor, at the same time.
    expect(screen.getByText("Final hashtags")).toBeTruthy();
    expect(screen.getByText("earth")).toBeTruthy();
    expect(screen.getByText("pushups")).toBeTruthy();
  });

  it("a tracked select change calls onOverride (per-field persistence) plus the optimistic onChange", () => {
    const oc = makeOverrideContext();
    const { onChange } = renderDualMode(oc);

    // The visualComplexity select is the one currently showing the overridden
    // effective value "high".
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const complexity = selects.find((s) => s.value === "high");
    expect(complexity).toBeTruthy();
    fireEvent.change(complexity!, { target: { value: "low" } });

    expect(oc.onOverride).toHaveBeenCalledWith("/visualComplexity", "low");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ visualComplexity: "low" }));
  });

  it("semantic entity text edits stay local while typing (spaces preserved) and commit once on blur", () => {
    const oc = makeOverrideContext();
    const value: FactEnrichment = { ...EFFECTIVE, semanticEntities: [SEMANTIC_ENTITY] };
    const onChange = vi.fn();

    render(
      <EnrichmentEditor
        value={value}
        status="ok"
        onChange={onChange}
        overrideContext={oc}
      />,
    );

    const input = screen.getByDisplayValue("hands signing") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hands signing " } });

    // Mid-typing: the edit lives only in the field's local buffer. Nothing is
    // persisted and nothing is folded back, so the trailing space survives no
    // matter how long the moderator pauses.
    expect(input.value).toBe("hands signing ");
    expect(onChange).not.toHaveBeenCalled();
    expect(oc.onOverride).not.toHaveBeenCalled();

    // Blur commits exactly once: optimistic draft update + override write.
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      semanticEntities: [expect.objectContaining({ visualReferent: "hands signing " })],
    }));
    expect(oc.onOverride).toHaveBeenCalledTimes(1);
    expect(oc.onOverride).toHaveBeenCalledWith(
      "/semanticEntities",
      [expect.objectContaining({ visualReferent: "hands signing " })],
    );

    // A no-op blur (no further edits) does not write again. (After commit the
    // field shows the committed prop value again — the mock parent here never
    // feeds the optimistic update back, so that's the original text.)
    fireEvent.blur(screen.getByDisplayValue("hands signing"));
    expect(oc.onOverride).toHaveBeenCalledTimes(1);
  });

  it("structural semantic-entity edits (remove row) persist immediately — no deferral window to lose", () => {
    const oc = makeOverrideContext();
    const value: FactEnrichment = { ...EFFECTIVE, semanticEntities: [SEMANTIC_ENTITY] };
    const onChange = vi.fn();

    render(
      <EnrichmentEditor
        value={value}
        status="ok"
        onChange={onChange}
        overrideContext={oc}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove semantic entity"));

    expect(oc.onOverride).toHaveBeenCalledWith("/semanticEntities", []);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ semanticEntities: [] }));
  });

  it("review mode (no override context) keeps per-keystroke draft updates for entity text fields", () => {
    const value: FactEnrichment = { ...EFFECTIVE, semanticEntities: [SEMANTIC_ENTITY] };
    const onChange = vi.fn();

    render(<EnrichmentEditor value={value} status="ok" onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue("hands signing"), {
      target: { value: "hands signing " },
    });

    // The localStorage-backed review draft sees every keystroke, as before.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      semanticEntities: [expect.objectContaining({ visualReferent: "hands signing " })],
    }));
  });

  it("a Visual Strategy Override edit calls onChange only — never the override endpoints", () => {
    const oc = makeOverrideContext();
    const { onChange } = renderDualMode(oc);

    // The panel always renders (the enable toggle was retired); editing a panel
    // field (moderator intent) flows through onChange as the additive VSO layer.
    fireEvent.change(screen.getByTestId("vso-moderator-intent"), { target: { value: "art-direction note" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as FactEnrichment;
    expect(next.visualPromptStrategyOverride?.moderatorIntent).toBe("art-direction note");
    expect(oc.onOverride).not.toHaveBeenCalled();
  });

  it("editing the final hashtag list calls onFinalHashtagsChange, not onChange", () => {
    const { onChange, onFinalHashtagsChange } = renderDualMode(makeOverrideContext());

    // Remove one curated tag via its chip's remove button.
    const chip = screen.getByText("earth").closest("span");
    const removeBtn = chip?.querySelector("button");
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn!);

    expect(onFinalHashtagsChange).toHaveBeenCalledWith(["pushups"]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
