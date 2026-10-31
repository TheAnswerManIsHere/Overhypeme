/**
 * Share-by-email and Turnstile (launch Phase 5, increment 1, #795).
 * POST /share/invite refuses a signed-out sender without a captcha token; the
 * modal used to send none, so a signed-out visitor could never share by email.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let signedIn = false;
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ isAuthenticated: signedIn }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let verify: ((t: string) => void) | null = null;
const reset = vi.fn();
vi.mock("@/components/ui/Turnstile", async () => {
  const React = await import("react");
  return {
    Turnstile: React.forwardRef(function FakeTurnstile(props: { onVerify: (t: string) => void }, ref) {
      verify = props.onVerify;
      React.useImperativeHandle(ref, () => ({ reset }));
      return <div data-testid="turnstile-widget" />;
    }),
  };
});

import { ShareModal } from "../ShareModal";

const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === "/api/share/invite") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  return new Response(JSON.stringify({}), { status: 200 });
});

async function reachEmailStep() {
  render(<ShareModal open onClose={() => {}} path="/" />);
  fireEvent.change(screen.getByPlaceholderText(/e\.g\. Alex/), { target: { value: "Sam" } });
  fireEvent.click(await screen.findByRole("button", { name: /next/i }));
  fireEvent.change(await screen.findByPlaceholderText(/@example\.com/), { target: { value: "sam@example.com" } });
}

describe("ShareModal — share by email", () => {
  beforeEach(() => {
    verify = null;
    reset.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("a signed-out sender must pass the challenge, and the token goes with the invite", async () => {
    signedIn = false;
    await reachEmailStep();
    const send = screen.getByRole("button", { name: /send invite/i });
    expect(screen.getByTestId("turnstile-widget")).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);
    verify!("tok-1");
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/share/invite")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([u]) => u === "/api/share/invite")!;
    expect(JSON.parse(String(init?.body)).captchaToken).toBe("tok-1");
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });

  it("a signed-in sender sees no challenge and sends no token", async () => {
    signedIn = true;
    await reachEmailStep();
    expect(screen.queryByTestId("turnstile-widget")).toBeNull();
    const send = screen.getByRole("button", { name: /send invite/i });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/share/invite")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([u]) => u === "/api/share/invite")!;
    expect(JSON.parse(String(init?.body)).captchaToken).toBeUndefined();
  });
});
