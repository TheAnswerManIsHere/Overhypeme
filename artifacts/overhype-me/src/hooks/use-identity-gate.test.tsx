import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ user: { displayName: null }, isAuthenticated: true, isLoading: false }),
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
