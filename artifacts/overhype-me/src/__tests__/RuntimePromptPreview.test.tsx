import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";

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
      secondaryCharacters: [{ label: "mother", visualRole: "adult woman seated in the front passenger seat" }],
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
  fireEvent.click(screen.getByText(/Prompt Diagnostics/i));
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

  it("review-render mode: derives t2i fallback gender from sample pronouns until overridden", async () => {
    localStorage.clear();
    render(<RuntimePromptPreview factId={7} reviewIdForRender={6309} />);
    expand();

    // Review-render mode defaults to t2i_fallback, so the gender control shows.
    const genderSel = screen.getByTestId("rpp-fallback-gender") as HTMLSelectElement;

    // Blank pronouns ⇒ the brand-default he/him sample ⇒ male (NOT neutral), so the
    // default "just click Generate" path doesn't hit the t2i validator failure.
    await waitFor(() => expect(genderSel.value).toBe("male"));

    // he/him → male; she/her → female; they/them → neutral — all derived live.
    fireEvent.change(screen.getByTestId("rpp-preview-pronouns"), { target: { value: "they/them" } });
    await waitFor(() => expect(genderSel.value).toBe("neutral"));
    fireEvent.change(screen.getByTestId("rpp-preview-pronouns"), { target: { value: "she/her" } });
    await waitFor(() => expect(genderSel.value).toBe("female"));

    // Generate sends the derived gender.
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/preview"))).toBe(true));
    expect((calls.find((c) => c.url.includes("/preview"))!.body!.renderControls as Record<string, unknown>).fallbackSubjectGender).toBe("female");

    // Once the moderator manually picks a gender, pronouns no longer override it.
    fireEvent.change(genderSel, { target: { value: "neutral" } });
    fireEvent.change(screen.getByTestId("rpp-preview-pronouns"), { target: { value: "he/him" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(genderSel.value).toBe("neutral");
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

  it("marks a moderator-authored section with the MODERATOR chip", async () => {
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        promptBreakdown: [
          { id: "core_scene", label: "CORE SCENE", priority: "required", status: "included", text: "David rides a giant rubber duck.", rawText: "David rides a giant rubber duck.", moderatorAuthored: true },
          { id: "subject_details", label: "SUBJECT DETAILS", priority: "high", status: "included", text: "confident grin.", rawText: "confident grin." },
        ],
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-breakdown")).toBeTruthy());

    const core = screen.getByTestId("rpp-breakdown-section-core_scene");
    expect(within(core).getByTestId("rpp-moderator-chip").textContent).toMatch(/moderator/i);
    // Non-moderator sections carry no chip.
    expect(within(screen.getByTestId("rpp-breakdown-section-subject_details")).queryByTestId("rpp-moderator-chip")).toBeNull();
  });

  it("shows planner provenance for a dedicated-engine plan and a loud banner on fallback", async () => {
    const provenance = (fallbackReason: string | null) => ({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        diagnostics: {
          removedPlannerProseSentences: [],
          warnings: [],
          plannerProvenance: {
            configuredEngineId: "openai-visual-planner",
            resolvedEngineId: fallbackReason ? null : "openai-visual-planner",
            model: fallbackReason ? null : "gpt-5.5",
            reasoningEffort: fallbackReason ? null : "xhigh",
            timeoutMs: 180000,
            fallbackReason,
          },
        },
      },
    });

    installFetch({ previewBody: previewResponse(provenance(null)) });
    const { unmount } = render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-planner-provenance")).toBeTruthy());
    expect(screen.getByTestId("rpp-planner-provenance").textContent).toContain("gpt-5.5");
    expect(screen.getByTestId("rpp-planner-provenance").textContent).toContain("xhigh");
    unmount();
    localStorage.clear();

    installFetch({ previewBody: previewResponse(provenance("engine_inactive")) });
    render(<RuntimePromptPreview factId={43} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-planner-fallback")).toBeTruthy());
    expect(screen.getByTestId("rpp-planner-fallback").textContent).toMatch(/FALLBACK/);
    expect(screen.getByTestId("rpp-planner-fallback").textContent).toContain("engine_inactive");
  });

  it("renders the moderator core-scene warnings as amber diagnostics", async () => {
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        diagnostics: {
          removedPlannerProseSentences: [],
          warnings: [
            { code: "moderator_core_scene_stripped", severity: "warning", message: "Some Visual concept text was stripped because the compiler owns identity/reference/text-policy instructions. Rewrite this field as visible scene description only." },
            { code: "moderator_core_scene_empty_after_sanitize", severity: "warning", message: "The Visual concept became empty after stripping compiler-owned instructions, so the AI scene was used instead." },
          ],
        },
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-diagnostics")).toBeTruthy());

    const warnings = screen.getAllByTestId("rpp-tone-warning").map((el) => el.textContent ?? "");
    expect(warnings.join(" ")).toMatch(/Visual concept text was stripped/);
    expect(warnings.join(" ")).toMatch(/AI scene was used instead/);
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
    fireEvent.click(screen.getByText(/Prompt Diagnostics/i));
    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());
    expect(screen.getByTestId("rpp-compiled-prompt").textContent).toContain("COMPILED IMAGE PROMPT TEXT");
    expect(calls.some((c) => c.url.includes("/api/admin/image-prompt/preview"))).toBe(false);
  });
});
