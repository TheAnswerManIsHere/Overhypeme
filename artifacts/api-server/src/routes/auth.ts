import * as oidc from "openid-client";
import * as Sentry from "@sentry/node";
import { Router, type IRouter, type Request, type Response } from "express";
import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  clearSession,
  getGoogleConfig,
  getAppleConfig,
  getSessionId,
  getSession,
  createSession,
  updateSession,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";
import { deriveUserRole } from "../lib/userRole";

// ── Pending OAuth state ───────────────────────────────────────────────────────
// We store PKCE state server-side (keyed by the OAuth `state` parameter) rather
// than in cookies. In Replit's dev environment the API and web servers run on
// different internal ports behind the same proxy, and cross-port cookie
// round-trips during OAuth redirects are unreliable. A server-side Map avoids
// that class of problem entirely. TTL is 10 minutes — if the server restarts in
// that window the user just clicks "Continue with Google" again.

const PENDING_TTL = 10 * 60 * 1000; // 10 minutes

interface PendingOAuthState {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  isPopup: boolean;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingOAuthState>();

function storePendingState(state: string, data: Omit<PendingOAuthState, "expiresAt">) {
  pendingStates.set(state, { ...data, expiresAt: Date.now() + PENDING_TTL });
}

function consumePendingState(state: string): PendingOAuthState | null {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

// Sweep expired entries every 5 minutes so the map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expiresAt < now) pendingStates.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ── Router ────────────────────────────────────────────────────────────────────

export function isAdminById(userId: string): boolean {
  const ids = process.env.ADMIN_USER_IDS?.split(",").map((s) => s.trim()) ?? [];
  return ids.includes(userId);
}

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

  const oidcFirstName =
    provider === "apple"
      ? (appleNameOverride?.firstName ?? null)
      : ((claims.given_name as string) || null);

  const oidcLastName =
    provider === "apple"
      ? (appleNameOverride?.lastName ?? null)
      : ((claims.family_name as string) || null);

  const existingFirstName = existing[0]?.firstName ?? null;
  const existingLastName = existing[0]?.lastName ?? null;

  const profileImageUrl = (claims.picture as string) || null;

  const conflictSet: Record<string, unknown> = {
    oauthProvider: existing[0]?.oauthProvider ?? provider,
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
      oauthProvider: provider,
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
  // Retrieve PKCE state from server-side store — avoids cross-proxy cookie loss.
  const pending = consumePendingState(state);
  if (!pending) {
    // State expired or never existed — restart the login flow.
    res.redirect(`/api/login/${provider}`);
    return;
  }

  const { codeVerifier, nonce, returnTo, isPopup } = pending;

  const config =
    provider === "google" ? await getGoogleConfig() : await getAppleConfig();

  // openid-client v6 validates ALL query parameters in the callback URL,
  // including the `iss` parameter that Google (RFC 9207) includes. Build the
  // full URL from the actual incoming request so nothing is lost.
  const currentUrl = new URL(getOrigin(req) + req.originalUrl);

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState: state,
      idTokenExpected: true,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth: "oauth-callback" },
      extra: { provider, stage: "authorizationCodeGrant" },
    });
    res.redirect(`/api/login/${provider}`);
    return;
  }

  const claims = tokens.claims();
  if (!claims) {
    res.redirect(`/api/login/${provider}`);
    return;
  }

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

  const basePath = process.env.BASE_PATH || "";

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
  const [dbUser] = await db
    .select({
      membershipTier: usersTable.membershipTier,
      isAdmin: usersTable.isAdmin,
      pronouns: usersTable.pronouns,
      displayName: usersTable.displayName,
      captchaVerified: usersTable.captchaVerified,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
    .limit(1);

  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;
  const isRealAdmin = !!(dbUser?.isAdmin || isAdminById(req.user.id));
  const adminModeActive = isRealAdmin && !session?.adminModeDisabled;
  const effectiveTier = dbUser?.membershipTier ?? req.user.membershipTier ?? "unregistered";
  const userRole = deriveUserRole(effectiveTier, adminModeActive);
  const captchaVerified = !!(dbUser?.captchaVerified || session?.captchaVerified);

  res.json(
    GetCurrentAuthUserResponse.parse({
      user: {
        ...req.user,
        membershipTier: effectiveTier,
        isAdmin: adminModeActive,
        isRealAdmin,
        pronouns: dbUser?.pronouns ?? null,
        displayName: dbUser?.displayName ?? null,
        userRole,
        captchaVerified,
      },
    }),
  );
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

  const callbackUrl = `${getOrigin(req)}/api/callback/${provider}`;
  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  // Store PKCE state server-side — more reliable than cookies across proxy hops.
  storePendingState(state, {
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

  const redirectTo = oidc.buildAuthorizationUrl(config, params);
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
  res.redirect(getOrigin(req));
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ ok: true });
});

export default router;
