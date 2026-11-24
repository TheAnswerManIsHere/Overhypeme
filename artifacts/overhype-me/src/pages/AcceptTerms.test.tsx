/**
 * @purpose The accept-the-Terms screen for an account that finished set-up before the current Terms (launch Phase 14, increment 4): it says why it asks, needs one explicit tick, records the versions it shows and returns where the account was going, asks for a reload when the server says a version moved on, and "Not now" defers the question for this visit only.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LEGAL_VERSIONS } from "@/generated/legal";

const setLocation = vi.fn();
const refreshUser = vi.fn(async () => {});
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ refreshUser }) }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/account/terms", setLocation],
}));
vi.mock("@/hooks/use-read-only", () => ({ useReadOnly: () => false }));

import AcceptTerms from "./AcceptTerms";

function answer(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: status < 300, status, json: async () => body }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocation.mockReset();
  refreshUser.mockClear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AcceptTerms", () => {
  it("says why it asks, and needs the tick", () => {
    render(<AcceptTerms />);
    expect(screen.getByTestId("accept-terms-why").textContent).toMatch(/agree to our current Terms of Service/);
    expect((screen.getByTestId("accept-terms-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("accept-terms-checkbox"));
    expect((screen.getByTestId("accept-terms-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("records the versions it shows and returns where the account was going", async () => {
    window.history.replaceState(null, "", "/account/terms?returnTo=%2Fsubmit");
    const fetchSpy = answer(200, { accepted: true });
    render(<AcceptTerms />);
    fireEvent.click(screen.getByTestId("accept-terms-checkbox"));
    fireEvent.click(screen.getByTestId("accept-terms-submit"));
    await waitFor(() => expect(setLocation).toHaveBeenCalledWith("/submit"));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toMatch(/api\/users\/me\/legal-acceptance$/);
    expect(JSON.parse(String(init!.body))).toEqual({ terms: LEGAL_VERSIONS.terms, privacy: LEGAL_VERSIONS.privacy });
    expect(refreshUser).toHaveBeenCalled();
  });

  it("a version that moved on asks for a reload and goes nowhere", async () => {
    answer(400, { error: "The Terms or the Privacy Policy changed since this page loaded. Reload to read the current version.", code: "LEGAL_VERSION_OUTDATED" });
    render(<AcceptTerms />);
    fireEvent.click(screen.getByTestId("accept-terms-checkbox"));
    fireEvent.click(screen.getByTestId("accept-terms-submit"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since this page loaded/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(setLocation).not.toHaveBeenCalled();
  });

  it("Not now defers the question for this visit and goes back", () => {
    window.history.replaceState(null, "", "/account/terms?returnTo=%2Ffacts%2F3");
    render(<AcceptTerms />);
    fireEvent.click(screen.getByTestId("accept-terms-not-now"));
    expect(window.sessionStorage.getItem("overhype.termsDeferred")).toBe("1");
    expect(setLocation).toHaveBeenCalledWith("/facts/3");
  });

  it("points a member who is leaving to cancelling from Profile, without agreeing (Q27: 1)", () => {
    window.history.replaceState(null, "", "/account/terms?returnTo=%2Ffacts%2F3");
    render(<AcceptTerms />);
    expect(screen.getByTestId("accept-terms-leaving").textContent).toBe(
      "Leaving instead? You can cancel your membership from your profile.",
    );
    fireEvent.click(screen.getByTestId("accept-terms-cancel"));
    expect(window.sessionStorage.getItem("overhype.termsDeferred")).toBe("1");
    expect(setLocation).toHaveBeenCalledWith("/profile");
  });
});
