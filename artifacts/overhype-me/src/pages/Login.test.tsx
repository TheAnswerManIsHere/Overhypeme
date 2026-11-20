/**
 * The sign-in page's word to a suspended account (#1099; launch Phase 16 plan, design E).
 *
 * @purpose Proves a suspended member who tries to sign in, by password or by Google or Apple, is told the account is suspended with a link to the contact page, and that no other sign-in error carries that link.
 * @subsystem accounts-auth
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/login", vi.fn()],
  Link: ({ href, children, className, ...rest }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className} {...rest}>{children}</a>,
}));
vi.mock("@/components/layout/Layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/legal/LegalLinks", () => ({ LegalNotice: () => null }));
vi.mock("@/hooks/use-person-name", () => ({ usePersonName: () => ({ name: "", pronouns: "", pronounsSupplied: false }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import Login from "./Login";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function answer(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function supportLink(): HTMLAnchorElement | null {
  return screen.queryByRole("link", { name: /contact support/i }) as HTMLAnchorElement | null;
}

async function signInWithPassword() {
  fireEvent.change(screen.getByPlaceholderText("your@email.com"), { target: { value: "sam@example.com" } });
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(password, { target: { value: "hunter22" } });
  fireEvent.click(screen.getByRole("button", { name: /^SIGN IN$/ }));
}

describe("Login — a suspended account can reach support (#1099)", () => {
  it("links to the contact page when a password sign-in is refused as suspended", async () => {
    fetchMock.mockReturnValue(answer(403, { error: "This account is suspended.", code: "ACCOUNT_SUSPENDED" }));
    render(<Login />);
    await signInWithPassword();
    await waitFor(() => expect(screen.getByText(/This account is suspended\./)).toBeTruthy());
    expect(supportLink()?.getAttribute("href")).toBe("/support?category=account");
  });

  it("links to the contact page when Google or Apple sign-in returns suspended", () => {
    window.history.replaceState(null, "", "/login?error=account_suspended");
    render(<Login />);
    expect(screen.getByText(/This account is suspended\./)).toBeTruthy();
    expect(supportLink()?.getAttribute("href")).toBe("/support?category=account");
  });

  it("offers no support link for an ordinary wrong-password refusal", async () => {
    fetchMock.mockReturnValue(answer(401, { error: "Invalid email or password." }));
    render(<Login />);
    await signInWithPassword();
    await waitFor(() => expect(screen.getByText("Invalid email or password.")).toBeTruthy());
    expect(supportLink()).toBeNull();
  });
});
