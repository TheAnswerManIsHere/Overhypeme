/**
 * Client-side twin of the server's `getSafeReturnTo`
 * (`artifacts/api-server/src/lib/safeReturnTo.ts`).
 *
 * Sanitizes a caller-supplied redirect target to a plain same-origin path.
 * Absolute URLs (`https://evil.com`), protocol-relative (`//evil.com`) and
 * non-path schemes (`javascript:…`) are all rejected — the last of those
 * executes if handed to `window.location.href`, and our CSP is still
 * Report-Only, so there is no second line of defence behind this function.
 *
 * The matching rules are deliberately identical to the server's, including
 * resolving against a fixed base and re-checking the hostname afterwards:
 * WHATWG URL parsing rewrites backslashes to slashes and strips tab/newline,
 * so `/\evil.com` and `/<tab>/evil.com` survive a prefix check and still
 * resolve to a foreign host. Keep the two in step — a client validator that
 * drifts from the server's is the duplicate-source-of-truth trap in
 * docs/ai-context/known-failure-patterns.md.
 *
 * A second normalization check runs on the *resolved* value, not just the
 * input: RFC 3986 dot-segment removal means `/a/..//evil.com` fails both
 * prefix checks (starts with `/`, not `//`) and resolves to hostname
 * `localhost`, yet its serialized path is `//evil.com` — a protocol-relative
 * URL once handed to `location.href`. Re-checking the prefix after
 * resolution, not only before it, is what catches this.
 *
 * Differs from the server's in its miss value only: this returns `null` rather
 * than `"/"`, so callers can tell "no destination given" from "a destination
 * was given and it was rejected" and keep their existing null-handling.
 *
 * @purpose Client-side twin of the server's getSafeReturnTo: reduces a redirect target to a same-origin path by the same rules, returning null rather than / on a miss so callers can tell no destination from a rejected one.
 * @subsystem security
 */
export function getSafeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  try {
    const url = new URL(value, "http://localhost");
    if (url.hostname !== "localhost") return null;
    const resolved = url.pathname + url.search + url.hash;
    if (resolved.startsWith("//")) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Pages that are themselves part of signing in: coming back to one after
 * signing in would be a dead end, so a sign-in link from them carries no
 * destination and lands on the home page as before.
 */
const SIGN_IN_FLOW_ROOTS = ["/login", "/forgot-password", "/reset-password", "/check-email", "/verify-email", "/onboard"];

/**
 * The sign-in link that brings you back to `location` afterwards (David, Q6,
 * Issue #1132: every sign-in returns to the page you were on). `location` is
 * a same-site path with its query; anything `getSafeReturnTo` refuses, the
 * home page, and a sign-in-flow page all give plain `/login`. Login reads the
 * destination from `from`.
 */
export function loginHrefFrom(location: string): string {
  const safe = getSafeReturnTo(location);
  if (!safe || safe === "/") return "/login";
  const path = safe.split(/[?#]/)[0] ?? safe;
  if (SIGN_IN_FLOW_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return "/login";
  return `/login?from=${encodeURIComponent(safe)}`;
}

/** The sign-in link that brings you back to the page you are on now. */
export function loginHrefHere(): string {
  if (typeof window === "undefined") return "/login";
  return loginHrefFrom(window.location.pathname + window.location.search);
}

/** The safe `returnTo` from a query string, or `/`. */
export function returnToFromSearch(search: string): string {
  return getSafeReturnTo(new URLSearchParams(search).get("returnTo")) ?? "/";
}
