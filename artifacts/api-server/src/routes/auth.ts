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

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

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

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
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

  // Apple only sends the user's name on the first authorization, and via the
  // form_post `user` parameter rather than the ID token. For Google we read
  // standard OIDC claims.
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

  // Preserve any value the user has already explicitly set; only seed fields
  // from the identity provider when they are currently null/empty.
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
  const config =
    provider === "google" ? await getGoogleConfig() : await getAppleConfig();

  const callbackUrl = `${getOrigin(req)}/api/callback/${provider}`;
  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect(`/api/login/${provider}`);
    return;
  }

  const currentUrl = new URL(callbackUrl);
  currentUrl.searchParams.set("code", code);
  currentUrl.searchParams.set("state", state);

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
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

  res.clearCookie("code_verifier", { path: "/" });
  res.clearCookie("nonce", { path: "/" });
  res.clearCookie("state", { path: "/" });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect(`/api/login/${provider}`);
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);
  res.clearCookie("return_to", { path: "/" });

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
  const isPopup = req.cookies?.login_popup === "1";
  res.clearCookie("login_popup", { path: "/" });

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
  // Fetch fresh fields from DB — session only stores id/email/profileImageUrl/membershipTier
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

  const params: Record<string, string> = {
    redirect_uri: callbackUrl,
    scope: provider === "apple" ? "openid name email" : "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };
  if (provider === "apple") {
    // Apple requires response_mode=form_post when scopes other than openid are
    // requested — the callback comes back as an HTTP POST form-data submission.
    params.response_mode = "form_post";
  }

  const redirectTo = oidc.buildAuthorizationUrl(config, params);

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", returnTo);

  if (req.query.popup === "1") {
    setOidcCookie(res, "login_popup", "1");
  }

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

// JSON logout endpoint — called via fetch so the interceptor can attach the
// Bearer token (navigation requests can't carry Authorization headers).
router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ ok: true });
});

export default router;
