import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { EnrichmentSummary } from "@/components/admin/EnrichmentEditor";

// ── fetch mock ──────────────────────────────────────────────────────────────

interface Recorded {
  url: string;
  body: Record<string, unknown> | null;
}

let calls: Recorded[];

function previewResponse(overrides: Record<string, unknown> = {}) {
  return {
    renderedFactText: "David bench-presses the Earth.",
    inputSummary: {
      factId: 42,
      subjectRenderMode: "human_identity_i2i",
      generationMode: "i2i",
      targetEngine: "nano_banana_2",
      lookStyleId: null,
      stylePrompt: "",
      styleSource: "none",
      fallbackSubjectGender: null,
      preservePhysique: false,
      aspectRatio: "portrait",
      negativeSpacePreference: "auto",
    },
    visualPlan: {
      sceneConcept: "A scene",
      coreScene: "David grips the wheel of a parked car.",
      subjectDetails: ["infant proportions"],
      environment: ["car interior"],
      lightingAndStyle: "warm daylight",
      semanticEntitiesUsed: [],
    },
    compiledPrompt: {
      prompt: "PROMPT TEXT",
      imagePrompt: "COMPILED IMAGE PROMPT TEXT",
      negativePrompt: "",
    },
    debug: { primaryArchetype: "superhuman_physical_feat" },
    ...overrides,
  };
}

function installFetch(opts: { previewStatus?: number; previewBody?: unknown } = {}) {
  calls = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.includes("/api/look-styles")) {
      return new Response(JSON.stringify([{ id: "cinematic", label: "Cinematic" }]), { status: 200 });
    }
    if (url.includes("/api/admin/image-prompt/preview")) {
      const status = opts.previewStatus ?? 200;
      const payload = opts.previewBody ?? previewResponse();
      return new Response(JSON.stringify(payload), { status });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
}

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

function expand() {
  fireEvent.click(screen.getByText(/Runtime Compiled Prompt Preview/i));
}

// ── RuntimePromptPreview ──────────────────────────────────────────────────────

describe("RuntimePromptPreview", () => {
  it("is collapsed by default and expands to show controls", () => {
    render(<RuntimePromptPreview factId={42} />);
    expect(screen.queryByTestId("rpp-generate")).toBeNull();
    expand();
    expect(screen.getByTestId("rpp-generate")).toBeTruthy();
    expect(screen.getByTestId("rpp-subject-render-mode")).toBeTruthy();
  });

  it("generates a preview and renders the compiled prompt + input summary", async () => {
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());
    expect(screen.getByTestId("rpp-compiled-prompt").textContent).toContain("COMPILED IMAGE PROMPT TEXT");

    const post = calls.find((c) => c.url.includes("/api/admin/image-prompt/preview"));
    expect(post).toBeTruthy();
    expect(post!.body!.factId).toBe(42);
    expect(post!.body!.subjectRenderMode).toBe("human_identity_i2i");
    expect(post!.body!.persist).toBe(false);
    // i2i mode sends a synthetic sourceImageAnalysis blob.
    expect(post!.body!.sourceImageAnalysis).toBeTruthy();

    const summary = screen.getByTestId("rpp-input-summary");
    expect(within(summary).getByText(/human_identity_i2i/)).toBeTruthy();
  });

  it("maps control changes into the request body (t2i + persist + render controls)", async () => {
    render(<RuntimePromptPreview factId={7} />);
    expand();

    fireEvent.change(screen.getByTestId("rpp-subject-render-mode"), { target: { value: "t2i_fallback" } });
    fireEvent.change(screen.getByTestId("rpp-fallback-gender"), { target: { value: "female" } });
    fireEvent.change(screen.getByTestId("rpp-aspect-ratio"), { target: { value: "landscape" } });
    fireEvent.click(screen.getByTestId("rpp-persist"));
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(calls.some((c) => c.url.includes("/preview"))).toBe(true));
    const body = calls.find((c) => c.url.includes("/preview"))!.body!;
    expect(body.factId).toBe(7);
    expect(body.subjectRenderMode).toBe("t2i_fallback");
    expect(body.persist).toBe(true);
    // t2i omits the synthetic source-image analysis (server falls back).
    expect(body.sourceImageAnalysis).toBeUndefined();
    const rc = body.renderControls as Record<string, unknown>;
    expect(rc.fallbackSubjectGender).toBe("female");
    expect(rc.aspectRatio).toBe("landscape");
  });

  it("shows a friendly message when the fact has no usable enrichment", async () => {
    installFetch({ previewStatus: 400, previewBody: { error: "fact_enrichment_invalid", details: "bad" } });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(screen.getByTestId("rpp-error")).toBeTruthy());
    expect(screen.getByTestId("rpp-error").textContent).toMatch(/Backfill enrichment/i);
  });

  it("renders the visual plan debug JSON when toggled", async () => {
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());

    fireEvent.click(screen.getByTestId("rpp-toggle-visual-plan"));
    const planText = screen.getByTestId("rpp-visual-plan").textContent ?? "";
    expect(planText).toContain("sceneConcept");
    // The new concrete visual-contract fields are surfaced too.
    expect(planText).toContain("coreScene");
    expect(planText).toContain("subjectDetails");
    expect(planText).toContain("environment");
    expect(planText).toContain("lightingAndStyle");
  });

  it("renders the per-component prompt breakdown when present", async () => {
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        promptBreakdown: [
          { id: "subject_binding", label: "SUBJECT BINDING", priority: "required", status: "included", text: "The reference person is David.", rawText: "The reference person is David." },
          { id: "lighting_and_style", label: "LIGHTING AND STYLE", priority: "medium", status: "empty", text: "", rawText: "" },
        ],
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-breakdown")).toBeTruthy());

    // Components render with their labels + content; empty ones are marked.
    expect(screen.getByTestId("rpp-breakdown-section-subject_binding").textContent).toContain("The reference person is David.");
    expect(screen.getByTestId("rpp-breakdown-section-lighting_and_style").textContent).toMatch(/no content/i);
  });

  it("surfaces compiler diagnostics: removed prose clauses + tone warning", async () => {
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        diagnostics: {
          removedPlannerProseSentences: [
            { sentence: "Ensure Superman's recognizable face is preserved.", reason: "identity-preservation-owned-by-compiler" },
          ],
          warnings: [
            { code: "possible-tone-split-between-approach-and-prose", severity: "warning", message: "Approach is serious while prose is playful." },
          ],
        },
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-diagnostics")).toBeTruthy());

    expect(screen.getByTestId("rpp-tone-warning").textContent).toMatch(/serious while prose is playful/i);
    expect(screen.getByTestId("rpp-removed-clauses").textContent).toContain("recognizable face is preserved");
    expect(screen.getByTestId("rpp-removed-clauses").textContent).toMatch(/identity preservation/i);
  });

  it("persists the result to localStorage and restores it on remount (no recompute)", async () => {
    localStorage.clear();
    const { unmount } = render(<RuntimePromptPreview factId={99} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());

    // Saved under the per-fact key.
    await waitFor(() => expect(localStorage.getItem("overhype:rpp:v1:99")).toBeTruthy());

    unmount();
    calls = [];
    // Fresh mount: the prior result is restored WITHOUT calling /preview again.
    render(<RuntimePromptPreview factId={99} />);
    fireEvent.click(screen.getByText(/Runtime Compiled Prompt Preview/i));
    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());
    expect(screen.getByTestId("rpp-compiled-prompt").textContent).toContain("COMPILED IMAGE PROMPT TEXT");
    expect(calls.some((c) => c.url.includes("/api/admin/image-prompt/preview"))).toBe(false);
  });
});

// ── Relabeled preview-only summary ───────────────────────────────────────────

describe("EnrichmentSummary preview-only relabel", () => {
  it("labels the example prompts as preview-only", () => {
    const enrichment = {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      modifiers: [],
      visualLiteralness: "literal_dramatization",
      visualComplexity: "medium",
      overhypeFit: "strong",
      adultSuitability: "safe",
      adultSuitabilityNotes: "",
      suggestedHashtags: ["a", "b", "c"],
      taxonomyConfidence: 0.9,
      adminReviewNotes: "",
      culturalReferences: [],
      semanticEntities: [],
      visualPromptPreview: {
        sceneConcept: "A scene",
        selectedFrame: "direct_action",
        exampleI2iPrompt: "i2i example",
        exampleT2iPrompt: "t2i example",
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<EnrichmentSummary e={enrichment as any} />);
    expect(screen.getByText("Preview-only example I2I / T2I prompts")).toBeTruthy();
  });
});
