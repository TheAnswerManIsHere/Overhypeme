import { useState, useEffect, useCallback } from "react";
import type { AuthUser } from "@workspace/api-client-react";

export type { AuthUser };

export type UserRole = "anonymous" | "unregistered" | "registered" | "legendary" | "admin";

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  role: UserRole;
  login: () => void;
  logout: () => Promise<void>;
}

function deriveRole(user: AuthUser | null): UserRole {
  if (!user) return "anonymous";
  if (user.userRole === "admin") return "admin";
  if (user.userRole === "legendary" || user.membershipTier === "legendary") return "legendary";
  if (user.userRole === "registered" || user.membershipTier === "registered") return "registered";
  return "unregistered";
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/user", {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ user: AuthUser | null }>;
      })
      .then((data) => {
        if (!cancelled) {
          setUser(data.user ?? null);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(() => {
    window.location.href = `/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }, []);

  const logout = useCallback(async () => {
    try {
      // Fetch BEFORE removing auth_token so the global fetch interceptor can
      // attach the Bearer token — the server needs it to identify and delete
      // the session record from the database (cookies are blocked in iframes).
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Ignore network errors — we'll still clear the token locally.
    }
    localStorage.removeItem("auth_token");
    window.location.href = "/";
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    role: deriveRole(user),
    login,
    logout,
  };
}
