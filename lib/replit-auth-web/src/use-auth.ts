import { useState, useEffect, useCallback, createContext, useContext, createElement } from "react";
import type { ReactNode } from "react";
import type { AuthUser } from "@workspace/api-client-react";

export type { AuthUser };

export type UserRole = "anonymous" | "unregistered" | "registered" | "legendary" | "admin";

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  role: UserRole;
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

const AuthContext = createContext<AuthState | null>(null);

async function fetchAuthUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/user", {
    credentials: "include",
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { user: AuthUser | null };
  return data.user ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAuthUser()
      .then((u) => { if (!cancelled) { setUser(u); setIsLoading(false); } })
      .catch(() => { if (!cancelled) { setUser(null); setIsLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const u = await fetchAuthUser();
      setUser(u);
    } catch {
      // Silently ignore — stale state is better than crashing.
    }
  }, []);

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
