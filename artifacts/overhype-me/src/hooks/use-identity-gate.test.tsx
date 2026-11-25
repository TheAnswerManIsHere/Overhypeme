import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ user: { displayName: "Raena", pronouns: "she/her", eligibility: "eligible" }, isAuthenticated: true, isLoading: false, status: "resolved" }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/facts/7/meme", () => {}] }));

import { PersonNameProvider, usePersonName } from "./use-person-name";
import { useIdentityGate } from "./use-identity-gate";

const wrapper = ({ children }: { children: ReactNode }) => <PersonNameProvider>{children}</PersonNameProvider>;

describe("useIdentityGate builderReady (a builder copies the identity once, #723)", () => {
  it("holds a signed-in builder until this page load's share link is settled", () => {
    const { result } = renderHook(() => ({ gate: useIdentityGate(), person: usePersonName() }), { wrapper });
    // Auth has resolved signed in, but the link's pending halves are not yet dropped.
    expect(result.current.gate.builderReady).toBe(false);
    act(() => result.current.person.resolveShareLink(true));
    expect(result.current.gate.builderReady).toBe(true);
  });
});

describe("builderSeedFor (identity-flow Phase 2: the account wins)", () => {
  it("signed in, starts a builder from the account's own fields, not this browser's copy", async () => {
    const { builderSeedFor } = await import("./use-identity-gate");
    expect(builderSeedFor("signedIn", { displayName: "Raena", pronouns: "they/them" }, { name: "David", pronouns: "he/him" }))
      .toEqual({ name: "Raena", pronouns: "they/them" });
  });
  it("signed out, starts from this browser's copy", async () => {
    const { builderSeedFor } = await import("./use-identity-gate");
    expect(builderSeedFor("signedOut", { displayName: "Raena", pronouns: "they/them" }, { name: "David", pronouns: "he/him" }))
      .toEqual({ name: "David", pronouns: "he/him" });
  });
  it("signed in, the browser fills only a half the account lacks", async () => {
    const { builderSeedFor } = await import("./use-identity-gate");
    expect(builderSeedFor("signedIn", { displayName: "Raena", pronouns: null }, { name: "David", pronouns: "he/him" }))
      .toEqual({ name: "Raena", pronouns: "he/him" });
  });
});
