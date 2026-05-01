/**
 * Shared test helper: buildTestApp
 *
 * Constructs a minimal Express app that mounts a given router behind a stub
 * auth middleware.  The stub mirrors what authMiddleware does in production —
 * it fetches the user row by id and populates req.user with every field that
 * role-checking middlewares (requireAdmin, requireRole) depend on:
 *
 *   id, isRealAdmin, realUserRole
 *
 * Centralising the stub here means future test files never accidentally omit
 * a required field (e.g. realUserRole) by copying-and-pasting a partial stub.
 *
 * The DB lookup is memoised per userId for the lifetime of each buildTestApp()
 * call.  Since the userId is fixed for the lifetime of one app instance, this
 * avoids a SELECT on every authenticated supertest request.  Tests that need
 * to observe a changed user row mid-test should build a fresh app.
 */

import express, { type Request, type Response, type NextFunction, type Router } from "express";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { deriveUserRole } from "../../lib/userRole.js";

export type FakeAuth =
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; userId: string };

/**
 * Build a minimal Express app that mounts `router` at `mountPath`.
 *
 * A stub middleware installed before the router populates req.user with the
 * full canonical AuthUser shape (id, isRealAdmin, realUserRole) derived from
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
    let cachedUser: { id: string; isRealAdmin: boolean; realUserRole: ReturnType<typeof deriveUserRole> } | null | undefined;

    app.use(async (req: Request, _res: Response, next: NextFunction) => {
      if (cachedUser === undefined) {
        const [dbUser] = await db
          .select({ id: usersTable.id, isAdmin: usersTable.isAdmin })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);

        cachedUser = dbUser
          ? {
              id:           dbUser.id,
              isRealAdmin:  !!dbUser.isAdmin,
              realUserRole: deriveUserRole(undefined, !!dbUser.isAdmin),
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
