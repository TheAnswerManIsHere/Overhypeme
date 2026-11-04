/**
 * The "Check your email" screen (launch Phase 5, plan S8; #868).
 *
 * @purpose Proves the screen asks the server to make sure a link is out on arrival, once, and says "We sent a link" only once the server answers that one is, saying instead that it could not send one when the server refuses.
 * @subsystem accounts-auth
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CheckEmail from "./CheckEmail";

vi.mock("wouter", () => ({ useLocation: () => ["/check-email", vi.fn()] }));
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { email: "sam@example.com", eligibility: "unverified" },
    refreshUser: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-sign-out", () => ({ useSignOut: () => vi.fn() }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("CheckEmail — the claim follows a send (#868)", () => {
  it("asks for a link on arrival and claims one only once the server says it is out", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((r) => { release = () => r(answer(200, { status: "sent" })); }));
    render(<CheckEmail />);
    expect(screen.queryByText(/We sent a link/)).toBeNull();
    expect(screen.getByText(/Sending a link to/)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/api\/auth\/resend-verification$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ ifNoneOut: true });
    release();
    await screen.findByText(/We sent a link/);
  });

  it("claims a link for an account that already has a live one, without asking twice", async () => {
    fetchMock.mockImplementation(() => answer(200, { status: "already-sent" }));
    render(<CheckEmail />);
    await screen.findByText(/We sent a link/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says no link went out when the server refuses", async () => {
    fetchMock.mockImplementation(() => answer(429, { error: "Too many links sent. Try again later." }));
    render(<CheckEmail />);
    await screen.findByText(/couldn't send a link/);
    expect(screen.queryByText(/We sent a link/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Too many links sent/);
  });
});
