/**
 * Read-only mode (#1109): Enter in the invite email box goes round the paused
 * Send Invite button, so the send itself checks the pause (PR #1121 round 3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ShareModal } from "../ShareModal";
import { setReadOnlyNow, __resetReadOnlyNoticeForTests } from "@/lib/readOnlyNotice";

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const invites = () => fetchMock.mock.calls.filter(([u]) => u === "/api/share/invite");

async function typeAddress() {
  render(<ShareModal open onClose={() => {}} path="/" />);
  fireEvent.change(screen.getByPlaceholderText(/e\.g\. David/), { target: { value: "Sam" } });
  fireEvent.click(await screen.findByRole("button", { name: /next/i }));
  const email = await screen.findByPlaceholderText(/@example\.com/);
  fireEvent.change(email, { target: { value: "sam@example.com" } });
  return email as HTMLInputElement;
}

describe("ShareModal — Enter while the site is read-only", () => {
  beforeEach(() => {
    __resetReadOnlyNoticeForTests();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => __resetReadOnlyNoticeForTests());

  it("paused: Enter sends no invitation and keeps the address", async () => {
    const email = await typeAddress();
    setReadOnlyNow(true);
    fireEvent.keyDown(email, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(invites()).toHaveLength(0);
    expect(email.value).toBe("sam@example.com");
  });

  it("open: Enter sends the invitation", async () => {
    const email = await typeAddress();
    fireEvent.keyDown(email, { key: "Enter" });
    await waitFor(() => expect(invites()).toHaveLength(1));
  });
});
