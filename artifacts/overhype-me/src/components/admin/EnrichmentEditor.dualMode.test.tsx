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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type FactEnrichment,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { EnrichmentEditor, type EnrichmentOverrideContext } from "./EnrichmentEditor";
import { VisualConceptCard } from "./VisualConceptCard";
import { useFactEnrichmentEditing, type EnrichmentEditTarget } from "./useFactEnrichmentEditing";

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


// ── Opening the editor from the SAVED enrichment (no supplied override flag) ───
//
// The UAT steps below reopen the editor after a save, and the "Overridden"
// bar must come from what the server stored. So these tests drive the real
// `useFactEnrichmentEditing` hook against a stateful fetch stub that keeps the
// saved enrichment and derives `overrideSummary.hasVisualStrategyOverride` from
// it the way the server does: any override content other than the Visual
// Concept (core scene) counts.

type Summary = EnrichmentOverrideContext["summary"];

function summaryFromSaved(e: FactEnrichment): Summary {
  const ov = e.visualPromptStrategyOverride;
  const hasReal =
    !!ov &&
    (ov.requiredVisualDetails.length > 0 ||
      ov.forbiddenVisualDetails.length > 0 ||
      ov.roleBindings.length > 0 ||
      ov.bubbles.length > 0 ||
      ov.compositionGuidance.length > 0 ||
      ov.styleAgnosticPromptAdditions.length > 0 ||
      ov.negativePromptAdditions.length > 0 ||
      !!ov.moderatorIntent?.trim() ||
      !!ov.subjectRealizationOverride ||
      !!ov.supportingTextPolicyOverride ||
      !!ov.violencePolicyOverride);
  return {
    hasOverrides: false,
    overriddenPaths: [],
    baselineChangedPaths: [],
    invalidPaths: [],
    crossFieldInvalid: false,
    hasVisualStrategyOverride: hasReal,
  } as Summary;
}

/** In-memory server: PATCH stores what it is sent; every later GET reads it back. */
function statefulServer(initial: FactEnrichment) {
  const state = { saved: initial };
  const patches: { url: string; body: { enrichment: FactEnrichment } }[] = [];
  const resolvedReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      const method = opts?.method ?? "GET";
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u === "/api/ai/tokenize-enrichment" && method === "POST") {
        const body = JSON.parse(String(opts!.body)) as { entries: { path: string; value: string }[] };
        return json({ results: body.entries.map((e) => ({ path: e.path, value: e.value, changed: false, usedLlm: false })) });
      }
      if (method === "PATCH" && /\/(candidate-)?enrichment$/.test(u)) {
        const body = JSON.parse(String(opts!.body)) as { enrichment: FactEnrichment };
        patches.push({ url: u, body });
        state.saved = body.enrichment;
        return json({ enrichment: state.saved });
      }
      if (u.endsWith("/enrichment-resolved") || u.endsWith("/candidate-enrichment-resolved")) {
        resolvedReads.push(u);
        return json({
          aiDerived: BASELINE,
          overrides: {},
          effective: state.saved,
          overrideSummary: summaryFromSaved(state.saved),
          enrichmentStatus: "ok",
        });
      }
      if (/\/api\/admin\/facts\/\d+$/.test(u)) {
        return json({ id: 7, enrichment: state.saved, enrichmentStatus: "ok" });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return { state, patches, resolvedReads };
}

/** The editor as a moderator opens it: loaded by the hook, Visual Concept card beside it. */
function OpenedEditor({ target }: { target: EnrichmentEditTarget }) {
  const h = useFactEnrichmentEditing({
    target,
    enabled: true,
    editableUntrackedFields: ["visualPromptStrategyOverride"],
  });
  const [saved, setSaved] = useState<boolean | null>(null);
  return (
    <div>
      {h.enrichment && (
        <VisualConceptCard
          value={h.enrichment.visualPromptStrategyOverride}
          onChange={(next) =>
            h.draft.setValue((prev) => ({ ...(prev as FactEnrichment), visualPromptStrategyOverride: next }))
          }
        />
      )}
      {h.enrichment && (
        <EnrichmentEditor
          value={h.enrichment}
          status={h.enrichmentStatus}
          onChange={(next) => h.draft.setValue(next)}
          overrideContext={h.overrideContext}
          vsoTokenizing={h.vsoTokenizing}
          vsoTokenizeErrors={h.vsoTokenizeErrors}
        />
      )}
      <button type="button" onClick={() => void h.tokenizeAndSaveVisualOverride(["David"]).then(setSaved)}>
        Save the override
      </button>
      <span data-testid="save-result">{String(saved)}</span>
    </div>
  );
}

const FACT_TARGET: EnrichmentEditTarget = { kind: "fact", factId: 7 };

function vso(over: Partial<VisualPromptStrategyOverride> = {}): VisualPromptStrategyOverride {
  return { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, ...over };
}

/** The container of one StringListEditor, found by its field label. */
function listEditor(label: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(label);
  while (el && !within(el).queryByRole("button", { name: /^add$/i })) el = el.parentElement;
  if (!el) throw new Error(`no list editor for ${label}`);
  return el;
}

const overriddenBar = () => screen.queryByText("Overridden:")?.parentElement ?? null;

/** Open the editor and wait until the resolved override state has been read and
 *  applied, so an absent bar means "the saved data says no", not "not loaded yet". */
async function openAndWait(
  server: { resolvedReads: string[] },
  target: EnrichmentEditTarget = FACT_TARGET,
) {
  const before = server.resolvedReads.length;
  render(<OpenedEditor target={target} />);
  await screen.findByText("AI Visual Classification");
  await waitFor(() => expect(server.resolvedReads.length).toBeGreaterThan(before));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

/** Click Save, then close and reopen the editor so everything shown is re-read from the server. */
async function saveAndReopen(
  server: { resolvedReads: string[] },
  target: EnrichmentEditTarget = FACT_TARGET,
) {
  fireEvent.click(screen.getByRole("button", { name: "Save the override" }));
  await waitFor(() => expect(screen.getByTestId("save-result").textContent).toBe("true"));
  cleanup();
  await openAndWait(server, target);
}

describe("EnrichmentEditor opened from the saved enrichment (UAT PR582 / PR585 editor clauses)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a refresh candidate's enrichment shows the override's core scene and required visual detail text verbatim in its Visual Concept and override fields", async () => {
    const CORE = "A knight in sparkling armor rides a very slow snail across a supermarket car park";
    const DETAIL = "a golden spur on the snail's left shell, glinting in the sun";
    const server = statefulServer(
      makeCandidateEnrichment(vso({ coreSceneOverride: CORE, requiredVisualDetails: [DETAIL] })),
    );
    await openAndWait(server, { kind: "reviewCandidate", reviewId: 31, factId: 42 });

    await waitFor(() =>
      expect((screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe(CORE),
    );
    const required = within(listEditor("Required Visual Details"));
    expect((required.getByDisplayValue(DETAIL) as HTMLInputElement).value).toBe(DETAIL);
  });

  it("the Enrichment editor shows no Overridden bar for a fact with no override or only an empty scaffold", async () => {
    for (const saved of [
      makeCandidateEnrichment(undefined),
      makeCandidateEnrichment(EMPTY_VISUAL_STRATEGY_OVERRIDE),
    ]) {
      const server = statefulServer(saved);
      await openAndWait(server);
      expect(screen.queryByText("Overridden:")).toBeNull();
      expect(screen.queryByText(/Visual Strategy$/)).toBeNull();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("reopening the editor after saving a new required visual detail shows the saved detail, loaded through the save and reload path", async () => {
    const server = statefulServer(makeCandidateEnrichment(vso({ coreSceneOverride: "A concept" })));
    const { patches } = server;
    await openAndWait(server);
    expect(within(listEditor("Required Visual Details")).queryByDisplayValue("uat-582-scratch")).toBeNull();

    fireEvent.click(within(listEditor("Required Visual Details")).getByRole("button", { name: /^add$/i }));
    fireEvent.change(within(listEditor("Required Visual Details")).getByPlaceholderText(/recognizable face/), {
      target: { value: "uat-582-scratch" },
    });
    await saveAndReopen(server);

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe("/api/admin/facts/7/enrichment");
    await waitFor(() =>
      expect(
        (within(listEditor("Required Visual Details")).getByDisplayValue("uat-582-scratch") as HTMLInputElement).value,
      ).toBe("uat-582-scratch"),
    );
  });

  it("reopening the editor after saving a real override shows the orange Overridden: Visual Strategy bar, driven by the saved enrichment rather than a supplied flag", async () => {
    const server = statefulServer(makeCandidateEnrichment(vso({ coreSceneOverride: "A concept" })));
    await openAndWait(server);
    expect(overriddenBar()).toBeNull();

    fireEvent.click(within(listEditor("Required Visual Details")).getByRole("button", { name: /^add$/i }));
    fireEvent.change(within(listEditor("Required Visual Details")).getByPlaceholderText(/recognizable face/), {
      target: { value: "uat-585-scratch" },
    });
    // Saving did not raise the bar on the still-open editor: it is read at load.
    await saveAndReopen(server);

    await waitFor(() => expect(overriddenBar()).not.toBeNull());
    expect(overriddenBar()!.textContent).toMatch(/^Overridden:\s*Visual Strategy$/);
    expect(screen.getByText("Overridden:").className).toContain("text-primary");
  });

  it("reopening the editor after clearing that override shows no Overridden: Visual Strategy bar, driven by the saved enrichment rather than a supplied flag", async () => {
    const server = statefulServer(
      makeCandidateEnrichment(vso({ coreSceneOverride: "A concept", requiredVisualDetails: ["uat-585-scratch"] })),
    );
    await openAndWait(server);
    await waitFor(() => expect(overriddenBar()).not.toBeNull());
    expect(overriddenBar()!.textContent).toMatch(/Overridden:\s*Visual Strategy/);

    fireEvent.click(within(listEditor("Required Visual Details")).getByRole("button", { name: "Remove" }));
    await saveAndReopen(server);

    await waitFor(() =>
      expect(within(listEditor("Required Visual Details")).queryByDisplayValue("uat-585-scratch")).toBeNull(),
    );
    expect(screen.queryByText("Overridden:")).toBeNull();
    expect(screen.queryByText("Visual Strategy")).toBeNull();
  });

  it("a fact with completed enrichment opens with archetype, subtype and fit populated and no error banner", async () => {
    const server = statefulServer(makeCandidateEnrichment(undefined));
    await openAndWait(server);

    const values = (screen.getAllByRole("combobox") as HTMLSelectElement[]).map((c) => c.value);
    expect(values).toContain("superhuman_physical_feat"); // archetype
    expect(values).toContain("force_scaled_action"); // subtype
    expect(values).toContain("strong"); // overhype fit
    expect(screen.getByText("ok")).toBeTruthy(); // status: ok
    expect(screen.queryByText(/No AI enrichment available/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("with only the Visual Concept set there is no Overridden Visual Strategy bar and the classification fields are still populated", async () => {
    const server = statefulServer(makeCandidateEnrichment(vso({ coreSceneOverride: "Only a concept, nothing else overridden" })));
    await openAndWait(server);

    expect((screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe(
      "Only a concept, nothing else overridden",
    );
    expect(screen.queryByText("Overridden:")).toBeNull();
    expect(screen.queryByText("Visual Strategy")).toBeNull();
    const values = (screen.getAllByRole("combobox") as HTMLSelectElement[]).map((c) => c.value);
    expect(values).toEqual(expect.arrayContaining(["superhuman_physical_feat", "force_scaled_action", "strong", "medium"]));
  });

  it("shows the Overridden Visual Strategy bar when the summary reports real override content", () => {
    const oc = makeOverrideContext({
      overrides: {},
      summary: {
        overriddenPaths: [],
        baselineChangedPaths: [],
        hasVisualStrategyOverride: true,
      },
    });
    render(
      <EnrichmentEditor
        value={{
          ...EFFECTIVE,
          visualPromptStrategyOverride: vso({ coreSceneOverride: "A concept", requiredVisualDetails: ["a real detail"] }),
        }}
        status="ok"
        onChange={vi.fn()}
        overrideContext={oc}
      />,
    );
    expect(screen.getByText("Overridden:").parentElement?.textContent).toMatch(/^Overridden:\s*Visual Strategy$/);
  });
});

/** A completed, valid enrichment as the server stores it (three or more hashtags). */
function makeCandidateEnrichment(ov: VisualPromptStrategyOverride | undefined): FactEnrichment {
  const complete = { ...BASELINE, suggestedHashtags: ["strength", "legendary", "earth"] };
  return ov ? { ...complete, visualPromptStrategyOverride: ov } : complete;
}
