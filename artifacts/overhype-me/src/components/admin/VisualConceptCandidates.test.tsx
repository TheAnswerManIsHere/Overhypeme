/**
 * VisualConceptCandidates — the candidate-concept picker. Covers the server-
 * driven states (null → Generate, pending, failed, stale, ok+current → cards),
 * that picking a card writes the scene via onPick, that an invalid-token
 * candidate can't be picked, and that stale candidates are hidden behind the
 * server `current` flag (the FE never recomputes hashes).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { VisualConceptsResponse, StoredCandidateConcept } from "@workspace/api-zod";
import { VisualConceptCandidates } from "./VisualConceptCandidates";

function candidate(overrides: Partial<StoredCandidateConcept> = {}): StoredCandidateConcept {
  return {
    title: "Courtroom of clocks",
    whyItWorks: "Turns the gag into a scene.",
    sceneDescription: "{NAME} stands amid melting clocks in a marble courtroom.",
    tokenValid: true,
    ...overrides,
  };
}

function okCurrent(candidates: StoredCandidateConcept[]): VisualConceptsResponse {
  return { status: "ok", current: true, candidates };
}

const noop = async () => {};

describe("VisualConceptCandidates", () => {
  it("null status → shows Generate and calls onGenerate on click (no cards)", async () => {
    const onGenerate = vi.fn(async () => {});
    render(<VisualConceptCandidates visualConcepts={undefined} onPick={vi.fn()} onGenerate={onGenerate} />);
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
        onPick={vi.fn()}
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
        onPick={vi.fn()}
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
        onPick={vi.fn()}
        onGenerate={noop}
      />,
    );
    expect(screen.queryByTestId("visual-concepts-cards")).toBeNull();
    expect(screen.getByTestId("visual-concepts-stale").textContent).toMatch(/enrichment changed/i);
  });

  it("ok + current → renders the three cards with title + whyItWorks; scene is collapsed until expanded", () => {
    const cands = [candidate({ title: "A" }), candidate({ title: "B" }), candidate({ title: "C" })];
    render(<VisualConceptCandidates visualConcepts={okCurrent(cands)} onPick={vi.fn()} onGenerate={noop} />);
    expect(screen.getAllByTestId("visual-concept-candidate")).toHaveLength(3);
    expect(screen.getByText("A")).toBeTruthy();
    // Scene hidden until the per-card toggle is clicked.
    expect(screen.queryByTestId("candidate-scene")).toBeNull();
    fireEvent.click(screen.getAllByTestId("candidate-toggle-scene")[0]!);
    expect(screen.getByTestId("candidate-scene").textContent).toMatch(/melting clocks/);
  });

  it('"Use as draft" calls onPick with the candidate\'s scene text', () => {
    const onPick = vi.fn();
    const c = candidate({ sceneDescription: "{NAME} surfs a tidal wave of paperwork." });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} onPick={onPick} onGenerate={noop} />);
    fireEvent.click(screen.getByTestId("candidate-use"));
    expect(onPick).toHaveBeenCalledWith("{NAME} surfs a tidal wave of paperwork.");
  });

  it("an invalid-token candidate can't be picked (button disabled, error shown)", () => {
    const onPick = vi.fn();
    const c = candidate({ tokenValid: false, tokenError: "unknown token {WEATHER}" });
    render(<VisualConceptCandidates visualConcepts={okCurrent([c])} onPick={onPick} onGenerate={noop} />);
    const btn = screen.getByTestId("candidate-use") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-concept-candidate").textContent).toMatch(/invalid token/i);
  });

  it("disabled prop blocks Generate and picking", () => {
    const onGenerate = vi.fn(async () => {});
    const onPick = vi.fn();
    render(<VisualConceptCandidates visualConcepts={okCurrent([candidate()])} disabled onPick={onPick} onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId("candidate-use"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Regenerate is disabled while a request is in flight, then re-enabled", async () => {
    let resolve: () => void = () => {};
    const onGenerate = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<VisualConceptCandidates visualConcepts={okCurrent([candidate()])} onPick={vi.fn()} onGenerate={onGenerate} />);
    const btn = () => screen.getByTestId("visual-concepts-generate") as HTMLButtonElement;
    await act(async () => { fireEvent.click(btn()); });
    expect(btn().disabled).toBe(true);
    await act(async () => { resolve(); });
    await waitFor(() => expect(btn().disabled).toBe(false));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
