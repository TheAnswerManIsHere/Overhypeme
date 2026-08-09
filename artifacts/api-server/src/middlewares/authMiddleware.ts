import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  clearSession,
  deleteSession,
  SESSION_COOKIE,
  getSession,
  isAdminById,
  isAdminByEmail,
} from "../lib/auth";
import { deriveUserRole } from "../lib/userRole";
import { effectiveTierExpr } from "../lib/membershipState";

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

// The 7-day session DB TTL is the only expiry that matters. If a session is
// expired, the user simply re-authenticates — there is no OIDC refresh-token
// dance for the social providers we use.
//
// On every authenticated request we re-fetch the user row by primary key and
// rebuild `req.user` from it, so downstream code never sees stale profile data
// (membershipTier, displayName, pronouns, isAdmin, etc.). The session blob's
// embedded `user` field is no longer trusted — we only read `user.id` from it
// to look up the canonical row in the database.
//
// This is intentionally the single source of truth for "who is the user on
// this request". Routes and downstream middlewares MUST read `req.user.*`
// instead of doing their own user lookups.
//
// Session resolution order: Bearer token → cookie.
// A stale Bearer token (e.g. expired dev-admin-login stored in localStorage)
// falls through to the cookie rather than blocking a valid new cookie session.
// Cookie-clearance only happens for cookie sessions — Bearer tokens live in
// client-side localStorage and cannot be evicted via Set-Cookie.
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const bearerSid = req.headers["authorization"]?.startsWith("Bearer ")
    ? req.headers["authorization"].slice(7)
    : undefined;
  const cookieSid = req.cookies?.[SESSION_COOKIE] as string | undefined;

  const candidates: Array<{ sid: string; isCookie: boolean }> = [];
  if (bearerSid) candidates.push({ sid: bearerSid, isCookie: false });
  if (cookieSid) candidates.push({ sid: cookieSid, isCookie: true });

  for (const { sid, isCookie } of candidates) {
    const session = await getSession(sid);
    if (!session?.user?.id) {
      // Stale/expired session: always delete the DB row for cleanup, but
      // only clear the cookie for cookie sessions — a stale Bearer token
      // (from localStorage) must not evict a valid concurrent cookie session.
      if (isCookie) {
        await clearSession(res, sid);
      } else {
        await deleteSession(sid);
      }
      continue;
    }

    const userId = session.user.id;

    const [dbUser] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        displayName: usersTable.displayName,
        pronouns: usersTable.pronouns,
        profileImageUrl: usersTable.profileImageUrl,
        // The EFFECTIVE tier, not the raw column. Grace expiry has no Stripe
        // event, so a deadline passing revokes nothing until the convergence
        // sweep runs — and a sweep is a job that can fail. Enforcing it here
        // makes revocation at the deadline independent of scheduler health.
        // This is the chokepoint every `req.user.membershipTier` reader inherits.
        membershipTier: effectiveTierExpr(),
        isAdmin: usersTable.isAdmin,
        captchaVerified: usersTable.captchaVerified,
        nsfwModeEnabled: usersTable.nsfwModeEnabled,
      })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.isActive, true)))
      .limit(1);

    if (!dbUser) {
      if (isCookie) {
        await clearSession(res, sid);
      } else {
        await deleteSession(sid);
      }
      continue;
    }

    const isRealAdmin = !!(dbUser.isAdmin || isAdminById(dbUser.id) || isAdminByEmail(dbUser.email));
    const isAdmin = isRealAdmin && !session.adminModeDisabled;
    const captchaVerified = !!(dbUser.captchaVerified || session.captchaVerified);

    req.user = {
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      displayName: dbUser.displayName,
      pronouns: dbUser.pronouns,
      profileImageUrl: dbUser.profileImageUrl,
      membershipTier: dbUser.membershipTier,
      isAdmin,
      isRealAdmin,
      captchaVerified,
      nsfwModeEnabled: !!dbUser.nsfwModeEnabled,
      userRole: deriveUserRole(dbUser.membershipTier, isAdmin),
      realUserRole: deriveUserRole(dbUser.membershipTier, isRealAdmin),
    };

    next();
    return;
  }

  next();
}
