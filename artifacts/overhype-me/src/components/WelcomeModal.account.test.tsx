/**
 * Identity-flow Phase 2's backstop: a set-up account missing its name or
 * pronouns is asked once through the welcome sheet, and the answer saves to
 * the account, not only to this browser.
 *
 * @purpose Proves the welcome sheet, for a signed-in account, saves through the validated profile write and then re-reads the account before closing; that a refused write or a re-read that does not land keeps what was typed, says so and offers Save again; and that signed out it saves only to the browser.
 * @subsystem accounts-auth
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutateAsync = vi.fn();
const refreshUser = vi.fn();
const setName = vi.fn();
const setPronouns = vi.fn();
let signedIn = true;

vi.mock("@workspace/api-client-react", () => ({ useUpdateMyProfile: () => ({ mutateAsync }) }));
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ isAuthenticated: signedIn, refreshUser }) }));
vi.mock("@/hooks/use-identity-gate", () => ({ useIdentityGate: () => ({ shouldAsk: true }) }));
vi.mock("@/hooks/use-person-name", () => ({
  usePersonName: () => ({ name: "Ada", pronouns: "she/her", pronounsSupplied: true, setName, setPronouns }),
}));

import { WelcomeModal } from "./WelcomeModal";

async function openAndSave() {
  render(<WelcomeModal />);
  const save = (await screen.findAllByTestId("identity-save", {}, { timeout: 2000 }))[0]!;
  fireEvent.click(save);
}

beforeEach(() => {
  mutateAsync.mockReset();
  refreshUser.mockReset();
  setName.mockReset();
  setPronouns.mockReset();
  signedIn = true;
});

describe("the welcome sheet for a signed-in account", () => {
  it("saves to the account, pre-filled from the browser, and re-reads it", async () => {
    mutateAsync.mockResolvedValue({});
    refreshUser.mockResolvedValue(true);
    await openAndSave();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ data: { displayName: "Ada", pronouns: "she/her" } }));
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
    // The browser copy comes from the account mirror, not from this sheet.
    expect(setName).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryAllByTestId("identity-save")).toHaveLength(0));
  });

  it("keeps what was typed and offers Save again when the write is refused", async () => {
    mutateAsync.mockRejectedValue({ data: { error: "Name contains disallowed text" } });
    await openAndSave();
    expect((await screen.findAllByTestId("identity-save-error"))[0]!.textContent).toContain("disallowed");
    expect(screen.getAllByTestId("identity-save")[0]).not.toHaveProperty("disabled", true);
    expect((screen.getAllByTestId("identity-name-input")[0] as HTMLInputElement).value).toBe("Ada");
  });

  it("does not close when the re-read does not land", async () => {
    mutateAsync.mockResolvedValue({});
    refreshUser.mockResolvedValue(false);
    await openAndSave();
    expect((await screen.findAllByTestId("identity-save-error"))[0]!.textContent).toMatch(/couldn't confirm/);
    expect(screen.getAllByTestId("identity-save").length).toBeGreaterThan(0);
  });
});

describe("the welcome sheet signed out", () => {
  it("saves to the browser only", async () => {
    signedIn = false;
    await openAndSave();
    await waitFor(() => expect(setName).toHaveBeenCalledWith("Ada"));
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
