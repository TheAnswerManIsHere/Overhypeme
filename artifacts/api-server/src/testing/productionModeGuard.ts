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
 * - email links must point at a local frontend, never at overhype.me.
 *
 * The database rule is not here: the launcher also requires a marked test
 * database (`@workspace/db/test-database`), which has to be read from the
 * database itself. These checks are pure — they read only the environment
 * object they are given — so they are unit-tested without booting anything
 * (`__tests__/productionModeGuard.test.ts`).
 */

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

  return refusals;
}
