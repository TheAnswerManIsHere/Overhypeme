/**
 * @purpose The admin deletion panel (launch Phase 5, increment 5b): each request in progress shows who asked, its stage, its hold reason and its last error with the attempt count; a purge that failed part-way offers a retry; a kept account with billing clean-up unfinished is shown without actions; Keep account posts the admin cancel and Purge now asks before it calls the hard delete.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountDeletionsPanel, type AdminDeletionRequest } from "./AccountDeletionsPanel";

const base = { requestedAt: "2026-11-01T12:00:00.000Z", purgeAfter: "2026-11-15T12:00:00.000Z", stageUpdatedAt: "2026-11-01T12:00:00.000Z", holdReason: null, lastError: null, attempts: 0, keptWithBillingUnsettled: false };
const ROWS: AdminDeletionRequest[] = [
  { ...base, userId: "stuck", email: "s@x", displayName: "Stuck", requestedBy: "self", stage: "purging", lastError: "storage refused", attempts: 3 },
  { ...base, userId: "held", email: "h@x", displayName: "Held", requestedBy: "unonboarded", stage: "held", holdReason: "An open billing dispute on this account's purchases" },
  { ...base, userId: "kept", email: "k@x", displayName: "Kept", requestedBy: "self", stage: "notified", keptWithBillingUnsettled: true },
];

afterEach(() => vi.unstubAllGlobals());

function stub() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/account-deletions") return { ok: true, status: 200, json: async () => ({ requests: ROWS }) } as Response;
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ cancelled: true }) } as Response;
    if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ success: true, deleted: true, stage: "done" }) } as Response;
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("AccountDeletionsPanel", () => {
  it("shows each request's state, error and hold, and the kept-but-unsettled one without actions", async () => {
    stub();
    render(<AccountDeletionsPanel />);
    expect(await screen.findByText("Stuck")).toBeTruthy();
    expect(screen.getByText(/1 with an error/)).toBeTruthy();
    expect(screen.getByText("storage refused")).toBeTruthy();
    expect(screen.getByText(/after 3 attempts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry purge/ })).toBeTruthy();
    expect(screen.getByText(/Sign-up never finished/)).toBeTruthy();
    expect(screen.getByText(/Held: An open billing dispute/)).toBeTruthy();
    expect(screen.getByText(/Billing clean-up unfinished/)).toBeTruthy();
    // Keep is offered on the held request only: the stuck one is purging, the kept one is already kept.
    expect(screen.getAllByRole("button", { name: "Keep account" })).toHaveLength(1);
  });

  it("Keep account posts the admin cancel; Purge now asks first, then calls the hard delete", async () => {
    const fetchMock = stub();
    render(<AccountDeletionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep account" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/admin/users/held/deletion/cancel" && (i as RequestInit)?.method === "POST")).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: /Purge now/ }));
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/admin/users/held?hard=true" && (i as RequestInit)?.method === "DELETE")).toBe(true));
  });
});
