/**
 * Shared test helper: buildTestApp
 *
 * Constructs a minimal Express app that mounts a given router behind a stub
 * auth middleware.  The stub mirrors what authMiddleware does in production —
 * it fetches the user row by id and populates req.user with every field that
 * role-checking middlewares AND entitlement resolution depend on:
 *
 *   id, membershipTier, isAdmin, isRealAdmin, userRole, realUserRole
 *
 * Centralising the stub here means future test files never accidentally omit
 * a required field by copying-and-pasting a partial stub. Both admin flags
 * matter: `isRealAdmin` alone reads as an admin in "view as user" mode, which
 * resolves entitlements as `registered`.
 *
 * The DB lookup is memoised per userId for the lifetime of each buildTestApp()
 * call.  Since the userId is fixed for the lifetime of one app instance, this
 * avoids a SELECT on every authenticated supertest request.  Tests that need
 * to observe a changed user row mid-test should build a fresh app.
 */

import express, { type Request, type Response, type NextFunction, type Router } from "express";
import type { AuthUser } from "@workspace/api-zod";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { deriveUserRole } from "../../lib/userRole.js";
import { effectiveTierExpr } from "../../lib/membershipState.js";

export type FakeAuth =
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; userId: string };

/**
 * Build a minimal Express app that mounts `router` at `mountPath`.
 *
 * A stub middleware installed before the router populates req.user with the
 * full canonical AuthUser shape (tier, both admin flags, both roles) derived from
 * the live DB row identified by `auth.userId`.  This exercises the real
 * authorisation path end-to-end without requiring actual session cookies.
 *
 * The user row is fetched once per buildTestApp() call and reused for all
 * subsequent requests on the same app instance.
 *
 * @param auth      - Whether the request should appear authenticated, and if so
 *                    which DB user to use.
 * @param router    - The Express Router under test.
 * @param mountPath - The path prefix at which the router is mounted
 *                    (default: "/api").
 */
export function buildTestApp(
  auth: FakeAuth,
  router: Router,
  mountPath = "/api",
): express.Express {
  const app = express();
  app.use(express.json());

  if (auth.kind === "authenticated") {
    const { userId } = auth;
    let cachedUser:
      | {
          id: string;
          email: string | null;
          displayName: string | null;
          profileImageUrl: string | null;
          membershipTier: AuthUser["membershipTier"];
          isAdmin: boolean;
          isRealAdmin: boolean;
          userRole: ReturnType<typeof deriveUserRole>;
          realUserRole: ReturnType<typeof deriveUserRole>;
        }
      | null
      | undefined;

    app.use(async (req: Request, _res: Response, next: NextFunction) => {
      if (cachedUser === undefined) {
        const [dbUser] = await db
          .select({
            id: usersTable.id,
            email: usersTable.email,
            displayName: usersTable.displayName,
            profileImageUrl: usersTable.profileImageUrl,
            isAdmin: usersTable.isAdmin,
            // The EFFECTIVE tier, matching authMiddleware's chokepoint. The
            // raw column would report Legendary past a lapsed grace horizon.
            membershipTier: effectiveTierExpr(),
          })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);

        // BOTH admin flags, and the tier.
        //
        // This stub used to set `isRealAdmin` and `realUserRole` only, leaving
        // `isAdmin`, `userRole`, and `membershipTier` undefined — a shape no
        // real request ever has, because authMiddleware always populates all of
        // them. Entitlement resolution reads `isAdmin` to detect "view as user"
        // (a real admin whose EFFECTIVE admin flag is off), so a fixture
        // claiming `isRealAdmin: true` with no `isAdmin` looked exactly like an
        // admin in preview mode and correctly resolved as `registered`. The
        // resolver failing closed there is right; the fixture was wrong.
        //
        // Not previewing: these tests exercise the ordinary authenticated path.
        const isAdmin = !!dbUser?.isAdmin;
        cachedUser = dbUser
          ? {
              id:              dbUser.id,
              email:           dbUser.email,
              displayName:     dbUser.displayName,
              profileImageUrl: dbUser.profileImageUrl,
              membershipTier:  (dbUser.membershipTier ?? "registered") as AuthUser["membershipTier"],
              isAdmin,
              isRealAdmin:     isAdmin,
              userRole:        deriveUserRole(dbUser.membershipTier, isAdmin),
              realUserRole:    deriveUserRole(dbUser.membershipTier, isAdmin),
            }
          : null;
      }

      if (cachedUser) {
        req.user = cachedUser;
      }

      req.isAuthenticated = function (this: Request) {
        return this.user != null;
      } as Request["isAuthenticated"];

      next();
    });
  } else {
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      _req.isAuthenticated = function (this: Request) {
        return this.user != null;
      } as Request["isAuthenticated"];
      next();
    });
  }

  app.use(mountPath, router);
  return app;
}
