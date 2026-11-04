/**
 * The identity module's one in-page action operation (identity-flow Phase 3).
 *
 * @purpose Proves `askBefore`: a complete identity runs the action at once; an incomplete one holds it, opens the identity sheet even on a landing page, and runs it exactly once when the identity completes; a newer action replaces a waiting one; leaving the page drops it; signed in, it waits for the account to complete rather than the browser copy; and an account not yet set up, or a page that never asks, runs it at once.
 * @subsystem public-site
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

const auth = {
  user: null as null | { displayName?: string | null; pronouns?: string | null; eligibility?: string },
  isAuthenticated: false,
  isLoading: false,
  status: "resolved" as string,
};
let location = "/search";
const listeners = new Set<() => void>();
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => auth }));
vi.mock("wouter", async () => {
  const React = await import("react");
  return {
    useLocation: () => {
      const [, force] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
      }, []);
      return [location, () => {}];
    },
  };
});

import { PersonNameProvider, usePersonName } from "./use-person-name";
import { PendingActionRunner, resetIdentityGateForTest, useAskBefore, useIdentityGate } from "./use-identity-gate";

function go(path: string) {
  location = path;
  act(() => listeners.forEach((l) => l()));
}

function setup() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PersonNameProvider>
      <PendingActionRunner />
      {children}
    </PersonNameProvider>
  );
  return renderHook(() => ({ askBefore: useAskBefore(), gate: useIdentityGate(), person: usePersonName() }), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetIdentityGateForTest();
  auth.user = null;
  auth.isAuthenticated = false;
  auth.isLoading = false;
  auth.status = "resolved";
  location = "/search";
});

describe("askBefore — signed out", () => {
  it("runs at once when the identity is complete", () => {
    localStorage.setItem("fact_db_name", "Sarah");
    localStorage.setItem("fact_db_pronouns", "she/her");
    localStorage.setItem("fact_db_name_explicit", "1");
    const { result } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("holds the action, asks, and runs it exactly once when the identity is saved", () => {
    const { result, rerender } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.gate.shouldAsk).toBe(true);
    act(() => {
      result.current.person.setName("Sarah");
      result.current.person.setPronouns("she/her");
    });
    rerender();
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.gate.shouldAsk).toBe(false);
    rerender();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("a newer action replaces a waiting one", () => {
    const { result } = setup();
    const first = vi.fn();
    const second = vi.fn();
    act(() => result.current.askBefore(first));
    act(() => result.current.askBefore(second));
    act(() => {
      result.current.person.setName("Sarah");
      result.current.person.setPronouns("she/her");
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("leaving the page drops the waiting action", () => {
    const { result } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    go("/facts/9");
    act(() => {
      result.current.person.setName("Sarah");
      result.current.person.setPronouns("she/her");
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("waits while auth is unknown, then runs once it resolves with a complete identity", () => {
    localStorage.setItem("fact_db_name", "Sarah");
    localStorage.setItem("fact_db_pronouns", "she/her");
    localStorage.setItem("fact_db_name_explicit", "1");
    auth.isLoading = true;
    const { result, rerender } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).not.toHaveBeenCalled();
    auth.isLoading = false;
    rerender();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs at once on a page that never asks", () => {
    location = "/login";
    const { result } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("askBefore — signed in", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
  });

  it("waits for the ACCOUNT to complete, not the browser copy, then runs once", () => {
    auth.user = { displayName: null, pronouns: "she/her", eligibility: "eligible" };
    localStorage.setItem("fact_db_name", "Sarah");
    localStorage.setItem("fact_db_pronouns", "she/her");
    localStorage.setItem("fact_db_name_explicit", "1");
    const { result, rerender } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.gate.shouldAsk).toBe(true);
    // The account save's canonical re-read lands.
    auth.user = { displayName: "Sarah", pronouns: "she/her", eligibility: "eligible" };
    rerender();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("an account whose save failed keeps the action waiting", () => {
    auth.user = { displayName: null, pronouns: null, eligibility: "eligible" };
    const { result, rerender } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    rerender();
    expect(action).not.toHaveBeenCalled();
    expect(result.current.gate.shouldAsk).toBe(true);
  });

  it("an account not yet set up runs at once (onboarding is where it answers)", () => {
    auth.user = { displayName: null, pronouns: null, eligibility: "needs_onboarding" };
    const { result } = setup();
    const action = vi.fn();
    act(() => result.current.askBefore(action));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
