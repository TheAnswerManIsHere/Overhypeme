import * as oidc from "openid-client";
import * as Sentry from "@sentry/node";
import { Router, type IRouter, type Request, type Response } from "express";
import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import { db, usersTable, oauthPendingStatesTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import {
  clearSession,
  getGoogleConfig,
  getAppleConfig,
  getSessionId,
  getSession,
  createSession,
  updateSession,
  isAdminById,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { logger } from "../lib/logger";
import { sanitizeAndValidatePersonalName } from "../lib/validators/personalName";

// Re-exported for back-compat with other route modules that import from "./auth".
// Canonical home is `lib/auth.ts` so the auth middleware can use it without a
// route ↔ middleware import cycle.
export { isAdminById };

// ── Test seams ────────────────────────────────────────────────────────────────
// These are only called from tests — never in production paths.
// Convention mirrors lib/email.ts → _resetResendAuthDisabledForTests().

type AuthCodeGrantFn = typeof oidc.authorizationCodeGrant;
let _oidcAuthCodeGrant: AuthCodeGrantFn = oidc.authorizationCodeGrant;
export function _setAuthCodeGrantForTest(fn: AuthCodeGrantFn): void {
  _oidcAuthCodeGrant = fn;
}
export function _resetAuthCodeGrantForTest(): void {
  _oidcAuthCodeGrant = oidc.authorizationCodeGrant;
}

type BuildAuthorizationUrlFn = typeof oidc.buildAuthorizationUrl;
let _oidcBuildAuthorizationUrl: BuildAuthorizationUrlFn = oidc.buildAuthorizationUrl;
export function _setBuildAuthorizationUrlForTest(fn: BuildAuthorizationUrlFn): void {
  _oidcBuildAuthorizationUrl = fn;
}
export function _resetBuildAuthorizationUrlForTest(): void {
  _oidcBuildAuthorizationUrl = oidc.buildAuthorizationUrl;
}

// ── Pending OAuth state ───────────────────────────────────────────────────────
// We store PKCE state in the database (keyed by the OAuth `state` parameter)
// rather than in an in-memory Map. This survives server restarts, which
// previously caused an infinite redirect loop when the server restarted while
// a login was in progress (the in-memory state was lost, consumePendingState
// returned null, and the code bounced back to /api/login/:provider forever).
// TTL is 10 minutes — expired rows are swept periodically.

const PENDING_TTL = 10 * 60 * 1000; // 10 minutes

interface PendingOAuthState {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  isPopup: boolean;
  linkUserId?: string | null;
}

async function storePendingState(state: string, data: PendingOAuthState): Promise<void> {
  const expiresAt = new Date(Date.now() + PENDING_TTL);
  await db
    .insert(oauthPendingStatesTable)
    .values({ state, ...data, expiresAt })
    .onConflictDoUpdate({
      target: oauthPendingStatesTable.state,
      set: { ...data, expiresAt },
    });
}

export const _storePendingStateForTest = storePendingState;

async function consumePendingState(state: string): Promise<PendingOAuthState | null> {
  const [row] = await db
    .delete(oauthPendingStatesTable)
    .where(eq(oauthPendingStatesTable.state, state))
    .returning();
  if (!row || row.expiresAt < new Date()) return null;
  return {
    codeVerifier: row.codeVerifier,
    nonce: row.nonce,
    returnTo: row.returnTo,
    isPopup: row.isPopup,
    linkUserId: row.linkUserId ?? null,
  };
}

// Sweep expired rows every 5 minutes so the table doesn't grow unboundedly.
setInterval(async () => {
  try {
    await db
      .delete(oauthPendingStatesTable)
      .where(lt(oauthPendingStatesTable.expiresAt, new Date()));
  } catch {
    // Non-fatal — stale rows will be ignored by consumePendingState anyway.
  }
}, 5 * 60 * 1000).unref();

// ── Router ────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

// SameSite=None; Secure is required for cookies to work inside the Replit
// preview pane (an iframe embedded in a cross-origin parent). Without this,
// browsers block cookie reads/writes in third-party iframe contexts.
function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
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

type OAuthProvider = "google" | "apple";

async function upsertUser(
  claims: Record<string, unknown>,
  provider: OAuthProvider,
  appleNameOverride?: { firstName?: string; lastName?: string },
): Promise<{ user: typeof usersTable.$inferSelect; isNewUser: boolean }> {
  const email = ((claims.email as string) || "").toLowerCase().trim();
  if (!email) throw new Error("No email in OAuth claims");

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  const isNewUser = existing.length === 0;

  // Sanitize OIDC name claims through the same validator as user-supplied
  // names. Provider claims are user-influenced (Apple in particular lets
  // the user pick whatever they want at first authorize). Per soft-cap
  // policy, falling back to null if the provider gave us something we
  // would not accept on a profile PATCH.
  const rawFirstName =
    provider === "apple"
      ? (appleNameOverride?.firstName ?? null)
      : ((claims.given_name as string) || null);
  const rawLastName =
    provider === "apple"
      ? (appleNameOverride?.lastName ?? null)
      : ((claims.family_name as string) || null);

  async function safeName(input: string | null): Promise<string | null> {
    if (!input) return null;
    const result = await sanitizeAndValidatePersonalName(input, { skipDenylist: true });
    return result.ok ? result.value : null;
  }
  const oidcFirstName = await safeName(rawFirstName);
  const oidcLastName = await safeName(rawLastName);

  const existingFirstName = existing[0]?.firstName ?? null;
  const existingLastName = existing[0]?.lastName ?? null;

  const profileImageUrl = (claims.picture as string) || null;

  const conflictSet: Record<string, unknown> = {
    ...(provider === "google" ? { googleLinked: true } : { appleLinked: true }),
    updatedAt: new Date(),
  };
  if (!existing[0]?.profileImageUrl && profileImageUrl) {
    conflictSet.profileImageUrl = profileImageUrl;
  }
  if (!existingFirstName && oidcFirstName) conflictSet.firstName = oidcFirstName;
  if (!existingLastName && oidcLastName) conflictSet.lastName = oidcLastName;

  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      firstName: oidcFirstName,
      lastName: oidcLastName,
      profileImageUrl,
      googleLinked: provider === "google",
      appleLinked: provider === "apple",
      isActive: true,
    })
    .onConflictDoUpdate({
      target: usersTable.email,
      set: conflictSet,
    })
    .returning();

  return { user, isNewUser };
}

async function handleOAuthCallback(
  req: Request,
  res: Response,
  provider: OAuthProvider,
  code: string,
  state: string,
  appleNameOverride?: { firstName?: string; lastName?: string },
): Promise<void> {
  // Retrieve PKCE state from DB store — survives server restarts.
  const pending = await consumePendingState(state);
  if (!pending) {
    // State expired or never existed.
    // NOTE: Do NOT restart the OAuth flow here — that causes an infinite
    // redirect loop when the state was stored on a different server instance
    // (e.g. dev server stored state but production handles the callback).
    // Instead, send the user back to the login page with a clear error.
    Sentry.captureMessage("OAuth pending state not found", {
      level: "warning",
      tags: { auth: "oauth-callback", provider },
      extra: { stage: "consumePendingState", state: state?.slice(0, 8) + "…" },
    });
    const basePath = process.env.BASE_PATH || "";
    res.redirect(`${basePath}/login?error=session_expired`);
    return;
  }

  const { codeVerifier, nonce, returnTo, isPopup, linkUserId } = pending;

  const config =
    provider === "google" ? await getGoogleConfig() : await getAppleConfig();

  // openid-client v6 validates ALL query parameters in the callback URL,
  // including the `iss` parameter that Google (RFC 9207) includes. Build the
  // full URL using the canonical site base (same domain that was registered as
  // the redirect_uri with Apple/Google) + any query params from the request.
  const currentUrl = new URL(getSiteBaseUrl() + req.originalUrl);

  // Apple Sign In uses response_mode=form_post: the authorization response
  // params (code, state, etc.) arrive in the POST body rather than the URL
  // query string. openid-client v6 reads params exclusively from
  // currentUrl.searchParams, so copy any body string values that are not
  // already present in the query string. This is a no-op for Google callbacks
  // (which use the default query response mode) since their params are already
  // in req.originalUrl.
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
      if (typeof value === "string" && !currentUrl.searchParams.has(key)) {
        currentUrl.searchParams.set(key, value);
      }
    }
  }

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await _oidcAuthCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState: state,
      idTokenExpected: true,
    });
  } catch (err) {
    logger.error({
      err,
      provider,
      currentUrl: currentUrl.toString(),
      stage: "authorizationCodeGrant",
    }, "OAuth token exchange failed");
    Sentry.captureException(err, {
      tags: { auth: "oauth-callback" },
      extra: { provider, stage: "authorizationCodeGrant" },
    });
    const basePath = process.env.BASE_PATH || "";
    res.redirect(`${basePath}/login?error=auth_failed`);
    return;
  }

  const claims = tokens.claims();
  if (!claims) {
    Sentry.captureMessage("OAuth claims missing after token exchange", {
      level: "error",
      tags: { auth: "oauth-callback", provider },
    });
    const basePath = process.env.BASE_PATH || "";
    res.redirect(`${basePath}/login?error=auth_failed`);
    return;
  }

  const basePath = process.env.BASE_PATH || "";

  // ── Link mode: associate the OAuth provider with an existing account ─────
  if (pending.linkUserId) {
    const linkUserId = pending.linkUserId;
    const oauthEmail = ((claims.email as string) || "").toLowerCase().trim();
    const [targetUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, linkUserId))
      .limit(1);

    if (!targetUser) {
      res.redirect(`${basePath}${returnTo}?link_error=user_not_found`);
      return;
    }

    if (oauthEmail && targetUser.email && oauthEmail !== targetUser.email.toLowerCase()) {
      res.redirect(`${basePath}${returnTo}?link_error=email_mismatch`);
      return;
    }

    const alreadyLinked = provider === "google" ? targetUser.googleLinked : targetUser.appleLinked;
    if (alreadyLinked) {
      res.redirect(`${basePath}${returnTo}?link_error=already_linked`);
      return;
    }

    const providerUpdate = provider === "google"
      ? { googleLinked: true }
      : { appleLinked: true };

    await db
      .update(usersTable)
      .set({ ...providerUpdate, updatedAt: new Date() })
      .where(eq(usersTable.id, linkUserId));

    res.redirect(`${basePath}${returnTo}?linked=1`);
    return;
  }

  // ── Normal login/signup mode ──────────────────────────────────────────────
  let dbUser: typeof usersTable.$inferSelect;
  let isNewUser: boolean;
  try {
    ({ user: dbUser, isNewUser } = await upsertUser(
      claims as unknown as Record<string, unknown>,
      provider,
      appleNameOverride,
    ));
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth: "oauth-callback" },
      extra: { provider, stage: "upsertUser" },
    });
    res
      .status(400)
      .send(
        "Unable to retrieve email from your account. Please use email/password sign-in.",
      );
    return;
  }

  if (!dbUser.isActive) {
    res.status(403).send("Account deactivated");
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      displayName: dbUser.displayName,
      profileImageUrl: dbUser.profileImageUrl,
      membershipTier: dbUser.membershipTier,
    },
    access_token: tokens.access_token,
    captchaVerified: dbUser.captchaVerified,
    isAdmin: dbUser.isAdmin || isAdminById(dbUser.id),
  };

  const sid = await createSession(sessionData, dbUser.id);
  setSessionCookie(res, sid);

  if (isPopup) {
    const target = isNewUser
      ? `${basePath}/onboard?returnTo=${encodeURIComponent(returnTo)}`
      : basePath + returnTo;
    const safeTarget = JSON.stringify(target);
    res.send(`<!DOCTYPE html><html><body><script>
      var t = ${safeTarget};
      if (window.opener) { window.opener.location.href = t; window.close(); }
      else { window.location.href = t; }
    </script></body></html>`);
  } else if (isNewUser) {
    res.redirect(`${basePath}/onboard?returnTo=${encodeURIComponent(returnTo)}`);
  } else {
    res.redirect(returnTo);
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────

router.get("/auth/user", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.isAuthenticated()) {
    res.json(GetCurrentAuthUserResponse.parse({ user: null }));
    return;
  }
  // `req.user` is rebuilt from the database on every authenticated request by
  // authMiddleware, so it is the authoritative source of profile state. No
  // additional DB roundtrip needed here.
  res.json(GetCurrentAuthUserResponse.parse({ user: req.user }));
});

router.post("/auth/toggle-admin-mode", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const sid = getSessionId(req);
  if (!sid) {
    res.status(401).json({ error: "No session" });
    return;
  }
  const session = await getSession(sid);
  if (!session) {
    res.status(401).json({ error: "Session not found" });
    return;
  }

  const [dbUser] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
    .limit(1);

  const isRealAdmin = !!(dbUser?.isAdmin || isAdminById(req.user.id));
  if (!isRealAdmin) {
    res.status(403).json({ error: "Not an admin" });
    return;
  }

  session.adminModeDisabled = !session.adminModeDisabled;
  await updateSession(sid, session);

  res.json({ adminModeActive: !session.adminModeDisabled });
});

function isProviderConfigured(provider: OAuthProvider): boolean {
  if (provider === "google") {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }
  return !!(
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  );
}

// Bare /login — redirect to the default provider (Google) so that the
// frontend can call login() without knowing which provider to use.
router.get("/login", (req: Request, res: Response) => {
  const returnTo = req.query.returnTo
    ? `?returnTo=${encodeURIComponent(String(req.query.returnTo))}`
    : "";
  res.redirect(`/api/login/google${returnTo}`);
});

router.get("/login/:provider", async (req: Request, res: Response) => {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "google" && provider !== "apple") {
    res.status(404).send("Unknown provider");
    return;
  }

  if (!isProviderConfigured(provider)) {
    res.status(503).send(`${provider} sign-in is not yet configured`);
    return;
  }

  const config =
    provider === "google" ? await getGoogleConfig() : await getAppleConfig();

  // Use the canonical site base URL (https://overhype.me in production) rather
  // than the incoming request origin. The redirect_uri sent to Apple/Google must
  // exactly match the URL registered in the developer console, and that URL is
  // always the stable custom domain — not a variable Replit forwarding header.
  const callbackUrl = `${getSiteBaseUrl()}/api/callback/${provider}`;
  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  // Store PKCE state in DB — survives server restarts and avoids redirect loops.
  await storePendingState(state, {
    codeVerifier,
    nonce,
    returnTo,
    isPopup: req.query.popup === "1",
  });

  const params: Record<string, string> = {
    redirect_uri: callbackUrl,
    scope: provider === "apple" ? "openid name email" : "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };
  if (provider === "apple") {
    params.response_mode = "form_post";
  }

  const redirectTo = _oidcBuildAuthorizationUrl(config, params);
  res.redirect(redirectTo.href);
});

// ── Link provider route ───────────────────────────────────────────────────────
// Authenticated-only. Stores a pending OAuth state with the current user's ID
// so the callback can link the provider to the existing account instead of
// creating/logging-in a new session.
router.get("/link/:provider", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).send("Not authenticated");
    return;
  }

  const provider = req.params.provider as OAuthProvider;
  if (provider !== "google" && provider !== "apple") {
    res.status(404).send("Unknown provider");
    return;
  }

  if (!isProviderConfigured(provider)) {
    res.status(503).send(`${provider} sign-in is not yet configured`);
    return;
  }

  const [currentUser] = await db
    .select({ googleLinked: usersTable.googleLinked, appleLinked: usersTable.appleLinked })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);

  const isAlreadyLinked = provider === "google" ? currentUser?.googleLinked : currentUser?.appleLinked;
  if (isAlreadyLinked) {
    const basePath = process.env.BASE_PATH || "";
    const returnTo = getSafeReturnTo(req.query.returnTo);
    res.redirect(`${basePath}${returnTo}?link_error=already_linked`);
    return;
  }


  const config =
    provider === "google" ? await getGoogleConfig() : await getAppleConfig();

  const callbackUrl = `${getSiteBaseUrl()}/api/callback/${provider}`;
  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  await storePendingState(state, {
    codeVerifier,
    nonce,
    returnTo,
    isPopup: false,
    linkUserId: req.user.id,
  });

  const params: Record<string, string> = {
    redirect_uri: callbackUrl,
    scope: provider === "apple" ? "openid name email" : "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };
  if (provider === "apple") {
    params.response_mode = "form_post";
  }

  const redirectTo = _oidcBuildAuthorizationUrl(config, params);
  res.redirect(redirectTo.href);
});

router.get("/callback/google", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  if (!code || !state) {
    res.redirect("/api/login/google");
    return;
  }
  await handleOAuthCallback(req, res, "google", code, state);
});

router.post("/callback/apple", async (req: Request, res: Response) => {
  const code = req.body?.code as string;
  const state = req.body?.state as string;
  if (!code || !state) {
    res.redirect("/api/login/apple");
    return;
  }

  let appleNameOverride: { firstName?: string; lastName?: string } | undefined;
  if (req.body?.user) {
    try {
      const appleUser = JSON.parse(req.body.user as string);
      appleNameOverride = {
        firstName: appleUser?.name?.firstName,
        lastName: appleUser?.name?.lastName,
      };
    } catch {
      // Apple only sends `user` on first login — its absence is expected.
    }
  }

  await handleOAuthCallback(req, res, "apple", code, state, appleNameOverride);
});

router.get("/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.redirect(getSiteBaseUrl());
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ ok: true });
});

export default router;
