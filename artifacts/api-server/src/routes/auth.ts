import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCurrentAuthUserResponse,
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  LogoutMobileSessionResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  clearSession,
  getOidcConfig,
  getSessionId,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL,
  ISSUER_URL,
  type SessionData,
} from "../lib/auth";
import { deriveUserRole } from "../lib/userRole";

const OIDC_COOKIE_TTL = 10 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

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

async function upsertUser(
  claims: Record<string, unknown>,
): Promise<{ user: typeof usersTable.$inferSelect; isNewUser: boolean }> {
  const id = claims.sub as string;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  const isNewUser = existing.length === 0;

  const userData = {
    id,
    email: (claims.email as string) || null,
    firstName: (claims.first_name as string) || null,
    lastName: (claims.last_name as string) || null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as
      | string
      | null,
  };

  const [user] = await db
    .insert(usersTable)
    .values({ ...userData, isActive: true })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        ...userData,
        updatedAt: new Date(),
      },
    })
    .returning();
  return { user, isNewUser };
}

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
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
    .limit(1);

  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;
  const isRealAdmin = !!(dbUser?.isAdmin || isAdminById(req.user.id));
  const adminModeActive = isRealAdmin && !session?.adminModeDisabled;
  const effectiveTier = dbUser?.membershipTier ?? req.user.membershipTier ?? "free";
  const userRole = deriveUserRole(effectiveTier, adminModeActive);

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

router.get("/login", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", returnTo);

  if (req.query.popup === "1") {
    setOidcCookie(res, "login_popup", "1");
  }

  res.redirect(redirectTo.href);
});

// Query params are not validated because the OIDC provider may include
// parameters not expressed in the schema.
router.get("/callback", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    res.redirect("/api/login");
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);

  res.clearCookie("code_verifier", { path: "/" });
  res.clearCookie("nonce", { path: "/" });
  res.clearCookie("state", { path: "/" });
  res.clearCookie("return_to", { path: "/" });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }

  const { user: dbUser, isNewUser } = await upsertUser(
    claims as unknown as Record<string, unknown>,
  );

  if (!dbUser.isActive) {
    res.status(403).send("Account deactivated");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      displayName: dbUser.displayName,
      profileImageUrl: dbUser.profileImageUrl,
      membershipTier: dbUser.membershipTier,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
    captchaVerified: dbUser.captchaVerified,
    isAdmin: dbUser.isAdmin || isAdminById(dbUser.id),
  };

  const sid = await createSession(sessionData);
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
});

router.get("/logout", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);

  const sid = getSessionId(req);
  await clearSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: origin,
  });

  res.redirect(endSessionUrl.href);
});

// JSON logout endpoint — called via fetch so the interceptor can attach the
// Bearer token (navigation requests can't carry Authorization headers).
router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ ok: true });
});

router.post(
  "/mobile-auth/token-exchange",
  async (req: Request, res: Response) => {
    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required parameters" });
      return;
    }

    const { code, code_verifier, redirect_uri, state, nonce } = parsed.data;

    try {
      const config = await getOidcConfig();

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      callbackUrl.searchParams.set("iss", ISSUER_URL);

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: code_verifier,
        expectedNonce: nonce ?? undefined,
        expectedState: state,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        res.status(401).json({ error: "No claims in ID token" });
        return;
      }

      const { user: dbUser } = await upsertUser(
        claims as unknown as Record<string, unknown>,
      );

      if (!dbUser.isActive) {
        res.status(403).json({ error: "Account deactivated" });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const sessionData: SessionData = {
        user: {
          id: dbUser.id,
          email: dbUser.email,
          displayName: dbUser.displayName,
          profileImageUrl: dbUser.profileImageUrl,
          membershipTier: dbUser.membershipTier,
        },
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
        captchaVerified: dbUser.captchaVerified,
        isAdmin: dbUser.isAdmin || isAdminById(dbUser.id),
      };

      const sid = await createSession(sessionData);
      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: sid }));
    } catch (err) {
      req.log.error({ err }, "Mobile token exchange error");
      res.status(500).json({ error: "Token exchange failed" });
    }
  },
);

router.post("/mobile-auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) {
    await deleteSession(sid);
  }
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

export default router;
