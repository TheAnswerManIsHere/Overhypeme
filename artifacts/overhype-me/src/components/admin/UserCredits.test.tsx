/**
 * @purpose The admin Credits panel (launch Phase 7, increment 1): it shows the balance and the ledger, asks for a note before an adjustment, and keeps the same adjustment id across a retry so the server applies it once.
 * @subsystem membership
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserCredits } from "./UserCredits";

afterEach(() => vi.unstubAllGlobals());

const ENTRIES = [
  { id: 2, kind: "admin_grant", credits: 3, note: "Support goodwill", actorLabel: "Admin Tester", createdAt: "2026-11-25T10:00:00.000Z" },
  { id: 1, kind: "free_grant", credits: 1, note: null, actorLabel: null, createdAt: "2026-11-24T10:00:00.000Z" },
];

function stub(postResponses: Array<{ status: number; body: unknown }>) {
  const posts: Array<{ credits: number; note: string; requestId: string }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/admin/users/u1/credits") throw new Error(`unexpected ${url}`);
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      const next = postResponses.shift()!;
      return { ok: next.status < 400, status: next.status, json: async () => next.body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ balance: 4, entries: ENTRIES }) } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return posts;
}

describe("UserCredits", () => {
  it("shows the balance and each ledger entry with who made it and why", async () => {
    stub([]);
    render(<UserCredits userId="u1" />);
    expect((await screen.findByTestId("admin-user-credits-balance")).textContent).toBe("4");
    expect(screen.getByText("Added by an admin")).toBeTruthy();
    expect(screen.getByText("by Admin Tester")).toBeTruthy();
    expect(screen.getByText(/Support goodwill/)).toBeTruthy();
    expect(screen.getByText("Free credit (account verified)")).toBeTruthy();
  });

  it("needs a whole number and a note; a failed save is retried with the same adjustment id", async () => {
    const posts = stub([
      { status: 500, body: { error: "The adjustment could not be saved." } },
      { status: 200, body: { applied: true, balance: 6 } },
    ]);
    render(<UserCredits userId="u1" />);
    await screen.findByTestId("admin-user-credits-balance");
    const button = screen.getByRole("button", { name: /Adjust credits/ });
    fireEvent.change(screen.getByLabelText("Credits to add or remove"), { target: { value: "2" } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why this adjustment is made"), { target: { value: "Goodwill" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    expect(await screen.findByText("The adjustment could not be saved.")).toBeTruthy();
    fireEvent.click(button);
    expect(await screen.findByText("Saved. The balance is now 6.")).toBeTruthy();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]).toEqual({ credits: 2, note: "Goodwill", requestId: posts[1]!.requestId });
  });
});
