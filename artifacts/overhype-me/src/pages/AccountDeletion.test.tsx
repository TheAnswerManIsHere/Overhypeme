/**
 * @purpose The "Keep my account" screen (launch Phase 5, increment 5b): signed out straight after a request it confirms the date and offers sign-in; signed in with a deletion pending it shows the date and keeps the account with one button; once the purge has begun it says it can't be stopped; with nothing pending it says so.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({
  state: { isAuthenticated: true, isLoading: false, user: { eligibility: "deletion_pending" } as { eligibility: string }, refreshUser: vi.fn(async () => {}) },
}));
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => auth.state }));
vi.mock("@/hooks/use-sign-out", () => ({ useSignOut: () => vi.fn() }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import AccountDeletion from "./AccountDeletion";

function routes(map: Record<string, { status: number; body: unknown }>) {
  const fn = vi.fn(async (url: string) => {
    const hit = map[url];
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return { ok: hit.status < 300, status: hit.status, json: async () => hit.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/account/deletion");
  auth.state.isAuthenticated = true;
  auth.state.user = { eligibility: "deletion_pending" };
});

describe("AccountDeletion", () => {
  it("signed out straight after a request: the date, and sign in to keep it", () => {
    auth.state.isAuthenticated = false;
    window.history.replaceState(null, "", "/account/deletion?scheduled=2026-11-15T12:00:00.000Z");
    render(<AccountDeletion />);
    expect(screen.getByRole("heading").textContent).toBe("Your account is scheduled for deletion");
    expect(screen.getByText(/signed out everywhere/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login?returnTo=%2Faccount%2Fdeletion");
  });

  it("signed in with a deletion pending: Keep my account brings it back", async () => {
    const fetchMock = routes({
      "/api/users/me/deletion": { status: 200, body: { pending: true, purgeAfter: "2026-11-15T12:00:00.000Z", requestedAt: "2026-11-01T12:00:00.000Z", cancellable: true } },
      "/api/users/me/deletion/cancel": { status: 200, body: { cancelled: true } },
    });
    render(<AccountDeletion />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep my account" }));
    expect((await screen.findByRole("heading")).textContent).toBe("Your account is staying");
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/users/me/deletion/cancel");
    expect(auth.state.refreshUser).toHaveBeenCalled();
  });

  it("a kept sign-up that was never finished is sent to finish setting up", async () => {
    auth.state.user = { eligibility: "unonboarded" };
    routes({
      "/api/users/me/deletion": { status: 200, body: { pending: true, purgeAfter: "2026-11-15T12:00:00.000Z", requestedAt: "2026-11-01T12:00:00.000Z", cancellable: true } },
      "/api/users/me/deletion/cancel": { status: 200, body: { cancelled: true } },
    });
    render(<AccountDeletion />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep my account" }));
    expect((await screen.findByRole("link", { name: "Finish setting up" })).getAttribute("href")).toBe("/onboard");
  });

  it("once the purge has begun it says it can't be stopped, with no button", async () => {
    routes({ "/api/users/me/deletion": { status: 200, body: { pending: true, purgeAfter: "2026-11-01T12:00:00.000Z", requestedAt: "2026-10-18T12:00:00.000Z", cancellable: false } } });
    render(<AccountDeletion />);
    expect((await screen.findByRole("heading")).textContent).toBe("Your account is being deleted");
    expect(screen.queryByRole("button", { name: "Keep my account" })).toBeNull();
  });

  it("with nothing pending it says so", async () => {
    auth.state.user = { eligibility: "eligible" };
    routes({ "/api/users/me/deletion": { status: 200, body: { pending: false } } });
    render(<AccountDeletion />);
    expect((await screen.findByRole("heading")).textContent).toBe("Nothing to keep");
  });
});
