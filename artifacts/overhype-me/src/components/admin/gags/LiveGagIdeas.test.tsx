/**
 * Draft more gags in the Facts editor (plan docs/plans/PLAN_THREE_GAGS.md,
 * increment 2): shown for a live fact with no open review, drafting polls
 * until the ideas land, an idea is used as an additional gag through the gag
 * routes, and using one waits while a gag card holds unsaved edits.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type FactGagsView,
  type GagView,
  type VisualConceptsResponse,
} from "@workspace/api-zod";
import { LiveGagIdeas } from "./LiveGagIdeas";

const NONE = { male: null, female: null, pet: null };
const GAG: GagView = {
  id: 1, slot: 1, state: "approved", availableToUsers: true, isDefault: true,
  approvedContent: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} lifts the moon." },
  approvedExamples: NONE, grandfathered: true, approvedAt: null, pendingContent: null,
  pendingExamples: NONE,
  renders: NONE,
};
const VIEW: FactGagsView = { factId: 5, isActive: true, review: null, gags: [GAG], maxGags: 3 };

const ready: VisualConceptsResponse = {
  status: "ok",
  current: true,
  humorNote: null,
  candidates: [1, 2, 3].map((n) => ({ title: `Idea ${n}`, whyItWorks: "It lands.", sceneDescription: `{NAME} idea ${n}.`, tokenValid: true, bubbles: [] })),
};

type Call = { url: string; method: string; body: unknown };

function stubFetch(sequence: VisualConceptsResponse[]) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (String(url).endsWith("/gags/ideas")) {
      const r = sequence[Math.min(i, sequence.length - 1)]!;
      i++;
      return json(r, method === "POST" ? 202 : 200);
    }
    if (String(url).endsWith("/gags/cast")) {
      const b = JSON.parse(String(init!.body)) as { scene: string };
      return json({ cast: [], castExtraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: `key:${b.scene}` }, unboundSpeakers: [] });
    }
    return json(VIEW);
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("LiveGagIdeas", () => {
  it("is not shown while a review is open, or for a fact that is not live", () => {
    stubFetch([{ status: null, current: false, candidates: [], humorNote: null }]);
    const { container, rerender } = render(<LiveGagIdeas factId={5} gagsView={{ ...VIEW, review: { id: 9, stage: "concept_review" } }} onApplied={() => {}} unsavedGagEdits={false} />);
    expect(container.innerHTML).toBe("");
    rerender(<LiveGagIdeas factId={5} gagsView={{ ...VIEW, isActive: false }} onApplied={() => {}} unsavedGagEdits={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("drafts on request, polls while working, and uses an idea as an additional gag", async () => {
    const calls = stubFetch([
      { status: null, current: false, candidates: [], humorNote: null },
      { status: "pending", current: false, candidates: [], humorNote: null },
      ready,
    ]);
    const applied = vi.fn();
    render(<LiveGagIdeas factId={5} gagsView={VIEW} onApplied={applied} unsavedGagEdits={false} />);
    // The first read lands before the press, so the button pressed is the one on screen.
    await screen.findByTestId("visual-concepts-idle");
    await act(async () => {});
    fireEvent.click(screen.getByTestId("visual-concepts-generate"));
    await screen.findByTestId("visual-concepts-pending");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/facts/5/gags/ideas")).toBe(true);
    await screen.findByTestId("visual-concepts-cards", undefined, { timeout: 4000 });

    const additional = screen.getAllByRole("button").find((b) => b.getAttribute("data-action") === "additional")!;
    fireEvent.click(additional);
    await waitFor(() => expect(applied).toHaveBeenCalled());
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/admin/facts/5/gags");
    expect((create?.body as { content: { coreSceneOverride: string }; reviewId?: number }).content.coreSceneOverride).toBe("{NAME} idea 1.");
    expect((create?.body as { reviewId?: number }).reviewId).toBeUndefined();
    // The idea goes through the same preparation: its cast is read before the save and sent with it.
    const castRead = calls.findIndex((c) => c.url === "/api/admin/facts/5/gags/cast");
    expect(castRead).toBeGreaterThan(-1);
    expect(castRead).toBeLessThan(calls.indexOf(create!));
    expect((create?.body as { content: { cast?: unknown; castExtraction?: { sourceKey: string } } }).content.castExtraction?.sourceKey).toBe("key:{NAME} idea 1.");
  });

  it("waits while a gag card holds unsaved edits", async () => {
    stubFetch([ready]);
    render(<LiveGagIdeas factId={5} gagsView={VIEW} onApplied={() => {}} unsavedGagEdits />);
    await screen.findByTestId("visual-concepts-cards");
    expect(screen.getByTestId("pick-blocked-note").textContent).toMatch(/Save or undo your gag edits first/);
    const buttons = screen.getAllByRole("button").filter((b) => b.getAttribute("data-action"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("a slow connection still gets the ideas through: polls never cancel each other (Codex, PR #958 round 2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (String(url).endsWith("/gags/ideas") && (init?.method ?? "GET") === "GET") {
        gets++;
        // Every read takes longer than the two-second poll interval.
        await new Promise((r) => setTimeout(r, 3000));
        return json(gets === 1 ? { status: "pending", current: false, candidates: [], humorNote: null } : ready);
      }
      return json(VIEW);
    }));
    render(<LiveGagIdeas factId={5} gagsView={VIEW} onApplied={() => {}} unsavedGagEdits={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await screen.findByTestId("visual-concepts-pending");
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByTestId("visual-concepts-cards")).toBeTruthy();
  });
});
