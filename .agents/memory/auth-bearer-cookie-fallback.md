---
name: Auth middleware Bearer-cookie fallback
description: Fix for sign-in regression where stale localStorage auth_token blocked valid cookie sessions
---

## The rule
The auth middleware must try Bearer first but fall back to the cookie when the Bearer session is stale/missing. A stale Bearer must never evict a valid cookie session.

**Why:** The dev-admin triple-tap login (`GET /auth/dev-admin-login`) writes the session SID to `localStorage["auth_token"]`. When that session expires, the stale token persists in localStorage. The global fetch interceptor in `main.tsx` then injects `Authorization: Bearer <stale-sid>` on every `/api/` request, including `fetchAuthUser()`. The old `getSessionId()` always preferred Bearer over cookie, so the valid new cookie session was invisible to the server. Worse, the old middleware called `clearSession(res, sid)` for any failed session — which also cleared the `sid` **cookie**, destroying the valid session.

**How to apply:**
- `authMiddleware.ts`: iterate candidates `[bearer, cookie]`; for stale Bearer → `deleteSession(sid)` only (no cookie clear); for stale cookie → `clearSession(res, sid)` (clears cookie + deletes row).
- The key invariant: `res.clearCookie` must NEVER be called for a Bearer-sourced session ID.
- `getSessionId()` in `lib/auth.ts` is still used by other routes (logout, rate-limiter, etc.) — it still prefers Bearer. Only `authMiddleware.ts` implements the fallback.
