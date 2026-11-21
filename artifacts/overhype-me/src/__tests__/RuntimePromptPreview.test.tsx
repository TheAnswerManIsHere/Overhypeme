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

  it("maps control changes into the request body (mode + persist + render controls)", async () => {
    render(<RuntimePromptPreview factId={7} />);
    expand();

    fireEvent.change(screen.getByTestId("rpp-subject-render-mode"), { target: { value: "nonhuman_subject_i2i" } });
    fireEvent.change(screen.getByTestId("rpp-aspect-ratio"), { target: { value: "landscape" } });
    fireEvent.click(screen.getByTestId("rpp-persist"));
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(calls.some((c) => c.url.includes("/preview"))).toBe(true));
    const body = calls.find((c) => c.url.includes("/preview"))!.body!;
    expect(body.factId).toBe(7);
    expect(body.subjectRenderMode).toBe("nonhuman_subject_i2i");
    expect(body.persist).toBe(true);
    // Every picture starts from a photo: the synthetic analysis is always sent.
    expect(body.sourceImageAnalysis).toBeDefined();
    const rc = body.renderControls as Record<string, unknown>;
    expect(rc.fallbackSubjectGender).toBeUndefined();
    expect(rc.aspectRatio).toBe("landscape");
  });

  it("offers no no-photo mode, and review-render mode starts from a person's photo", async () => {
    localStorage.clear();
    render(<RuntimePromptPreview factId={7} reviewIdForRender={6309} />);
    expand();

    const modeSel = screen.getByTestId("rpp-subject-render-mode") as HTMLSelectElement;
    expect([...modeSel.options].map((o) => o.value)).not.toContain("t2i_fallback");
    expect(modeSel.value).toBe("human_identity_i2i");
    expect(screen.queryByTestId("rpp-fallback-gender")).toBeNull();
  });

  it("names the gag, not the taxonomy, when the gag can't be read as a render input", async () => {
    installFetch({ previewStatus: 400, previewBody: { error: "gag_render_input_invalid", details: "bad" } });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(screen.getByTestId("rpp-error")).toBeTruthy());
    expect(screen.getByTestId("rpp-error").textContent).toMatch(/This gag can't be turned into a picture prompt: bad\. Fix the gag's scene/);
    expect(screen.getByTestId("rpp-error").textContent).not.toMatch(/taxonomy/i);
  });

  it("shows no planner panel: no visual-plan debug and no planner provenance (the planner was removed, plan PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-compiled-prompt")).toBeTruthy());
    for (const id of ["rpp-toggle-visual-plan", "rpp-visual-plan", "rpp-planner-provenance", "rpp-planner-fallback"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
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

  it("shows the moderator_core_scene_owned_language warning's message in the diagnostics when the response carries it", async () => {
    const message = 'The Visual concept contains identity language the compiler owns ("preserve his recognizable face"). It is rendered verbatim as authored; rewrite it as visible scene description only so the compiler\'s identity/reference/text-policy clauses stay the single source.';
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        diagnostics: {
          removedPlannerProseSentences: [],
          warnings: [{ code: "moderator_core_scene_owned_language", severity: "warning", message }],
        },
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-diagnostics")).toBeTruthy());

    const warnings = screen.getAllByTestId("rpp-tone-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].textContent).toBe(message);
    expect(warnings[0].textContent).toContain('"preserve his recognizable face"');
    expect(warnings[0].textContent).toContain("rewrite it as visible scene description only");
  });

  it("choosing a style in rpp-look-style sends that style's id as lookStyleId in the preview request body", async () => {
    render(<RuntimePromptPreview factId={42} />);
    expand();
    const select = screen.getByTestId("rpp-look-style") as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByText("Cinematic")).toBeTruthy());

    fireEvent.change(select, { target: { value: "cinematic" } });
    expect(select.value).toBe("cinematic");
    fireEvent.click(screen.getByTestId("rpp-generate"));

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/admin/image-prompt/preview"))).toBe(true));
    const body = calls.find((c) => c.url.includes("/api/admin/image-prompt/preview"))!.body!;
    expect(body.lookStyleId).toBe("cinematic");
  });

  it("lists the bubble_entity_unresolved note in the diagnostics when the preview response carries it", async () => {
    const message = 'Bubble 1 is attributed to "mailman", which matches no character in the scene (subject, role bindings, or planned secondary characters). The directive still renders; the model may introduce, ignore, or misattribute that character — confirm the render.';
    const body = previewResponse({
      compiledPrompt: {
        prompt: "PROMPT TEXT",
        imagePrompt: "COMPILED IMAGE PROMPT TEXT",
        negativePrompt: "",
        diagnostics: {
          removedPlannerProseSentences: [],
          warnings: [{ code: "bubble_entity_unresolved", severity: "warning", message, context: { bubbleIndex: 0, entity: "mailman" } }],
        },
      },
    });
    installFetch({ previewBody: body });
    render(<RuntimePromptPreview factId={42} />);
    expand();
    fireEvent.click(screen.getByTestId("rpp-generate"));
    await waitFor(() => expect(screen.getByTestId("rpp-diagnostics")).toBeTruthy());

    const warnings = screen.getAllByTestId("rpp-tone-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].textContent).toBe(message);
    expect(warnings[0].textContent).toContain('attributed to "mailman", which matches no character in the scene');
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
