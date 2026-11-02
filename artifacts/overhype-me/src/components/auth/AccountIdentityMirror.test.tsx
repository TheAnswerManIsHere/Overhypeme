/**
 * @purpose Proves the one account-to-browser mirror: a named account's identity is mirrored; an account with no display name mirrors nothing, so the browser's name survives for onboarding; an account with no pronouns keeps the browser's supplied choice and never imposes a default; and nothing is mirrored while the auth read is loading or failed.
 * @subsystem accounts-auth
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { AccountIdentityMirror, accountMirrorFor } from "./AccountIdentityMirror";

const syncFromProfile = vi.fn();
let auth: { user: unknown; isAuthenticated: boolean; status: string } = { user: null, isAuthenticated: false, status: "loading" };
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-person-name", () => ({
  usePersonName: () => ({ syncFromProfile, pronouns: "xe|xem|xyr|xyrs|xemself|s", pronounsSupplied: true }),
}));

describe("accountMirrorFor", () => {
  const device = { pronouns: "she/her", pronounsSupplied: true };
  it("mirrors a named account, the account winning", () => {
    expect(accountMirrorFor({ account: { displayName: "Ada", pronouns: "they/them" }, device })).toEqual({ name: "Ada", pronouns: "they/them" });
  });
  it("leaves the browser alone for an account with no display name", () => {
    expect(accountMirrorFor({ account: { displayName: null, pronouns: "he/him" }, device })).toBeNull();
    expect(accountMirrorFor({ account: { displayName: "  ", pronouns: "he/him" }, device })).toBeNull();
  });
  it("keeps the browser's supplied pronouns for an account with none, and imposes no default", () => {
    expect(accountMirrorFor({ account: { displayName: "Ada", pronouns: null }, device })).toEqual({ name: "Ada", pronouns: "she/her" });
    expect(accountMirrorFor({ account: { displayName: "Ada", pronouns: null }, device: { pronouns: "he/him", pronounsSupplied: false } }))
      .toEqual({ name: "Ada", pronouns: "" });
  });
});

describe("AccountIdentityMirror", () => {
  beforeEach(() => syncFromProfile.mockReset());

  it("mirrors the published account", () => {
    auth = { user: { id: "u1", displayName: "Ada", pronouns: "they/them" }, isAuthenticated: true, status: "resolved" };
    render(<AccountIdentityMirror />);
    expect(syncFromProfile).toHaveBeenCalledWith("Ada", "they/them");
  });

  it("mirrors nothing while the auth read is loading or has failed", () => {
    for (const status of ["loading", "failed"]) {
      auth = { user: { id: "u1", displayName: "Ada", pronouns: "they/them" }, isAuthenticated: true, status };
      render(<AccountIdentityMirror />);
    }
    expect(syncFromProfile).not.toHaveBeenCalled();
  });

  it("mirrors nothing when signed out", () => {
    auth = { user: null, isAuthenticated: false, status: "resolved" };
    render(<AccountIdentityMirror />);
    expect(syncFromProfile).not.toHaveBeenCalled();
  });
});
