/**
 * @purpose The Profile "Delete your account" section (launch Phase 5, increment 5b): nothing is sent until the person ticks that they understand and, with a password, types it; a right password schedules the deletion and leaves for the signed-out confirmation; a wrong one says so; a Google- or Apple-only account without a recent sign-in is offered a fresh sign-in that comes back here, open.
 * @subsystem accounts-auth
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ logout: vi.fn() }) }));

import { DeleteAccountSection } from "./DeleteAccountSection";
import { pageNavigation } from "@/lib/navigation";
import { PersonNameProvider } from "@/hooks/use-person-name";

const WIZARD_KEY = "pending_meme_wizard_v2::42";

/** The member's identity and a meme draft in this browser, as a signed-in member leaves them. */
function seedBrowser() {
  window.localStorage.setItem("fact_db_name", "Leaver");
  window.localStorage.setItem("fact_db_pronouns", "they/them");
  window.sessionStorage.setItem(WIZARD_KEY, JSON.stringify({ factId: 42 }));
}

function renderSection(props: { hasPassword: boolean; linkedProviders: string[] }) {
  return render(<PersonNameProvider><DeleteAccountSection {...props} /></PersonNameProvider>);
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response);
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/profile");
});

function open() {
  fireEvent.click(screen.getByRole("button", { name: /Delete my account…/ }));
}

describe("DeleteAccountSection", () => {
  it("sends nothing until understood and the password is typed; then schedules, forgets the member in this browser, and leaves for the confirmation", async () => {
    const fetchMock = respond(200, { scheduled: true, purgeAfter: "2026-11-15T23:00:00.000Z" });
    vi.stubGlobal("fetch", fetchMock);
    seedBrowser();
    let browserAtLeaving: (string | null)[] = [];
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {
      browserAtLeaving = [window.localStorage.getItem("fact_db_name"), window.localStorage.getItem("fact_db_pronouns"), window.sessionStorage.getItem(WIZARD_KEY)];
    });
    renderSection({ hasPassword: true, linkedProviders: [] });
    open();
    const submit = screen.getByRole("button", { name: /^Delete my account$/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "hunter22" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(go).toHaveBeenCalledWith("/account/deletion?scheduled=2026-11-15T23%3A00%3A00.000Z"));
    expect(browserAtLeaving, "name, pronouns and the meme draft are gone before the page is left").toEqual([null, null, null]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/users/me/deletion");
    expect(JSON.parse(String(init.body))).toEqual({ password: "hunter22" });
  });

  it("a wrong password is said plainly and nothing is left", async () => {
    vi.stubGlobal("fetch", respond(401, { error: "That password is not right.", code: "REAUTH_FAILED" }));
    seedBrowser();
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {});
    renderSection({ hasPassword: true, linkedProviders: [] });
    open();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete my account$/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("That password is not right.");
    expect(go).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(WIZARD_KEY), "a failed attempt forgets nothing").not.toBeNull();
    expect(window.localStorage.getItem("fact_db_name")).toBe("Leaver");
  });

  it("a provider-only account is offered a fresh sign-in that comes back here", async () => {
    vi.stubGlobal("fetch", respond(401, { code: "REAUTH_REQUIRED", providers: ["google"] }));
    const go = vi.spyOn(pageNavigation, "go").mockImplementation(() => {});
    renderSection({ hasPassword: false, linkedProviders: ["google"] });
    open();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete my account$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(go).toHaveBeenCalledWith("/api/login/google?returnTo=%2Fprofile%3Fdelete%3Dconfirm");
  });

  it("back from that sign-in, the section is open and the address is clean", () => {
    window.history.replaceState(null, "", "/profile?delete=confirm");
    renderSection({ hasPassword: false, linkedProviders: ["apple"] });
    expect(screen.getByText("You signed in again. You can delete your account now.")).toBeTruthy();
    expect(window.location.search).toBe("");
  });
});
