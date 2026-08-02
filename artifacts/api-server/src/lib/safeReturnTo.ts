/**
 * Sanitize a caller-supplied `returnTo` to a safe, same-origin relative path.
 *
 * Rejects anything that isn't a plain absolute path on our own origin —
 * absolute URLs (`https://evil.com`), protocol-relative (`//evil.com`), and
 * non-path schemes (`javascript:…`) all collapse to `/`. Shared by the OAuth
 * callbacks and the dev-admin-login route so the open-redirect rule is
 * single-sourced (see the path-classification / duplicate-source-of-truth
 * traps in docs/ai-context/known-failure-patterns.md).
 *
 * A second normalization check runs on the *resolved* value, not just the
 * input: RFC 3986 dot-segment removal means `/a/..//evil.com` fails both
 * prefix checks (starts with `/`, not `//`) and resolves to hostname
 * `localhost`, yet its serialized path is `//evil.com` — a protocol-relative
 * URL once handed to a redirect. Re-checking the prefix after resolution,
 * not only before it, is what catches this.
 */
export function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const url = new URL(value, "http://localhost");
    if (url.hostname !== "localhost") return "/";
    const resolved = url.pathname + url.search + url.hash;
    if (resolved.startsWith("//")) return "/";
    return resolved;
  } catch {
    return "/";
  }
}
