/**
 * @purpose The adults-only screen (launch Phase 14, increment 4): it says the site is for adults and that a mistyped date is corrected through support, marks this browser for an under-age account, offers deletion (confirmed by password or a fresh sign-in that returns here) and sign-out, shows a pending deletion's date instead of the form, and offers no account actions to a visitor who is not signed in.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({
  state: { isAuthenticated: true, isLoading: false, user: { eligibility: "underage" } as { eligibility: string } },
}));
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => auth.state }));
vi.mock("@/hooks/use-sign-out", () => ({ useSignOut: () => vi.fn(), useForgetThisBrowser: () => vi.fn() }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const section = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("@/components/account/DeleteAccountSection", () => ({
  DeleteAccountSection: (props: Record<string, unknown>) => {
    section.props = props;
    return <div data-testid="delete-section" />;
  },
}));

import AccountAdultsOnly from "./AccountAdultsOnly";

function deletionStatus(body: unknown, status = 200) {
  const fn = vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem("overhype.ageRefused");
  auth.state.isAuthenticated = true;
  auth.state.user = { eligibility: "underage" };
  section.props = null;
});

describe("AccountAdultsOnly", () => {
  it("says the site is for adults, points a mistyped date to support, and marks this browser", async () => {
    deletionStatus({ pending: false, confirmWith: { hasPassword: true, linkedProviders: [] } });
    render(<AccountAdultsOnly />);
    expect(screen.getByRole("heading").textContent).toBe("Overhype.me is for adults");
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toBe("/support?category=account");
    expect(window.localStorage.getItem("overhype.ageRefused")).toBe("1");
  });

  it("offers deletion and sign-out", async () => {
    deletionStatus({ pending: false, confirmWith: { hasPassword: false, linkedProviders: ["google"] } });
    render(<AccountAdultsOnly />);
    await screen.findByTestId("delete-section");
    expect(section.props).toMatchObject({ hasPassword: false, linkedProviders: ["google"] });
    expect(screen.getByTestId("adults-only-sign-out")).toBeTruthy();
  });

  it("shows a pending deletion's date instead of the form", async () => {
    deletionStatus({ pending: true, purgeAfter: "2026-12-07T00:00:00.000Z", confirmWith: { hasPassword: true, linkedProviders: [] } });
    render(<AccountAdultsOnly />);
    await screen.findByTestId("adults-only-deletion-pending");
    expect(screen.queryByTestId("delete-section")).toBeNull();
  });

  it("says so when the deletion option cannot load, and still offers sign-out", async () => {
    deletionStatus({}, 500);
    render(<AccountAdultsOnly />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't load the option to delete/);
    expect(screen.getByTestId("adults-only-sign-out")).toBeTruthy();
  });

  it("a visitor who is not signed in gets the explanation and no account actions", () => {
    auth.state.isAuthenticated = false;
    const fetchSpy = deletionStatus({});
    render(<AccountAdultsOnly />);
    expect(screen.getByTestId("adults-only-explanation")).toBeTruthy();
    expect(screen.queryByTestId("adults-only-sign-out")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
