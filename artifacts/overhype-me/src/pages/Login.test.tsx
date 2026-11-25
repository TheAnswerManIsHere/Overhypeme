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
  fireEvent.change(screen.getByPlaceholderText("your@email.com"), { target: { value: "alex@example.com" } });
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

describe("Login — an email sign-up carries the page it started from (Issue #1203)", () => {
  async function registerFrom(search: string) {
    window.history.replaceState(null, "", `/login${search}`);
    fetchMock.mockReturnValue(answer(201, { user: { id: "u1", email: "alex@example.com" } }));
    render(<Login />);
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    fireEvent.change(screen.getByPlaceholderText("your@email.com"), { target: { value: "alex@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("First"), { target: { value: "Alex" } });
    fireEvent.change(screen.getByPlaceholderText("Last"), { target: { value: "Franklin" } });
    fireEvent.change(screen.getByPlaceholderText("Min 8 characters"), { target: { value: "hunter2222" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/register");
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("sends the safe `from` page with the registration", async () => {
    expect((await registerFrom("?from=%2Ffact%2F42%3Fname%3DAlex")).returnTo).toBe("/fact/42?name=Alex");
  });

  it("sends no page when there is none", async () => {
    expect((await registerFrom("")).returnTo).toBeUndefined();
  });

  it("sends no page for an off-site `from`", async () => {
    expect((await registerFrom("?from=https%3A%2F%2Fevil.com")).returnTo).toBeUndefined();
  });
});
