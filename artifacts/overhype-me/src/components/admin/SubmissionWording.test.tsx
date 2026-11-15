/**
 * The submission's wording on the moderation screen (plan
 * docs/plans/PLAN_THREE_GAGS.md, increment 3): editable and saved at triage,
 * read-only once accepted, and Withdraw behind a confirmation past triage.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SubmissionWording } from "./SubmissionWording";

type Call = { url: string; body: unknown };
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const base = {
  reviewId: 7,
  text: "{NAME} counts to infinity twice.",
  originalText: null,
  label: "Submitted Fact",
  onSaved: () => {},
  onDirtyChange: () => {},
  onWithdrawn: () => {},
};

describe("SubmissionWording", () => {
  it("at triage, an edit is saved to the wording route and reported back; the screen knows while it is unsaved", async () => {
    const saved = { submittedText: "{NAME} counted to infinity. Twice.", submittedTextOriginal: base.text, matchingFactId: null, matchingSimilarity: 3, matchingFact: null };
    const calls = stubFetch(200, saved);
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    render(<SubmissionWording {...base} editable withdrawable={false} onSaved={onSaved} onDirtyChange={onDirtyChange} />);

    fireEvent.change(screen.getByTestId("submission-wording-input"), { target: { value: saved.submittedText } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("submission-wording-unsaved")).toBeTruthy();
    fireEvent.click(screen.getByTestId("submission-wording-save"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(calls[0]).toEqual({ url: "/api/admin/reviews/7/wording", body: { text: saved.submittedText } });
    expect(screen.queryByTestId("submission-withdraw")).toBeNull();
  });

  it("locks the box while a save is in flight, so typing can't be lost to the saved wording", async () => {
    let answer!: (v: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { answer = r; })) as unknown as typeof fetch);
    render(<SubmissionWording {...base} editable withdrawable={false} />);
    const box = screen.getByTestId("submission-wording-input") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "{NAME} counted to infinity. Twice." } });
    fireEvent.click(screen.getByTestId("submission-wording-save"));
    await waitFor(() => expect(box.readOnly).toBe(true));
    answer({ ok: true, status: 200, json: async () => ({ submittedText: "{NAME} counted to infinity. Twice.", submittedTextOriginal: base.text, matchingFactId: null, matchingSimilarity: 0, matchingFact: null }) });
    await waitFor(() => expect(box.readOnly).toBe(false));
  });

  it("shows the server's refusal and keeps the edit", async () => {
    stubFetch(422, { error: "The wording must be between 10 and 2000 characters." });
    render(<SubmissionWording {...base} editable withdrawable={false} />);
    fireEvent.change(screen.getByTestId("submission-wording-input"), { target: { value: "short" } });
    fireEvent.click(screen.getByTestId("submission-wording-save"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The wording must be between 10 and 2000 characters.");
    expect((screen.getByTestId("submission-wording-input") as HTMLTextAreaElement).value).toBe("short");
  });

  it("once accepted, the wording is read-only and the wording as submitted is shown beside an edited one", () => {
    render(<SubmissionWording {...base} originalText="{NAME} counts to infinity, twice." editable={false} withdrawable={false} />);
    expect(screen.queryByTestId("submission-wording-input")).toBeNull();
    expect(screen.getByTestId("submission-wording-locked")).toBeTruthy();
    expect(screen.getByTestId("submission-wording-original").textContent).toContain("{NAME} counts to infinity, twice.");
    expect(screen.queryByTestId("submission-withdraw")).toBeNull();
  });

  it("Withdraw asks first, then posts to the withdraw route and hands back", async () => {
    const calls = stubFetch(200, { success: true, workflowStage: "production_rejected" });
    const onWithdrawn = vi.fn();
    render(<SubmissionWording {...base} editable={false} withdrawable onWithdrawn={onWithdrawn} />);

    fireEvent.click(screen.getByTestId("submission-withdraw"));
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText("What needs replacing (optional, internal)"), { target: { value: "Reads backwards." } });
    fireEvent.click(screen.getByTestId("submission-withdraw-confirm-button"));

    await waitFor(() => expect(onWithdrawn).toHaveBeenCalled());
    expect(calls[0]).toEqual({ url: "/api/admin/reviews/7/withdraw", body: { note: "Reads backwards." } });
  });
});
