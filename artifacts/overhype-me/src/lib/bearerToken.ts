/**
 * @purpose The Bearer-token slot: localStorage "auth_token", which main.tsx's fetch interceptor sends as `Authorization: Bearer` on every /api/ request. readBearerToken() reads it; storeBearerToken() writes it, and today only the dev admin shortcut does (Navbar.tsx), because the Replit canvas iframe drops the session cookie.
 * @subsystem accounts-auth
 */
const BEARER_TOKEN_KEY = "auth_token";

export function readBearerToken(): string | null {
  try { return localStorage.getItem(BEARER_TOKEN_KEY); } catch { return null; }
}

export function storeBearerToken(token: string): void {
  try { localStorage.setItem(BEARER_TOKEN_KEY, token); } catch { /* storage blocked: the cookie path still applies */ }
}
