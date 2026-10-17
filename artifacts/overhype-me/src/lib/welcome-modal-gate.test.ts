import { describe, it, expect } from "vitest";
import { shouldOpenWelcomeModal, type WelcomeModalGateInput } from "@/lib/welcome-modal-gate";

// #705: the sheet must open on any page whenever the visitor has no
// personalization yet, and never once a name is set (share link, earlier
// save, or an account display name).
const unset: WelcomeModalGateInput = {
  authLoading: false,
  isAuthenticated: false,
  accountDisplayName: null,
  name: "",
  shareLinkActive: false,
  path: "/",
};

describe("shouldOpenWelcomeModal (#705)", () => {
  it("opens on Home for a visitor with no name", () => {
    expect(shouldOpenWelcomeModal(unset)).toBe(true);
  });

  it("opens on any ordinary page for a visitor with no name", () => {
    for (const path of ["/facts/42", "/search", "/hashtags", "/top", "/meme/abc", "/pricing"]) {
      expect(shouldOpenWelcomeModal({ ...unset, path })).toBe(true);
    }
  });

  it("never opens once a name is set", () => {
    expect(shouldOpenWelcomeModal({ ...unset, name: "Ada" })).toBe(false);
    expect(shouldOpenWelcomeModal({ ...unset, name: "Ada", path: "/facts/42" })).toBe(false);
  });

  it("treats a whitespace-only name as unset", () => {
    expect(shouldOpenWelcomeModal({ ...unset, name: "   " })).toBe(true);
  });

  it("never opens when the visit came from a share link", () => {
    expect(shouldOpenWelcomeModal({ ...unset, shareLinkActive: true })).toBe(false);
  });

  it("waits while sign-in state is loading", () => {
    expect(shouldOpenWelcomeModal({ ...unset, authLoading: true })).toBe(false);
  });

  it("never opens for a signed-in user whose account has a display name", () => {
    expect(
      shouldOpenWelcomeModal({ ...unset, isAuthenticated: true, accountDisplayName: "Hyperion" }),
    ).toBe(false);
  });

  it("opens for a signed-in user with no name anywhere", () => {
    expect(
      shouldOpenWelcomeModal({ ...unset, isAuthenticated: true, accountDisplayName: null }),
    ).toBe(true);
  });

  it("stays off the account pages, where the account itself supplies the name", () => {
    for (const path of ["/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin", "/admin/users"]) {
      expect(shouldOpenWelcomeModal({ ...unset, path })).toBe(false);
    }
  });

  it("does not treat a path that merely starts with an account page's letters as suppressed", () => {
    expect(shouldOpenWelcomeModal({ ...unset, path: "/loginx" })).toBe(true);
    expect(shouldOpenWelcomeModal({ ...unset, path: "/administrators-fan-page" })).toBe(true);
  });
});
