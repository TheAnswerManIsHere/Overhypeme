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
 * Differs from the server's in its miss value only: this returns `null` rather
 * than `"/"`, so callers can tell "no destination given" from "a destination
 * was given and it was rejected" and keep their existing null-handling.
 */
export function getSafeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  try {
    const url = new URL(value, "http://localhost");
    if (url.hostname !== "localhost") return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
