/**
 * @purpose The Profile "Delete your account" section (launch Phase 5, increment 5b): nothing is sent until the person ticks that they understand and, with a password, types it; a right password schedules the deletion and leaves for the signed-out confirmation; a wrong one says so; a Google- or Apple-only account without a recent sign-in is offered a fresh sign-in that comes back here, open.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeleteAccountSection } from "./DeleteAccountSection";
import { pageNavigation } from "@/lib/navigation";

function respond(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/profile");
});

function open() {
  fireEvent.click(screen.getByRole("button", { name: /Delete my account…/ }));
}

describe("DeleteAccountSection", () => {
  it("sends nothing until understood and the password is typed; then schedules and leaves for the confirmation", async () => {
    const fetchMock = respond(200, { scheduled: true, purgeAfter: "2026-11-15T23:00:00.000Z" });
    vi.stubGlobal("fetch", fetchMock);
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {});
    render(<DeleteAccountSection hasPassword linkedProviders={[]} />);
    open();
    const submit = screen.getByRole("button", { name: /^Delete my account$/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "hunter22" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(go).toHaveBeenCalledWith("/account/deletion?scheduled=2026-11-15T23%3A00%3A00.000Z"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/users/me/deletion");
    expect(JSON.parse(String(init.body))).toEqual({ password: "hunter22" });
  });

  it("a wrong password is said plainly and nothing is left", async () => {
    vi.stubGlobal("fetch", respond(401, { error: "That password is not right.", code: "REAUTH_FAILED" }));
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {});
    render(<DeleteAccountSection hasPassword linkedProviders={[]} />);
    open();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete my account$/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("That password is not right.");
    expect(go).not.toHaveBeenCalled();
  });

  it("a provider-only account is offered a fresh sign-in that comes back here", async () => {
    vi.stubGlobal("fetch", respond(401, { code: "REAUTH_REQUIRED", providers: ["google"] }));
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {});
    render(<DeleteAccountSection hasPassword={false} linkedProviders={["google"]} />);
    open();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete my account$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(go).toHaveBeenCalledWith("/api/login/google?returnTo=%2Fprofile%3Fdelete%3Dconfirm");
  });

  it("back from that sign-in, the section is open and the address is clean", () => {
    window.history.replaceState(null, "", "/profile?delete=confirm");
    render(<DeleteAccountSection hasPassword={false} linkedProviders={["apple"]} />);
    expect(screen.getByText("You signed in again. You can delete your account now.")).toBeTruthy();
    expect(window.location.search).toBe("");
  });
});
