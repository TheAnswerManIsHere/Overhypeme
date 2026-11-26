/**
 * Which database login the running application uses (Launch Phase 15, increment 5b;
 * plan `docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md`).
 *
 * On production Replit supplies `DATABASE_URL` itself, as the database's owner
 * (`neondb_owner`), and ignores an override (measured twice, #1306). The owner owns
 * the NCMEC audit ledger, so an application connected as the owner could switch the
 * ledger's guard off. The application therefore reads its own login from
 * `APP_DATABASE_URL` — `overhype_app`, which owns everything the app owns except the
 * ledger and its guard — and `DATABASE_URL` stays the operator's.
 *
 * The rules, each a refusal before the first query:
 * - `APP_DATABASE_URL` set → it is the connection, provided it names the same host,
 *   port and database as `DATABASE_URL`. A mismatch is refused everywhere, so a
 *   production value copied into a workspace secret can never point development at
 *   production.
 * - In a published deployment (`REPLIT_DEPLOYMENT === "1"`) `APP_DATABASE_URL` is
 *   required, and its user must differ from `DATABASE_URL`'s. Replit does not promote
 *   a build that fails to start, so the previous release keeps serving.
 * - Otherwise `DATABASE_URL`, as before: development, tests, CI and every operator
 *   script are unchanged.
 *
 * Once resolved in a deployment, the owner's credential is deleted from `process.env`
 * (`DATABASE_URL` and libpq's `PG*` connection variables), so no child process, error
 * report or serialised environment carries it. That is defence in depth only: the
 * process's original environment stays readable in `/proc/self/environ` (measured,
 * #1306), which is the residual David accepted for Seed (Q14 → 1).
 *
 * This module imports nothing, so `bootChecks.ts` can run it before the database graph
 * loads.
 */

/** libpq's connection variables, which Replit also provides for its managed database. */
export const OWNER_CREDENTIAL_VARIABLES = [
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

export interface ResolvedAppDatabaseUrl {
  url: string;
  source: "APP_DATABASE_URL" | "DATABASE_URL";
}

export class AppDatabaseUrlRefusal extends Error {
  constructor(reason: string) {
    super(`REFUSING TO START — ${reason}`);
    this.name = "AppDatabaseUrlRefusal";
  }
}

/**
 * True only in a published Replit deployment. Deliberately not `isProductionEnv()`
 * (api-server `lib/env.ts`), which also matches `NODE_ENV=production`, as the local
 * production-mode launcher sets it without any deployment secret.
 */
export function isPublishedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REPLIT_DEPLOYMENT === "1";
}

/**
 * Parse a connection string, including the unix-socket form node-postgres accepts and the
 * WHATWG URL parser rejects: an empty host with the socket directory in `?host=`
 * (`postgres://user:pw@/db?host=/run/dir`, which the acceptance run's database relay
 * hands its children). The empty host is filled in only to get past the parser; `?host=`
 * then names the server. Null when it is not a connection string at all.
 */
function parseConnection(value: string): URL | null {
  for (const candidate of [value, value.replace(/^(postgres(?:ql)?:\/\/(?:[^/@]*@)?)\//, "$1localhost/")]) {
    try {
      return new URL(candidate);
    } catch {
      // try the socket form, then give up
    }
  }
  return null;
}

function parse(name: string, value: string): URL {
  const url = parseConnection(value);
  // Never echo the value: it holds a password.
  if (!url) throw new AppDatabaseUrlRefusal(`${name} is not a valid connection URL.`);
  return url;
}

/** The login a connection string names, decoded; never its password. Null when it cannot be read. */
export function connectionUser(url: string): string | null {
  const parsed = parseConnection(url);
  return parsed ? decodeURIComponent(parsed.username) : null;
}

/** Server (TCP host or socket directory), port and database: which database, never the credential. */
function target(url: URL): string {
  const server = url.searchParams.get("host") ?? url.hostname.toLowerCase();
  const port = url.searchParams.get("port") ?? (url.port || "5432");
  return `${server}:${port}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`;
}

/** Pure: decide the application's connection from an environment. Throws a refusal. */
export function resolveAppDatabaseUrl(env: NodeJS.ProcessEnv): ResolvedAppDatabaseUrl {
  const owner = env.DATABASE_URL;
  const app = env.APP_DATABASE_URL;

  if (!owner) {
    throw new AppDatabaseUrlRefusal("DATABASE_URL must be set. Did you forget to provision a database?");
  }

  if (!app) {
    if (isPublishedDeployment(env)) {
      throw new AppDatabaseUrlRefusal(
        "a published deployment must connect through APP_DATABASE_URL, the application's own login " +
          "(overhype_app), set as a production-only deployment secret. DATABASE_URL is the database " +
          "owner's, which owns the NCMEC audit ledger (docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md).",
      );
    }
    return { url: owner, source: "DATABASE_URL" };
  }

  const ownerUrl = parse("DATABASE_URL", owner);
  const appUrl = parse("APP_DATABASE_URL", app);
  if (target(appUrl) !== target(ownerUrl)) {
    throw new AppDatabaseUrlRefusal(
      "APP_DATABASE_URL names a different database from DATABASE_URL. It must differ only in its " +
        "user and password; set it as a production-only deployment secret, never a workspace secret.",
    );
  }
  if (isPublishedDeployment(env) && connectionUser(app) === connectionUser(owner)) {
    throw new AppDatabaseUrlRefusal(
      "APP_DATABASE_URL uses the same login as DATABASE_URL, the database owner. It must name the " +
        "application's own role (overhype_app).",
    );
  }
  return { url: app, source: "APP_DATABASE_URL" };
}

/** Delete the owner's credential from an environment. Returns the names removed. */
export function scrubOwnerCredential(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of OWNER_CREDENTIAL_VARIABLES) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

let established: ResolvedAppDatabaseUrl | undefined;

/**
 * Resolve the process's connection once, and in a deployment remove the owner's
 * credential from `process.env`. Idempotent: every later caller gets the same answer,
 * which is why it must run before the scrub could hide `DATABASE_URL` from it.
 */
export function establishAppDatabaseUrl(env: NodeJS.ProcessEnv = process.env): ResolvedAppDatabaseUrl {
  if (established) return established;
  const resolved = resolveAppDatabaseUrl(env);
  established = resolved;
  if (isPublishedDeployment(env)) scrubOwnerCredential(env);
  return resolved;
}

/**
 * The application's connection string, or `undefined` when no database is configured at
 * all (no `DATABASE_URL` and nothing established). For a consumer whose "no database"
 * branch is legitimate, such as Stripe start-up in a script; a refusal still throws.
 */
export function appDatabaseUrlIfConfigured(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (established) return established.url;
  if (!env.DATABASE_URL) return undefined;
  return establishAppDatabaseUrl(env).url;
}

/** The application's connection string, for every runtime consumer (the pool, Stripe, the backup). */
export function appDatabaseUrl(): string {
  return establishAppDatabaseUrl().url;
}
