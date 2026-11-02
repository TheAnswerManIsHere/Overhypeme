/**
 * @purpose Client AuthProvider and useAuth: loads /api/auth/user at mount, polls the entitlement version and refetches on a change, and exposes the user, role and realRole, the server-sent entitlements with can(), and login and logout; a failed first load leaves no user and no entitlements and reports status failed (not signed out) with a retry; every read is tied to the auth generation it started in, which sign-out and sign-in bump before their network wait, so a late response cannot republish a signed-out account (#725); refreshUser reports whether its read landed.
 * @subsystem accounts-auth
 */
import { useState, useEffect, useCallback, useRef, createContext, useContext, createElement } from "react";
import type { ReactNode } from "react";
import type { AuthUser } from "@workspace/api-client-react";

export type { AuthUser };

export type UserRole = "anonymous" | "unregistered" | "registered" | "legendary" | "admin";

export interface Entitlement {
  allowed: boolean;
  /** Always null today — every feature is boolean. Plan 2 populates it. */
  limit: number | null;
}

export type EntitlementMap = Record<string, Entitlement>;

export interface EntitlementVersion {
  gridRevision: number;
  principalFingerprint: string;
}

/**
 * Whether the auth read has answered. `failed` is not `signed out`: the
 * server never said who this is, so nothing is granted (fail-closed, as
 * before) and nothing that decides on identity may treat it as an anonymous
 * visitor (identity-flow Phase 2: "unknown is not missing").
 */
export type AuthStatus = "loading" | "resolved" | "failed";

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  status: AuthStatus;
  /** Re-run a failed (or any) auth read. True when it answered and was published. */
  retry: () => Promise<boolean>;
  isAuthenticated: boolean;
  role: UserRole;
  realRole: UserRole;
  /**
   * What the server says this account may do. The client is TOLD its
   * entitlements; it never derives them.
   *
   * This replaces a dozen verbatim `role === "legendary" || role === "admin"`
   * derivations and the `roleToTier` mapping implicated in PR #402, where the
   * builder offered a Private pill the save path then silently ignored —
   * because the two surfaces answered the same question in different
   * vocabularies.
   */
  entitlements: EntitlementMap;
  /**
   * Read gate and write gate must be ONE expression evaluated once. Any UI
   * that renders a control from one check and lets the server validate the
   * write from another recreates PR #402's shape.
   *
   * Defaults to DENY for an unknown key and before the payload arrives, which
   * matches the server: a missing row denies there too.
   */
  can: (featureKey: string) => boolean;
  login: () => void;
  logout: () => Promise<void>;
  /**
   * Re-read the account and publish it. True only when the read answered AND
   * was published; false when it failed or was discarded because sign-out or
   * a sign-in started meanwhile — so a caller never treats a value it
   * submitted as confirmed account identity on a read that did not land.
   */
  refreshUser: () => Promise<boolean>;
}

function deriveRole(user: AuthUser | null): UserRole {
  if (!user) return "anonymous";
  if (user.userRole === "admin") return "admin";
  if (user.userRole === "legendary" || user.membershipTier === "legendary") return "legendary";
  if (user.userRole === "registered" || user.membershipTier === "registered") return "registered";
  return "unregistered";
}

function deriveRealRole(user: AuthUser | null): UserRole {
  if (!user) return "anonymous";
  if (user.realUserRole === "admin" || user.isRealAdmin) return "admin";
  if (user.realUserRole === "legendary" || user.membershipTier === "legendary") return "legendary";
  if (user.realUserRole === "registered" || user.membershipTier === "registered") return "registered";
  return "unregistered";
}

const AuthContext = createContext<AuthState | null>(null);

interface AuthPayload {
  user: AuthUser | null;
  entitlements: EntitlementMap;
  entitlementVersion: EntitlementVersion;
}

/** How often to ask whether our snapshot is stale. */
const VERSION_POLL_MS = 60_000;
/** Bounds the payload/version reconciliation loop. */
const MAX_REFETCH_ATTEMPTS = 3;

const EMPTY_VERSION: EntitlementVersion = { gridRevision: -1, principalFingerprint: "" };

async function fetchAuthPayload(): Promise<AuthPayload> {
  const res = await fetch("/api/auth/user", {
    credentials: "include",
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Partial<AuthPayload>;
  return {
    user: data.user ?? null,
    // Absent entitlements mean everything locked, never everything open — the
    // same fail-closed default the server applies to a missing row.
    entitlements: data.entitlements ?? {},
    entitlementVersion: data.entitlementVersion ?? EMPTY_VERSION,
  };
}

async function fetchEntitlementVersion(): Promise<EntitlementVersion | null> {
  try {
    const res = await fetch("/api/entitlements/version", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as EntitlementVersion;
  } catch {
    return null;
  }
}

function sameVersion(a: EntitlementVersion, b: EntitlementVersion): boolean {
  return a.gridRevision === b.gridRevision && a.principalFingerprint === b.principalFingerprint;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementMap>({});
  const [version, setVersion] = useState<EntitlementVersion>(EMPTY_VERSION);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const isLoading = status === "loading";
  /**
   * Which auth state a response belongs to (#725). Every read captures it when
   * it starts and publishes only if it is unchanged when the answer arrives.
   * Sign-out and sign-in bump it when they START, before any network wait, so
   * a read still in flight — the initial load, an explicit refresh, the
   * entitlement poll's refetch, a save's follow-up re-read — can never put the
   * signed-out account back.
   */
  const generationRef = useRef(0);
  /**
   * Set when sign-out starts and never cleared: sign-out ends in a full page
   * load. A read STARTED after it — a save's follow-up re-read whose save
   * answered after sign-out began — would otherwise take the new generation
   * and could still publish the old account while the server's sign-out is
   * in flight.
   */
  const signingOutRef = useRef(false);
  const publish = useCallback((generation: number, payload: AuthPayload): boolean => {
    if (signingOutRef.current || generation !== generationRef.current) return false;
    setUser(payload.user);
    setEntitlements(payload.entitlements);
    setVersion(payload.entitlementVersion);
    setStatus("resolved");
    return true;
  }, []);

  /**
   * Fetches the payload and retries until BOTH halves of the version pair match
   * what the server reports.
   *
   * Reconciling on gridRevision alone is not enough. If the principal changes
   * A → B during the fetch and back to A before the next poll, the pair looks
   * unchanged and the client would keep entitlements computed for the transient
   * principal indefinitely. Comparing the payload's own fingerprint to a freshly
   * observed one is what forces the retry.
   */
  /** Returns true when a payload was published under the generation it started in. */
  const loadPayload = useCallback(async (observed?: EntitlementVersion): Promise<boolean> => {
    const generation = generationRef.current;
    let published = false;
    for (let attempt = 0; attempt < MAX_REFETCH_ATTEMPTS; attempt++) {
      const payload = await fetchAuthPayload();
      if (!publish(generation, payload)) return false;
      published = true;

      if (!observed || sameVersion(payload.entitlementVersion, observed)) return published;

      // The payload was computed from a different instant than the one we
      // observed. Re-observe and go again.
      const fresh = await fetchEntitlementVersion();
      if (!fresh) return published;
      observed = fresh;
    }
    return published;
  }, [publish]);

  const initialLoad = useCallback(async (): Promise<boolean> => {
    const generation = generationRef.current;
    try {
      return publish(generation, await fetchAuthPayload());
    } catch {
      if (signingOutRef.current || generation !== generationRef.current) return false;
      // Fail closed: no user, no entitlements. An empty map locks everything,
      // which is the same answer the server would give. But the read FAILED;
      // it did not say "signed out", so the status says so.
      setUser(null);
      setEntitlements({});
      setStatus("failed");
      return false;
    }
  }, [publish]);

  useEffect(() => {
    void initialLoad();
  }, [initialLoad]);

  /**
   * The server resolver's cache has a TTL and this payload is a snapshot taken
   * at mount, so without a probe an open tab could hold a stale lock
   * indefinitely.
   */
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        const observed = await fetchEntitlementVersion();
        if (cancelled || !observed) return;
        if (sameVersion(observed, version)) return;
        await loadPayload(observed);
      })();
    }, VERSION_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [version, loadPayload]);

  const refreshUser = useCallback(async (): Promise<boolean> => {
    try {
      return await loadPayload();
    } catch {
      // Stale state is better than crashing; the caller learns it failed.
      return false;
    }
  }, [loadPayload]);

  const retry = useCallback(async (): Promise<boolean> => {
    if (status === "failed") setStatus("loading");
    return initialLoad();
  }, [initialLoad, status]);

  const can = useCallback(
    (featureKey: string): boolean => entitlements[featureKey]?.allowed === true,
    [entitlements],
  );

  const login = useCallback(() => {
    generationRef.current++;
    window.location.href = `/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }, []);

  const logout = useCallback(async () => {
    // Invalidate every read still in flight BEFORE the network wait (#725).
    // The published user is left as it is: the redirect below replaces the
    // page, and clearing it here would flash the signed-out welcome sheet.
    generationRef.current++;
    signingOutRef.current = true;
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Ignore network errors — we'll still clear the token locally.
    }
    localStorage.removeItem("auth_token");
    window.location.href = "/";
  }, []);

  const value: AuthState = {
    user,
    isLoading,
    status,
    retry,
    isAuthenticated: !!user,
    role: deriveRole(user),
    realRole: deriveRealRole(user),
    entitlements,
    can,
    login,
    logout,
    refreshUser,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
