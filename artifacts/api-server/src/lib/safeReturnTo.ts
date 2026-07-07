/**
 * Same-origin `returnTo` sanitizer.
 *
 * Extracted from routes/auth.ts so the OAuth login flow and the dev-admin-login
 * flow validate post-auth redirects identically, without a route→route import.
 * Rejects absolute URLs, protocol-relative (`//host`) URLs, and anything that
 * resolves to a different host — collapsing them to "/". Only a same-origin
 * path (+ query + hash) is returned.
 */
export function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const url = new URL(value, "http://localhost");
    if (url.hostname !== "localhost") return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
