/**
 * A returning visitor whose browser forgot them (cleared cache, a new device)
 * meets the identity sheet before anything else, and the sheet covers the
 * navbar's Sign in. The sheet offers sign-in itself, back to this page.
 *
 * @purpose Proves the welcome sheet offers a Sign in link to /login with the current page as `from` when signed out, and offers none to a signed-in account completing its name or pronouns.
 * @subsystem public-site
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let signedIn = false;

vi.mock("@workspace/api-client-react", () => ({ useUpdateMyProfile: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ isAuthenticated: signedIn, refreshUser: vi.fn(), user: null }) }));
vi.mock("@/hooks/use-identity-gate", () => ({ useIdentityGate: () => ({ shouldAsk: true }) }));
vi.mock("@/hooks/use-person-name", () => ({
  usePersonName: () => ({ name: "", pronouns: "", pronounsSupplied: false, setName: vi.fn(), setPronouns: vi.fn() }),
}));

import { WelcomeModal } from "./WelcomeModal";

beforeEach(() => {
  signedIn = false;
  window.history.replaceState(null, "", "/facts/42?x=1");
});

describe("the welcome sheet's sign-in link", () => {
  it("is offered to a signed-out visitor and returns them to this page", async () => {
    render(<WelcomeModal />);
    const links = await screen.findAllByTestId("identity-sign-in", {}, { timeout: 2000 });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(`/login?from=${encodeURIComponent("/facts/42?x=1")}`);
    }
  });

  it("is not offered to a signed-in account", async () => {
    signedIn = true;
    render(<WelcomeModal />);
    await screen.findAllByTestId("identity-save", {}, { timeout: 2000 });
    expect(screen.queryAllByTestId("identity-sign-in")).toHaveLength(0);
  });
});
