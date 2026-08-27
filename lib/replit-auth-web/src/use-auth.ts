import { useState, useEffect, useCallback, createContext, useContext, createElement } from "react";
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

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
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
  refreshUser: () => Promise<void>;
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
  const [isLoading, setIsLoading] = useState(true);

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
  const loadPayload = useCallback(async (observed?: EntitlementVersion): Promise<void> => {
    for (let attempt = 0; attempt < MAX_REFETCH_ATTEMPTS; attempt++) {
      const payload = await fetchAuthPayload();
      setUser(payload.user);
      setEntitlements(payload.entitlements);
      setVersion(payload.entitlementVersion);

      if (!observed || sameVersion(payload.entitlementVersion, observed)) return;

      // The payload was computed from a different instant than the one we
      // observed. Re-observe and go again.
      const fresh = await fetchEntitlementVersion();
      if (!fresh) return;
      observed = fresh;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAuthPayload()
      .then((p) => {
        if (cancelled) return;
        setUser(p.user);
        setEntitlements(p.entitlements);
        setVersion(p.entitlementVersion);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Fail closed: no user, no entitlements. An empty map locks everything,
        // which is the same answer the server would give.
        setUser(null);
        setEntitlements({});
        setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

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

  const refreshUser = useCallback(async () => {
    try {
      await loadPayload();
    } catch {
      // Silently ignore — stale state is better than crashing.
    }
  }, [loadPayload]);

  const can = useCallback(
    (featureKey: string): boolean => entitlements[featureKey]?.allowed === true,
    [entitlements],
  );

  const login = useCallback(() => {
    window.location.href = `/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }, []);

  const logout = useCallback(async () => {
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
