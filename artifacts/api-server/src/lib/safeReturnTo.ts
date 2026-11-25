/**
 * Sanitize a caller-supplied `returnTo` to a safe, same-origin relative path.
 *
 * Rejects anything that isn't a plain absolute path on our own origin —
 * absolute URLs (`https://evil.com`), protocol-relative (`//evil.com`), and
 * non-path schemes (`javascript:…`) all collapse to `/`. Shared by the OAuth
 * login and link routes so the open-redirect rule is single-sourced (see the path-classification / duplicate-source-of-truth
 * traps in docs/ai-context/known-failure-patterns.md).
 *
 * A second normalization check runs on the *resolved* value, not just the
 * input: RFC 3986 dot-segment removal means `/a/..//evil.com` fails both
 * prefix checks (starts with `/`, not `//`) and resolves to hostname
 * `localhost`, yet its serialized path is `//evil.com` — a protocol-relative
 * URL once handed to a redirect. Re-checking the prefix after resolution,
 * not only before it, is what catches this.
 *
 * @purpose Reduces a caller-supplied returnTo to a same-origin relative path, collapsing absolute, protocol-relative and scheme URLs to / and re-checking after resolution; the one open-redirect rule for the OAuth login and link routes and the dev-admin login.
 * @subsystem security
 */
export function getSafeReturnTo(value: unknown): string {
  return parseSafeReturnTo(value) ?? "/";
}

/**
 * The same rule as `getSafeReturnTo`, returning null on a miss so a caller can
 * tell "no safe destination" from a valid `/` (Astra, PLAN_SIGNUP_RETURN.md
 * round 1). `getSafeReturnTo`'s callers keep their `/` default.
 */
export function parseSafeReturnTo(value: unknown): string | null {
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
 * Pages that are themselves part of signing in, never a destination to return
 * to. Mirrors the client's list in `artifacts/overhype-me/src/lib/safe-return-to.ts`
 * (PR #1199, Q6); keep the two in step.
 */
export const SIGN_IN_FLOW_ROOTS = ["/login", "/forgot-password", "/reset-password", "/check-email", "/verify-email", "/onboard"] as const;

/**
 * The page an email-and-password sign-up should return to after set-up
 * (Issue #1203, Q6): a safe same-site path that is not the home page or a
 * sign-in-flow page, or null, so nothing is stored and the person lands on
 * their profile as before.
 */
export function getSafeSignupReturnTo(value: unknown): string | null {
  const safe = parseSafeReturnTo(value);
  if (!safe || safe === "/") return null;
  const path = safe.split(/[?#]/)[0] ?? safe;
  if (SIGN_IN_FLOW_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  return safe;
}
