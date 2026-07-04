/**
 * GoldenToggle — mark/unmark a fact for the eval golden set. Covers: posting the
 * toggle, disabled when adding an inactive fact, and allowed removal of an
 * inactive golden fact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GoldenToggle } from "./GoldenToggle";

function mockFetch(ok = true) {
  const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
    ({ ok, json: async () => ({ success: true }) }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { mockFetch(true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("GoldenToggle", () => {
  it("marks an active fact golden (posts golden:true) and flips the label", async () => {
    const fetchFn = mockFetch(true);
    render(<GoldenToggle factId={7} isActive initialGolden={false} />);
    const btn = screen.getByTestId("golden-toggle");
    expect(btn.textContent).toMatch(/Mark golden/);
    await act(async () => { fireEvent.click(btn); });
    expect(fetchFn).toHaveBeenCalledWith("/api/admin/facts/7/eval-golden", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ golden: true });
    expect(btn.textContent).toMatch(/Golden/);
  });

  it("disables adding an inactive, non-golden fact", () => {
    render(<GoldenToggle factId={7} isActive={false} initialGolden={false} />);
    expect((screen.getByTestId("golden-toggle") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows REMOVING an inactive fact that is already golden", async () => {
    const fetchFn = mockFetch(true);
    render(<GoldenToggle factId={7} isActive={false} initialGolden={true} />);
    const btn = screen.getByTestId("golden-toggle") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ golden: false });
    expect(btn.textContent).toMatch(/Mark golden/);
  });

  it("reverts on a failed save", async () => {
    mockFetch(false);
    render(<GoldenToggle factId={7} isActive initialGolden={false} />);
    const btn = screen.getByTestId("golden-toggle");
    await act(async () => { fireEvent.click(btn); });
    expect(btn.textContent).toMatch(/Mark golden/); // reverted
  });
});
