/**
 * A gag's description field keeps a moderator's unsaved typing when text for
 * the same version arrives from the server — an AI draft landing on a poll —
 * and still shows that draft in a field nobody has touched (Codex 4713846837,
 * PR #1334; plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *Descriptions*).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FactGagsView, GagDescriptionView } from "@workspace/api-zod";
import { DescriptionRow } from "./GagsPanel";

const FP = "a".repeat(64);
const version = (text: string | null, over: Partial<GagDescriptionView> = {}): GagDescriptionView => ({
  contentFingerprint: FP, text, origin: text ? "ai" : "ai", reviewed: false, drafting: text ? "none" : "drafting", lastError: null, ...over,
});
const row = (v: GagDescriptionView, onView = vi.fn()) => (
  <DescriptionRow factId={5} reviewId={null} gagId={9} version={v} earlierText={null} label={null} note="" readOnly={false} onView={onView} />
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
      gags: [{ id: 9, descriptions: { published: version("{NAME} throws it by hand.", { origin: "moderator", reviewed: true }), draft: null, earlierText: null } } as never],
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
});
