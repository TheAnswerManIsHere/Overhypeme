/**
 * #725 and identity-flow Phase 2's "unknown is not missing": a sign-out
 * issued while an auth read is in flight must not let that read put the
 * account back, a read started after sign-out began publishes nothing, and a
 * failed read is reported as failed (with a retry), not as signed out.
 *
 * @purpose Proves the auth provider discards a late initial load, a late explicit refresh and a late entitlement-poll refetch once sign-out starts, discards a save's follow-up re-read started after sign-out began, reports refreshUser's outcome, and reports a failed first read as status failed with a working retry.
 * @subsystem accounts-auth
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@workspace/replit-auth-web";

type Deferred = { resolve: (v: Response) => void; reject: (e: unknown) => void };

const USER = { id: "u1", email: "a@example.com", displayName: "Ada", pronouns: "she/her" };
const VERSION = { gridRevision: 1, principalFingerprint: "fp-u1" };

function payload(user: unknown, version = VERSION): Response {
  return new Response(JSON.stringify({ user, entitlements: {}, entitlementVersion: version }), { status: 200 });
}

let authUserCalls: Deferred[] = [];
let versionResponse: () => Response = () => new Response(JSON.stringify(VERSION), { status: 200 });

beforeEach(() => {
  authUserCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/auth/user") {
        return new Promise<Response>((resolve, reject) => authUserCalls.push({ resolve, reject }));
      }
      if (url === "/api/entitlements/version") return Promise.resolve(versionResponse());
      if (url === "/api/auth/logout") return new Promise<Response>(() => {}); // still in flight
      return Promise.reject(new Error(`unexpected ${url}`));
    }),
  );
  // logout() navigates; jsdom cannot, so make href assignable.
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, href: "/", pathname: "/" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("auth reads in flight at sign-out (#725)", () => {
  it("a late initial load publishes nothing", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(authUserCalls).toHaveLength(1);
    act(() => void result.current.logout());
    await act(async () => authUserCalls[0]!.resolve(payload(USER)));
    await flush();
    expect(result.current.user).toBeNull();
  });

  it("a late explicit refresh publishes nothing, and says so", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.resolve(payload(USER)));
    await flush();
    expect(result.current.user?.id).toBe("u1");

    let refreshed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      refreshed = result.current.refreshUser();
    });
    act(() => void result.current.logout());
    await act(async () => authUserCalls[1]!.resolve(payload({ ...USER, displayName: "Changed" })));
    expect(await refreshed).toBe(false);
    expect(result.current.user?.displayName).toBe("Ada");
  });

  it("a late entitlement-poll refetch publishes nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.resolve(payload(USER)));
    await flush();
    versionResponse = () => new Response(JSON.stringify({ ...VERSION, gridRevision: 2 }), { status: 200 });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(authUserCalls).toHaveLength(2);
    act(() => void result.current.logout());
    await act(async () => authUserCalls[1]!.resolve(payload({ ...USER, displayName: "Changed" }, { ...VERSION, gridRevision: 2 })));
    await flush();
    expect(result.current.user?.displayName).toBe("Ada");
    versionResponse = () => new Response(JSON.stringify(VERSION), { status: 200 });
  });

  it("a save's follow-up re-read that starts after sign-out began publishes nothing", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.resolve(payload(USER)));
    await flush();
    act(() => void result.current.logout());
    // The save answered after sign-out started; its continuation re-reads.
    let refreshed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      refreshed = result.current.refreshUser();
    });
    await act(async () => authUserCalls[1]!.resolve(payload({ ...USER, displayName: "Changed" })));
    expect(await refreshed).toBe(false);
    expect(result.current.user?.displayName).toBe("Ada");
  });

  it("refreshUser reports a read that landed", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.resolve(payload(USER)));
    let refreshed: Promise<boolean> = Promise.resolve(false);
    act(() => {
      refreshed = result.current.refreshUser();
    });
    await act(async () => authUserCalls[1]!.resolve(payload({ ...USER, displayName: "Grace" })));
    expect(await refreshed).toBe(true);
    expect(result.current.user?.displayName).toBe("Grace");
  });
});

describe("a failed auth read", () => {
  it("is status failed, not signed out, and grants nothing", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.reject(new Error("offline")));
    await flush();
    expect(result.current.status).toBe("failed");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.can("anything")).toBe(false);
  });

  it("retries, and resolves on success", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => authUserCalls[0]!.reject(new Error("offline")));
    await flush();
    let retried: Promise<boolean> = Promise.resolve(false);
    act(() => {
      retried = result.current.retry();
    });
    expect(result.current.status).toBe("loading");
    await act(async () => authUserCalls[1]!.resolve(payload(USER)));
    expect(await retried).toBe(true);
    expect(result.current.status).toBe("resolved");
    expect(result.current.user?.id).toBe("u1");
  });
});
