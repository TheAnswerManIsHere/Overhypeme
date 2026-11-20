/**
 * VisualConceptCandidates — the candidate-concept picker. Covers the server-
 * driven states (null → Generate, pending, failed, stale, ok+current → cards),
 * that a card's action receives the whole idea, that an invalid-token
 * candidate can't be picked, and that stale candidates are hidden behind the
 * server `current` flag (the FE never recomputes hashes).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { VisualConceptsResponse, StoredCandidateConcept } from "@workspace/api-zod";
import { VisualConceptCandidates, type ConceptAction } from "./VisualConceptCandidates";

function candidate(overrides: Partial<StoredCandidateConcept> = {}): StoredCandidateConcept {
  return {
    title: "Courtroom of clocks",
    whyItWorks: "Turns the gag into a scene.",
    sceneDescription: "{NAME} stands amid melting clocks in a marble courtroom.",
    tokenValid: true,
    bubbles: [],
    ...overrides,
  };
}

function okCurrent(candidates: StoredCandidateConcept[]): VisualConceptsResponse {
  return { status: "ok", current: true, candidates };
}

const noop = async () => {};

/** One action, the way most of these tests use a card. */
const one = (run: (c: StoredCandidateConcept) => void): ConceptAction[] => [{ key: "default", label: "Use this instead of the current default gag", run }];

describe("VisualConceptCandidates", () => {
  it("null status → shows Generate and calls onGenerate on click (no cards)", async () => {
    const onGenerate = vi.fn(async () => {});
    render(<VisualConceptCandidates visualConcepts={undefined} actions={one(vi.fn())} onGenerate={onGenerate} />);
    expect(screen.queryByTestId("visual-concepts-cards")).toBeNull();
    expect(screen.getByTestId("visual-concepts-idle")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("visual-concepts-generate"));
    });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("pending → shows a working indicator, no cards", () => {
    render(
      <VisualConceptCandidates
        visualConcepts={{ status: "pending", candidates: [], current: false }}
        actions={one(vi.fn())}
        onGenerate={noop}
      />,
    );
    expect(screen.getByTestId("visual-concepts-pending")).toBeTruthy();
    expect(screen.queryByTestId("visual-concepts-cards")).toBeNull();
  });

  it("failed → non-blocking message + a Regenerate button", () => {
    render(
      <VisualConceptCandidates
        visualConcepts={{ status: "failed", candidates: [], current: false }}
        actions={one(vi.fn())}
        onGenerate={noop}
      />,
    );
    expect(screen.getByTestId("visual-concepts-failed")).toBeTruthy();
    expect(screen.getByTestId("visual-concepts-generate").textContent).toMatch(/Regenerate/);
  });

  it("ok + stale (current:false) → hides candidates, shows the stale reason", () => {
    render(
      <VisualConceptCandidates
        visualConcepts={{ status: "ok", current: false, candidates: [candidate()], staleReason: "input_hash_mismatch" }}
        actions={one(vi.fn())}
        onGenerate={noop}
      />,
    );
    expect(screen.queryByTestId("visual-concepts-cards")).toBeNull();
    expect(screen.getByTestId("visual-concepts-stale").textContent).toMatch(/its gags or the gag writer changed/i);
  });

  it("ok + current → renders the three cards with title + whyItWorks; scene is collapsed until expanded", () => {
    const cands = [candidate({ title: "A" }), candidate({ title: "B" }), candidate({ title: "C" })];
    render(<VisualConceptCandidates visualConcepts={okCurrent(cands)} actions={one(vi.fn())} onGenerate={noop} />);
    expect(screen.getAllByTestId("visual-concept-candidate")).toHaveLength(3);
    expect(screen.getByText("A")).toBeTruthy();
    // Scene hidden until the per-card toggle is clicked.
    expect(screen.queryByTestId("candidate-scene")).toBeNull();
    fireEvent.click(screen.getAllByTestId("candidate-toggle-scene")[0]!);
    expect(screen.getByTestId("candidate-scene").textContent).toMatch(/melting clocks/);
  });

  it("a card's action receives the COMPLETE candidate (scene + bubbles)", () => {
    const onPick = vi.fn();
    const c = candidate({
      sceneDescription: "{NAME} surfs a tidal wave of paperwork.",
      bubbles: [{ type: "speech", entity: "subject", text: "Approved!", tokenValid: true }],
    });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} actions={one(onPick)} onGenerate={noop} />);
    fireEvent.click(screen.getByTestId("candidate-use"));
    expect(onPick).toHaveBeenCalledWith(c);
  });

  it("an invalid-token candidate can't be picked (button disabled, error shown)", () => {
    const onPick = vi.fn();
    const c = candidate({ tokenValid: false, tokenError: "unknown token {WEATHER}" });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} actions={one(onPick)} onGenerate={noop} />);
    const btn = screen.getByTestId("candidate-use") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-concept-candidate").textContent).toMatch(/invalid token/i);
  });

  it("disabled prop blocks Generate and picking", () => {
    const onGenerate = vi.fn(async () => {});
    const onPick = vi.fn();
    render(<VisualConceptCandidates visualConcepts={okCurrent([candidate()])} disabled actions={one(onPick)} onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId("candidate-use"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Regenerate is disabled while a request is in flight, then re-enabled", async () => {
    let resolve: () => void = () => {};
    const onGenerate = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<VisualConceptCandidates visualConcepts={okCurrent([candidate()])} actions={one(vi.fn())} onGenerate={onGenerate} />);
    const btn = () => screen.getByTestId("visual-concepts-generate") as HTMLButtonElement;
    await act(async () => { fireEvent.click(btn()); });
    expect(btn().disabled).toBe(true);
    await act(async () => { resolve(); });
    await waitFor(() => expect(btn().disabled).toBe(false));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("candidate bubble proposals", () => {
  const noop = async () => {};

  it("renders the normalized proposed bubbles on the card (exactly what pick applies)", () => {
    const c = candidate({
      bubbles: [
        { type: "speech", entity: "subject", text: "You're the man of the house now.", tokenValid: true },
        { type: "thought", entity: "the bartender", text: "Not again.", tokenValid: true },
      ],
    });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} actions={one(() => {})} onGenerate={noop} />);
    const rows = screen.getAllByTestId("candidate-bubble");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Speech — subject");
    expect(rows[0]!.textContent).toContain("You're the man of the house now.");
    expect(rows[1]!.textContent).toContain("Thought — the bartender");
  });

  it("one invalid bubble makes the WHOLE concept unpickable (atomic), naming the bubble", () => {
    const onPick = vi.fn();
    const c = candidate({
      bubbles: [
        { type: "speech", entity: "subject", text: "Fine.", tokenValid: true },
        { type: "speech", entity: "{NAME}", text: "Broken.", tokenValid: false, tokenError: "personalization tokens are not allowed here" },
      ],
    });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} actions={one(onPick)} onGenerate={noop} />);
    const btn = screen.getByTestId("candidate-use") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("candidate-unpickable").textContent).toContain("bubble 2");
  });

  it("offers every gag action on each card, and each runs with the idea", () => {
    const toDefault = vi.fn();
    const additional = vi.fn();
    const c = candidate();
    render(
      <VisualConceptCandidates
        visualConcepts={okCurrent([c])}
        actions={[
          { key: "default", label: "Use this instead of the current default gag", run: toDefault },
          { key: "additional", label: "Use as an additional gag", run: additional },
        ]}
        onGenerate={noop}
      />,
    );
    const buttons = screen.getAllByTestId("candidate-use");
    expect(buttons.map((b) => b.textContent)).toEqual(["Use this instead of the current default gag", "Use as an additional gag"]);
    fireEvent.click(buttons[1]!);
    expect(additional).toHaveBeenCalledWith(c);
    expect(toDefault).not.toHaveBeenCalled();
  });

  it("pickBlockedReason disables picking with the reason but keeps the cards rendered", () => {
    const onPick = vi.fn();
    const c = candidate({});
    render(
      <VisualConceptCandidates
        visualConcepts={okCurrent([c])}
        pickBlockedReason="Save or discard your current Visual Strategy changes before using an AI idea — picking applies on top of the saved state."
        actions={one(onPick)}
        onGenerate={noop}
      />,
    );
    expect((screen.getByTestId("candidate-use") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("pick-blocked-note").textContent).toContain("Save or discard");
    expect(screen.getByTestId("candidate-title")).toBeTruthy();
  });
});

describe("the humor note on the Gags step (PLAN_GAG_GENERATOR.md E; no AI read since increment 1.2d)", () => {
  const ideas = (over: Partial<VisualConceptsResponse> = {}): VisualConceptsResponse => ({
    ...okCurrent([candidate(), candidate(), candidate()]),
    humorNote: null,
    ...over,
  });

  it("shows no read of the joke from the gag writer, only the way to write a note", () => {
    // A response from an older server that still carries a read is ignored too.
    const legacy = { ...ideas(), jokeRead: "A revolving door cannot be slammed." } as unknown as VisualConceptsResponse;
    render(<VisualConceptCandidates visualConcepts={legacy} actions={one(vi.fn())} onGenerate={noop} onSaveNote={vi.fn(async () => null)} />);
    expect(screen.queryByText(/The AI's read of the joke/)).toBeNull();
    expect(screen.queryByText(/revolving door cannot be slammed/)).toBeNull();
    expect(screen.getByTestId("humor-note-write")).toBeTruthy();
  });

  it("writes a note and saves it; a failed save says so and keeps the text", async () => {
    const onSaveNote = vi.fn(async () => "Could not save the humor note (500).");
    render(<VisualConceptCandidates visualConcepts={ideas()} actions={one(vi.fn())} onGenerate={noop} onSaveNote={onSaveNote} />);
    fireEvent.click(screen.getByTestId("humor-note-write"));
    fireEvent.change(screen.getByTestId("humor-note-input"), { target: { value: "The door is the victim." } });
    await act(async () => { fireEvent.click(screen.getByTestId("humor-note-save")); });
    expect(onSaveNote).toHaveBeenCalledWith("The door is the victim.");
    expect(screen.getByTestId("humor-note-error").textContent).toMatch(/Could not save/);
    expect((screen.getByTestId("humor-note-input") as HTMLTextAreaElement).value).toBe("The door is the victim.");
  });

  it("a typed note survives a poll that brings a new generation", () => {
    const { rerender } = render(<VisualConceptCandidates visualConcepts={ideas()} actions={one(vi.fn())} onGenerate={noop} onSaveNote={vi.fn(async () => null)} />);
    fireEvent.click(screen.getByTestId("humor-note-write"));
    fireEvent.change(screen.getByTestId("humor-note-input"), { target: { value: "Half-typed note" } });
    rerender(<VisualConceptCandidates visualConcepts={ideas({ generatedAt: new Date(1).toISOString() })} actions={one(vi.fn())} onGenerate={noop} onSaveNote={vi.fn(async () => null)} />);
    expect((screen.getByTestId("humor-note-input") as HTMLTextAreaElement).value).toBe("Half-typed note");
  });

  it("a typed note survives Regenerate: ok → pending → ok, and ok → pending → failed", () => {
    for (const end of [ideas({ generatedAt: new Date(1).toISOString() }), { status: "failed", candidates: [], current: false, humorNote: null } as VisualConceptsResponse]) {
      const save = vi.fn(async () => null);
      const { rerender, unmount } = render(<VisualConceptCandidates visualConcepts={ideas()} actions={one(vi.fn())} onGenerate={noop} onSaveNote={save} />);
      fireEvent.click(screen.getByTestId("humor-note-write"));
      fireEvent.change(screen.getByTestId("humor-note-input"), { target: { value: "Half-typed note" } });
      rerender(<VisualConceptCandidates visualConcepts={{ status: "pending", candidates: [], current: false, humorNote: null }} actions={one(vi.fn())} onGenerate={noop} onSaveNote={save} />);
      expect((screen.getByTestId("humor-note-input") as HTMLTextAreaElement).value).toBe("Half-typed note");
      rerender(<VisualConceptCandidates visualConcepts={end} actions={one(vi.fn())} onGenerate={noop} onSaveNote={save} />);
      expect((screen.getByTestId("humor-note-input") as HTMLTextAreaElement).value).toBe("Half-typed note");
      expect(save).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("a note can be written before any generation has succeeded", async () => {
    const save = vi.fn(async () => null);
    render(<VisualConceptCandidates visualConcepts={{ status: null, candidates: [], current: false, humorNote: null } as unknown as VisualConceptsResponse} actions={one(vi.fn())} onGenerate={noop} onSaveNote={save} />);
    fireEvent.click(screen.getByTestId("humor-note-write"));
    fireEvent.change(screen.getByTestId("humor-note-input"), { target: { value: "Written by hand." } });
    await act(async () => { fireEvent.click(screen.getByTestId("humor-note-save")); });
    expect(save).toHaveBeenCalledWith("Written by hand.");
  });

  it("an approved note shows as approved and can be edited", () => {
    render(<VisualConceptCandidates
      visualConcepts={ideas({ humorNote: { text: "The approved reading.", approvedBy: "u1", approvedAt: new Date().toISOString() } })}
      actions={one(vi.fn())} onGenerate={noop} onSaveNote={vi.fn(async () => null)} />);
    expect(screen.getByTestId("humor-note-approved").textContent).toMatch(/The approved reading\./);
    fireEvent.click(screen.getByTestId("humor-note-edit"));
    expect((screen.getByTestId("humor-note-input") as HTMLTextAreaElement).value).toBe("The approved reading.");
  });

  it("a failed generation shows its reason", () => {
    render(<VisualConceptCandidates
      visualConcepts={{ status: "failed", candidates: [], current: false, humorNote: null, failureReason: 'The gag writer engine "x" cannot be used (engine_inactive).' }}
      actions={one(vi.fn())} onGenerate={noop} onSaveNote={vi.fn(async () => null)} />);
    expect(screen.getByTestId("visual-concepts-failed").textContent).toMatch(/cannot be used/);
  });
});
