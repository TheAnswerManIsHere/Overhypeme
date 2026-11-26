/**
 * A gag's description field keeps a moderator's unsaved typing when text for
 * the same version arrives from the server — an AI draft landing on a poll —
 * and still shows that draft in a field nobody has touched (Codex 4713846837,
 * PR #1334; plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *Descriptions*); offers the
 * earlier reviewed text while its version is unreviewed (Codex 4713938194);
 * and says when its typing is unsaved, with an undo (Codex 4713938190).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FactGagsView, GagDescriptionView } from "@workspace/api-zod";
import { DescriptionRow } from "./GagsPanel";

const FP = "a".repeat(64);
const version = (text: string | null, over: Partial<GagDescriptionView> = {}): GagDescriptionView => ({
  contentFingerprint: FP, text, origin: text ? "ai" : "ai", reviewed: false, drafting: text ? "none" : "drafting", lastError: null, earlierText: null, ...over,
});
const row = (v: GagDescriptionView, onView = vi.fn(), onUnsaved?: (fp: string, unsaved: boolean) => void) => (
  <DescriptionRow factId={5} reviewId={null} gagId={9} version={v} label={null} note="" readOnly={false} onView={onView} onUnsaved={onUnsaved} />
);
const field = () => screen.getByTestId("gag-description-input") as HTMLInputElement;

afterEach(() => { vi.restoreAllMocks(); });

describe("the description field and text arriving from the server", () => {
  it("an untouched field shows the AI draft when it lands", () => {
    const { rerender } = render(row(version(null)));
    expect(field().value).toBe("");
    rerender(row(version("{NAME} lobs it over the wall.")));
    expect(field().value).toBe("{NAME} lobs it over the wall.");
  });

  it("typing survives a draft landing for the same version, and Approve saves the typing", async () => {
    const saved: FactGagsView = {
      factId: 5, isActive: true, review: null, maxGags: 3, draftReady: { ok: true, reason: null }, filling: false, fillFailed: false,
      gags: [{ id: 9, descriptions: { published: version("{NAME} throws it by hand.", { origin: "moderator", reviewed: true }), draft: null } } as never],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }));
    const onView = vi.fn();
    const { rerender } = render(row(version(null), onView));
    fireEvent.change(field(), { target: { value: "{NAME} throws it by hand.  " } });
    rerender(row(version("{NAME} lobs it over the wall."), onView));
    expect(field().value).toBe("{NAME} throws it by hand.  ");

    fireEvent.click(screen.getByTestId("gag-description-approve"));
    await waitFor(() => expect(onView).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { text: string; contentFingerprint: string };
    expect(body).toMatchObject({ text: "{NAME} throws it by hand.  ", contentFingerprint: FP });
    expect(field().value).toBe("{NAME} throws it by hand.");
  });

  it("names nothing unsaved when a draft lands in an untouched field", () => {
    const onUnsaved = vi.fn();
    const { rerender } = render(row(version(null), vi.fn(), onUnsaved));
    rerender(row(version("{NAME} lobs it over the wall."), vi.fn(), onUnsaved));
    expect(onUnsaved.mock.calls.some(([, unsaved]) => unsaved)).toBe(false);
  });
});

describe("the earlier description offered as a starting point", () => {
  const EARLIER = "{NAME} hurls the grenade overarm.";

  it("is offered on a version holding an unreviewed AI draft; clicking fills the field and saves nothing", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(row(version("{NAME} lobs it over the wall.", { earlierText: EARLIER })));
    fireEvent.click(screen.getByTestId("gag-description-use-earlier"));
    expect(field().value).toBe(EARLIER);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gag-description-use-earlier")).toBeNull();
  });

  it("is offered on a version with no text yet", () => {
    render(row(version(null, { earlierText: EARLIER })));
    expect(screen.getByTestId("gag-description-use-earlier").textContent).toContain(EARLIER);
  });

  it("is not offered once the version is reviewed", () => {
    render(row(version("{NAME} throws it.", { origin: "moderator", reviewed: true, earlierText: EARLIER })));
    expect(screen.queryByTestId("gag-description-use-earlier")).toBeNull();
  });
});

describe("unsaved description typing", () => {
  it("is reported while typed, and Undo restores the stored text and clears it", async () => {
    const onUnsaved = vi.fn();
    render(row(version("{NAME} lobs it over the wall."), vi.fn(), onUnsaved));
    fireEvent.change(field(), { target: { value: "{NAME} kicks it." } });
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(FP, true));
    fireEvent.click(screen.getByTestId("gag-description-undo"));
    expect(field().value).toBe("{NAME} lobs it over the wall.");
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(FP, false));
    expect(screen.queryByTestId("gag-description-undo")).toBeNull();
  });
});
