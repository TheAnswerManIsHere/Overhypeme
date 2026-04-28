import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  clearSession,
  getSessionId,
  getSession,
  isAdminById,
} from "../lib/auth";
import { deriveUserRole } from "../lib/userRole";

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
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
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
      membershipTier: usersTable.membershipTier,
      isAdmin: usersTable.isAdmin,
      captchaVerified: usersTable.captchaVerified,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.isActive, true)))
    .limit(1);

  // Session points to a user that no longer exists (or was soft-deleted) —
  // treat the request as logged out and remove the orphaned session row.
  if (!dbUser) {
    await clearSession(res, sid);
    next();
    return;
  }

  const isRealAdmin = !!(dbUser.isAdmin || isAdminById(dbUser.id));
  // Real admins can toggle "admin mode" off to view the site as a regular
  // user. The session-scoped `adminModeDisabled` flag is purely a UI affordance
  // — backend authorization (e.g. requireAdmin) should consult `isRealAdmin`.
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
    userRole: deriveUserRole(dbUser.membershipTier, isAdmin),
    realUserRole: deriveUserRole(dbUser.membershipTier, isRealAdmin),
  };

  next();
}
