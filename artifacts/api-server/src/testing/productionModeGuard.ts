/**
 * The refusals the production-mode test launcher applies before it imports
 * anything that touches the database or the network.
 *
 * The launcher boots the real server with `NODE_ENV=production` so a browser
 * test can exercise the production authentication path — the secure cookie,
 * the absent dev-admin login, the queued email delivery — with exactly one
 * thing replaced: the email transport. Every condition below exists so that
 * the one replacement cannot be pointed at anything real:
 *
 * - it must actually be a production-mode boot, or there is no reason to use it;
 * - it must not be a real deployment (`REPLIT_DEPLOYMENT=1`);
 * - no Resend key may be present, so no part of a run can reach the real vendor;
 * - the mail sink directory must be named and absolute;
 * - email links must point at a local frontend, never at overhype.me;
 * - the database must not be a protected one.
 *
 * The database rule mirrors `assert_not_production` in
 * `scripts/lib/test-db.sh` — the same default names (`heliumdb`, `neondb`,
 * `production`), the same "contains prod" rule, the same `neon.tech` host
 * marker, and the same `TEST_DB_PROTECTED_NAMES` / `TEST_DB_PROTECTED_HOSTS`
 * extensions — minus its `NODE_ENV=production` clause, which this launcher sets
 * by design. `__tests__/productionModeGuard.test.ts` reads the shell guard's
 * default lists and fails if the two drift.
 *
 * Pure: it reads only the environment object it is given, so it is unit-tested
 * without booting anything (`__tests__/productionModeGuard.test.ts`).
 */

export const PROTECTED_DB_NAMES = ["heliumdb", "neondb", "production"];
export const PROTECTED_HOST_MARKERS = ["neon.tech"];
const RESEND_KEY_VARS = ["RESEND_API_KEY", "RESEND_API_KEY_PROD", "RESEND_API_KEY_DEV"];

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function productionModeRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals: string[] = [];

  if ((env.NODE_ENV ?? "").toLowerCase() !== "production") {
    refusals.push("NODE_ENV must be 'production': this launcher exists to boot production mode; use the dev server otherwise");
  }
  if (env.REPLIT_DEPLOYMENT === "1") {
    refusals.push("REPLIT_DEPLOYMENT=1 marks a real deployment; the test launcher never runs there");
  }

  const presentKeys = RESEND_KEY_VARS.filter((name) => (env[name] ?? "").trim() !== "");
  if (presentKeys.length > 0) {
    refusals.push(`a Resend API key is set (${presentKeys.join(", ")}); unset it so no email can reach the real vendor`);
  }

  const sinkDir = env.E2E_MAIL_SINK_DIR ?? "";
  if (!sinkDir.startsWith("/")) {
    refusals.push("E2E_MAIL_SINK_DIR must be an absolute directory path for the captured email");
  }

  const siteBase = env.SITE_BASE_URL ?? "";
  try {
    const url = new URL(siteBase);
    if (!isLocalHostname(url.hostname)) {
      refusals.push(`SITE_BASE_URL must point at a local frontend (localhost), not ${url.hostname}`);
    }
  } catch {
    refusals.push("SITE_BASE_URL must be set to the local frontend URL the email links should open");
  }

  refusals.push(...protectedDatabaseRefusals(env));

  return refusals;
}

/**
 * The database half of the rule, shared with the E2E test-account seed
 * (`scripts/seed-e2e-test-accounts.ts`), which writes accounts with a known
 * password and so must never reach a live database either.
 */
export function protectedDatabaseRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals: string[] = [];
  const names = [...PROTECTED_DB_NAMES, ...splitList(env.TEST_DB_PROTECTED_NAMES)];
  const hostMarkers = [...PROTECTED_HOST_MARKERS, ...splitList(env.TEST_DB_PROTECTED_HOSTS)];
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!dbName) {
      refusals.push("DATABASE_URL names no database");
    } else if (names.includes(dbName) || dbName.toLowerCase().includes("prod")) {
      refusals.push(`database '${dbName}' is protected (heliumdb=dev, neondb=production, a name containing 'prod', or TEST_DB_PROTECTED_NAMES)`);
    }
    const host = url.hostname.toLowerCase();
    const marker = hostMarkers.find((m) => host.includes(m));
    if (marker) {
      refusals.push(`database host '${host}' matches the protected marker '${marker}'`);
    }
  } catch {
    refusals.push("DATABASE_URL must be a parseable postgres URL");
  }
  return refusals;
}

/** Comma- or space-separated, as `_td_split` reads the same variables in test-db.sh. */
function splitList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}
