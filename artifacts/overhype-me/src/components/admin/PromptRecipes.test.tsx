/**
 * PromptRecipes — the prompt tuner's wording editor. Opens on a settled engine
 * family showing its live version; editing a piece marks it changed; saving
 * sends only the changed pieces with the version they were based on and a
 * note; a server refusal is shown; promoting asks a confirmation, and a policy
 * change asks a second before resending with confirmPolicy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PromptRecipes } from "./PromptRecipes";

const PIECES = [
  { key: "identity.person", label: "Identity: a person's photo", group: "identity", when: "Always.", slots: [], policy: false, baseline: "Use the reference image." },
  { key: "violence.allow", label: "Violence shown, without gore", group: "violence", when: "Sometimes.", slots: [], policy: true, baseline: "No gore." },
  { key: "constraints.duplicate", label: "Do-not: duplicates", group: "constraints", when: "Sometimes.", slots: ["subject"], policy: false, baseline: "Do not clone {subject}." },
];
const FAMILIES = [
  { family: "flux-3", engines: [], liveVersionId: null, versions: [], promotions: [] },
  { family: "gpt-image-2-6", engines: [], liveVersionId: 11, promotions: [], versions: [
    { id: 11, number: 1, note: "shorter identity", createdBy: null, createdAt: "2026-11-12T00:00:00Z", pieces: { "identity.person": "Use the photo as the face.", "violence.allow": "No gore.", "constraints.duplicate": "Do not clone {subject}." } },
  ] },
];

let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let saveResponse: { status: number; body: unknown } = { status: 201, body: { version: { id: 12, number: 2 } } };
let promoteResponses: Array<{ status: number; body: unknown }> = [];

beforeEach(() => {
  posts = [];
  promoteResponses = [];
  saveResponse = { status: 201, body: { version: { id: 12, number: 2 } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      const res = url.endsWith("/promote") ? (promoteResponses.shift() ?? { status: 200, body: {} }) : saveResponse;
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ pieces: PIECES, families: FAMILIES }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("PromptRecipes", () => {
  it("opens on a settled engine with its live version, and saves only the changed pieces with their base and a note", async () => {
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    expect((screen.getByTestId("recipes-family") as HTMLSelectElement).value).toBe("gpt-image-2-6");
    expect(screen.getByTestId("recipes-live").textContent).toMatch(/Version 1/);
    const identity = screen.getByTestId("recipes-piece-identity.person") as HTMLTextAreaElement;
    expect(identity.value).toBe("Use the photo as the face.");
    const save = () => screen.getByTestId("recipes-save") as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(identity, { target: { value: "Keep the face exactly." } });
    expect(save().disabled).toBe(true); // still needs a note
    fireEvent.change(screen.getByTestId("recipes-note"), { target: { value: "stricter likeness" } });
    fireEvent.click(save());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/admin/prompt-recipes/gpt-image-2-6/versions");
    expect(posts[0]!.body).toEqual({ pieces: { "identity.person": "Keep the face exactly." }, note: "stricter likeness", basedOnVersionId: 11 });
    expect((await screen.findByTestId("recipes-notice")).textContent).toMatch(/version 2.*Nothing live has changed/);
  });

  it("shows the server's reasons when a version is refused", async () => {
    saveResponse = { status: 409, body: { refusal: "the wording is not valid", problems: ["Do-not: duplicates: must contain {subject}"] } };
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    fireEvent.change(screen.getByTestId("recipes-piece-constraints.duplicate"), { target: { value: "Never clone." } });
    fireEvent.change(screen.getByTestId("recipes-note"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("recipes-save"));
    expect((await screen.findByTestId("recipes-problems")).textContent).toMatch(/must contain \{subject\}/);
  });

  it("asks a second confirmation before promoting a policy change, then resends with confirmPolicy", async () => {
    promoteResponses = [
      { status: 409, body: { error: "recipe_refused", needsPolicyConfirmation: true, changedPolicy: ["violence.allow"] } },
      { status: 200, body: {} },
    ];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    fireEvent.click(screen.getByTestId("recipes-promote-baseline"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]![0]).toMatch(/policy wording: Violence shown, without gore/);
    expect(posts[0]!.body).toEqual({ versionId: null });
    expect(posts[1]!.body).toEqual({ versionId: null, confirmPolicy: true });
  });

  it("locks the editor while a save is in flight, and releases it once the saved version is applied (Codex, PR #926)", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") await held;
      return base(url as string, init as RequestInit);
    });
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    fireEvent.change(screen.getByTestId("recipes-piece-identity.person"), { target: { value: "Keep the face." } });
    fireEvent.change(screen.getByTestId("recipes-note"), { target: { value: "n" } });
    fireEvent.click(screen.getByTestId("recipes-save"));
    await waitFor(() => expect((screen.getByTestId("recipes-family") as HTMLSelectElement).disabled).toBe(true));
    expect((screen.getByTestId("recipes-piece-identity.person") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId("recipes-note") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByTestId("recipes-edit-11") as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByTestId("recipes-notice");
    expect((screen.getByTestId("recipes-family") as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByTestId("recipes-piece-identity.person") as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("keeps the draft when a save is refused", async () => {
    saveResponse = { status: 409, body: { refusal: "the wording does not fit the prompt", problems: ["too long"] } };
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    fireEvent.change(screen.getByTestId("recipes-piece-identity.person"), { target: { value: "My long wording." } });
    fireEvent.change(screen.getByTestId("recipes-note"), { target: { value: "n" } });
    fireEvent.click(screen.getByTestId("recipes-save"));
    await screen.findByTestId("recipes-problems");
    expect((screen.getByTestId("recipes-piece-identity.person") as HTMLTextAreaElement).value).toBe("My long wording.");
    expect((screen.getByTestId("recipes-family") as HTMLSelectElement).disabled).toBe(false);
  });

  it("does nothing when the first confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PromptRecipes />);
    await screen.findByTestId("recipes-editor");
    fireEvent.click(screen.getByTestId("recipes-promote-baseline"));
    expect(posts).toHaveLength(0);
  });
});
