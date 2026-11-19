/**
 * The contact page (launch Phase 16, increment 5; plan design E).
 *
 * @purpose Proves the page prefills a signed-in member's address, sends one request with the form's fields, says the message arrived (and whether the confirmation went out), and when the request cannot reach the inbox says so and shows the address.
 * @subsystem operations
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

let verify: (t: string) => void = () => {};
vi.mock("@/components/ui/Turnstile", async () => {
  const React = await import("react");
  return {
    Turnstile: React.forwardRef(function FakeTurnstile(props: { onVerify: (t: string) => void }, ref) {
      verify = props.onVerify;
      React.useImperativeHandle(ref, () => ({ reset: vi.fn() }));
      return <div data-testid="turnstile-widget" />;
    }),
  };
});
vi.mock("@/components/layout/Layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("wouter", () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { email: "sam@example.com", eligibility: "suspended" } }),
}));

import Support from "./Support";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function fillAndSend() {
  fireEvent.change(screen.getByLabelText(/What's it about/i), { target: { value: "account" } });
  fireEvent.change(screen.getByLabelText(/Message/i), { target: { value: "I can't sign in since yesterday." } });
  act(() => verify("tok"));
  fireEvent.click(screen.getByRole("button", { name: /SEND MESSAGE/ }));
}

describe("Support", () => {
  it("prefills the member's address and sends the form's fields once", async () => {
    fetchMock.mockReturnValue(answer(200, { ok: true, acknowledged: true }));
    render(<Support />);
    expect((screen.getByLabelText(/Your email/i) as HTMLInputElement).value).toBe("sam@example.com");
    await fillAndSend();
    await waitFor(() => expect(screen.getByTestId("support-sent")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/support\/contact$/);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent).toMatchObject({ email: "sam@example.com", category: "account", message: "I can't sign in since yesterday.", captchaToken: "tok", hpField: "" });
    expect(screen.getByText(/sent a confirmation to sam@example.com/)).toBeTruthy();
  });

  it("says the message arrived when only the confirmation failed", async () => {
    fetchMock.mockReturnValue(answer(200, { ok: true, acknowledged: false }));
    render(<Support />);
    await fillAndSend();
    await waitFor(() => expect(screen.getByText(/confirmation email didn't go out, but your message arrived/)).toBeTruthy());
  });

  it("when the request cannot reach the inbox, says so and shows the address", async () => {
    fetchMock.mockReturnValue(answer(503, { code: "SUPPORT_UNAVAILABLE", address: "support@overhype.me" }));
    render(<Support />);
    await fillAndSend();
    await waitFor(() => expect(screen.getByTestId("support-unavailable")).toBeTruthy());
    expect(screen.getByRole("link", { name: "support@overhype.me" }).getAttribute("href")).toBe("mailto:support@overhype.me");
  });

  it("shows the server's reason and keeps the form on a refusal", async () => {
    fetchMock.mockReturnValue(answer(429, { error: "Too many messages from here. Please try again later." }));
    render(<Support />);
    await fillAndSend();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Too many messages/));
    expect((screen.getByLabelText(/Message/i) as HTMLTextAreaElement).value).toBe("I can't sign in since yesterday.");
  });
});
