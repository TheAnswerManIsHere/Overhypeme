/**
 * @purpose The verified-actor gate: refuses every state-changing request (an unsafe method, or a GET on the inventoried list of GETs that write) from a signed-in account that is not yet eligible, with one code naming the first reason, except the routes the exception table opens to that state; an under-age account's other reads run as signed out; anonymous requests pass untouched.
 * @subsystem accounts-auth
 */
import type { Request, Response, NextFunction } from "express";
import { SUSPENDED_MESSAGE, type Eligibility } from "../lib/eligibility";

/**
 * The code a refusal carries for each state that cannot act. Order of
 * precedence is the eligibility derivation's (`lib/eligibility.ts`), so one
 * state maps to one code.
 */
export const REFUSAL_CODE: Readonly<Record<Exclude<Eligibility, "eligible">, string>> = {
  suspended: "ACCOUNT_SUSPENDED",
  underage: "UNDER_AGE",
  deletion_pending: "DELETION_PENDING",
  unverified: "EMAIL_VERIFICATION_REQUIRED",
  unonboarded: "ONBOARDING_REQUIRED",
  terms_unaccepted: "TERMS_ACCEPTANCE_REQUIRED",
};

/** What an under-age account is told at every door (launch Phase 14, increment 4). */
export const UNDER_AGE_MESSAGE = "Overhype.me is for adults. You can sign out or delete this account.";

const REFUSAL_MESSAGE: Readonly<Record<Exclude<Eligibility, "eligible">, string>> = {
  suspended: SUSPENDED_MESSAGE,
  underage: UNDER_AGE_MESSAGE,
  deletion_pending: "This account is scheduled for deletion. Keep it to continue.",
  unverified: "Verify your email address to continue.",
  unonboarded: "Finish setting up your account to continue.",
  terms_unaccepted: "Agree to the Terms and acknowledge the Privacy Policy to continue.",
};

/** A route as `METHOD /path`, the path as mounted under `/api`, `:param` for a segment. */
export type RouteKey = `${"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} /${string}`;

/**
 * The recovery routes every non-eligible state may use (plan, transition
 * table): signing in or out, verifying, resending the link, resetting a
 * password, and the provider sign-in callbacks, each of which applies its own
 * check to the account being signed into. The dev-admin login is left as it
 * is until Phase 15 (decisions.md, 2026-10-21).
 */
const RECOVERY: readonly RouteKey[] = [
  "POST /auth/register",
  "POST /auth/local-login",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  "POST /auth/resend-verification",
  "POST /auth/logout",
  "POST /callback/apple",
  "POST /auth/dev-admin-login",
];

/**
 * Asking for help works from every account state (launch Phase 16, increment
 * 5, plan design E): a suspended or stuck member is the one most likely to need it.
 */
const SUPPORT: readonly RouteKey[] = ["POST /support/contact"];

/**
 * State → the routes that state may still write through. One exported table,
 * so a change to it is a visible decision; the gate test holds its own copy
 * written from the plan and diffs the two (plan T1).
 */
export const GATE_EXCEPTIONS: Readonly<Record<Exclude<Eligibility, "eligible">, readonly RouteKey[]>> = {
  // Increment 6 decides suspension; only logout works there (transition table).
  suspended: ["POST /auth/logout", ...SUPPORT],
  // Keeping the account is the one write a pending deletion allows (Increment 5).
  deletion_pending: [...RECOVERY, ...SUPPORT, "POST /users/me/deletion/cancel"],
  unverified: [...RECOVERY, ...SUPPORT],
  unonboarded: [
    ...RECOVERY,
    ...SUPPORT,
    "PUT /users/me/onboarding/draft",
    "POST /users/me/onboarding",
    // A verified account that never finished set-up may still leave (plan: open
    // to an eligible account and to a verified, un-onboarded one).
    "POST /users/me/deletion",
  ],
  // Launch Phase 14, increment 4: sign out or ask for deletion, and nothing
  // else — not cancelling a deletion, not resubmitting set-up. Its reads are
  // narrowed too (UNDER_AGE_READS).
  underage: ["POST /auth/logout", ...SUPPORT, "POST /users/me/deletion"],
  // Reads everything; writes only to accept, to leave, or to ask for help.
  terms_unaccepted: [...RECOVERY, ...SUPPORT, "POST /users/me/legal-acceptance", "POST /users/me/deletion"],
};

/**
 * The reads an under-age account makes as itself: who it is (so the app can
 * show the adults-only screen), signing out, and where its deletion stands.
 * Every other read runs as if signed out, which is how a suspended account,
 * holding no session, already reads (plan increment 4: "no authenticated
 * capability, reads included, beyond signing out and requesting deletion").
 */
export const UNDER_AGE_READS: readonly RouteKey[] = [
  "GET /auth/user",
  "GET /logout",
  "GET /users/me/deletion",
];

/**
 * GET routes whose handlers write, found by reading each GET handler's body
 * (plan S1(b)); a signed-in account that cannot act is refused these like an
 * unsafe method. A GET that writes only incidentally to serve a public read
 * is not here: it skips its write for such an account instead (plan S21,
 * `GET /facts/hero`). Sign-in, callback and logout GETs are transitions with
 * their own checks, not writes by the session's account.
 */
export const MUTATING_GETS: readonly RouteKey[] = [
  "GET /link/:provider",
];

/** Photo-upload routes, which also require an adult date of birth (plan S12). */
export const ADULT_ONLY: readonly RouteKey[] = [
  "POST /storage/upload-avatar",
  "POST /storage/upload-meme",
];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function compile(keys: readonly RouteKey[]): Array<{ method: string; re: RegExp }> {
  return keys.map((key) => {
    const [method, path] = key.split(" ") as [string, string];
    const pattern = path
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    // Case-insensitive, as Express routing is: `/API/Users/...` reaches the
    // same handler, so it must meet the same gate.
    return { method, re: new RegExp(`^${pattern}/?$`, "i") };
  });
}

export function matcher(keys: readonly RouteKey[]): (method: string, path: string) => boolean {
  const compiled = compile(keys);
  return (method, path) => compiled.some((c) => c.method === method && c.re.test(path));
}

const isMutatingGet = matcher(MUTATING_GETS);
const isUnderAgeRead = matcher(UNDER_AGE_READS);
const isAdultOnly = matcher(ADULT_ONLY);
const exceptionFor = Object.fromEntries(
  Object.entries(GATE_EXCEPTIONS).map(([state, keys]) => [state, matcher(keys)]),
) as Record<Exclude<Eligibility, "eligible">, (method: string, path: string) => boolean>;

/**
 * The request's path relative to the `/api` mount, without a query string.
 * The mount is matched case-insensitively, as Express matches it.
 */
export function apiPath(req: Request): string | null {
  const url = req.originalUrl ?? req.url;
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const prefix = path.slice(0, 5).toLowerCase();
  if (prefix === "/api" || prefix === "/api/") return path.slice(4) || "/";
  return null;
}

/** True when the request writes: an unsafe method, or an inventoried mutating GET. */
export function isStateChanging(method: string, path: string): boolean {
  return UNSAFE.has(method) || (method === "GET" && isMutatingGet(method, path));
}

export function requireEligibleActor(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) return next();
  const state = (user.eligibility ?? "eligible") as Eligibility;
  // An eligible account can only be refused an adult-only upload, all POSTs.
  if (state === "eligible" && req.method !== "POST") return next();
  const path = apiPath(req);
  if (path === null) return next();
  // Express runs a GET handler for HEAD when no HEAD handler exists, so a
  // HEAD is the GET it will become (PR #801 round 1).
  const requested = req.method.toUpperCase();
  const method = requested === "HEAD" ? "GET" : requested;
  if (state === "underage" && !isStateChanging(method, path)) {
    // A read the account may make as itself, or the same read signed out.
    if (!isUnderAgeRead(method, path)) {
      req.user = undefined;
      req.authSessionId = undefined;
    }
    return next();
  }
  if (!isStateChanging(method, path)) return next();

  if (state !== "eligible") {
    if (exceptionFor[state](method, path)) return next();
    res.status(403).json({ error: REFUSAL_MESSAGE[state], code: REFUSAL_CODE[state] });
    return;
  }
  if (isAdultOnly(method, path) && user.is18Plus !== true) {
    res.status(403).json({ error: "Photo uploads are for members 18 and over.", code: "ADULT_REQUIRED" });
    return;
  }
  next();
}
