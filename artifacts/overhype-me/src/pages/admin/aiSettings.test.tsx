/**
 * The read-only AI settings page (David, 2026-11-14): it shows each step's
 * values and every prompt, and offers no control that could change one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import AdminAiSettings from "./aiSettings";

const VIEW = {
  steps: [
    {
      step: "Gag writer (visual gags and joke read)",
      engine: "OpenAI — Gag Writer",
      model: "gpt-6-astra",
      parameters: [
        { name: "Reasoning effort", value: "medium" },
        { name: "Token limit", value: "12000" },
        { name: "Temperature", value: "not sent" },
      ],
      promptKey: "fact_visual_concepts_system",
    },
  ],
  prompts: [{ key: "fact_visual_concepts_system", label: "Visual Concepts — System Prompt", description: "Drafts the gags.", text: "You write visual gags." }],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AdminAiSettings", () => {
  it("shows each step's model and parameters as sent, and its prompt, with nothing editable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(VIEW), { status: 200 })));
    render(<AdminAiSettings />);
    expect(await screen.findByText("Gag writer (visual gags and joke read)")).toBeTruthy();
    expect(screen.getByText("gpt-6-astra")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("not sent")).toBeTruthy();
    expect(screen.getAllByText("Visual Concepts — System Prompt").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("says plainly when the settings cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    render(<AdminAiSettings />);
    expect(await screen.findByText("Could not load the AI settings (HTTP 403)")).toBeTruthy();
  });
});
