/**
 * Refuse to run destructive e2e SQL against a live database.
 *
 * These specs do not read — they `UPDATE users SET membership_tier`, create
 * users and create memes. `assert_not_production`
 * (artifacts/api-server/scripts/lib/test-db.sh) is what the repo's DB test
 * runners call before doing that, per docs/tests/TESTING.md. It is a shell
 * function, so a Playwright spec cannot call it; this mirrors its rules.
 *
 * Deny by detection, with no opt-in flag: refuse when NODE_ENV is production,
 * when the database name is exactly a protected name or contains "prod", when
 * the host carries a protected marker, or when the URL will not parse at all.
 *
 * The name match is EXACT, which is what keeps `heliumdb_test`, `overhype_test`
 * and the per-worker `heliumdb_t_*` clones usable while `heliumdb` and `neondb`
 * are refused. The host marker is deliberately the whole provider rather than
 * one endpoint: an endpoint hostname is environment-specific config that does
 * not belong in a public repo, and matching the provider fails closed for any
 * future Neon database.
 *
 * Consequence worth stating: the legacy Replit fallback these specs used to be
 * pinned to targets `heliumdb`, which IS protected — so that path now refuses
 * too. That is the guard working rather than a regression. On Replit, point
 * DATABASE_URL at the test database (TEST_DATABASE_URL / `heliumdb_test`), which
 * is what TESTING.md has always prescribed for destructive runs.
 */

const PROTECTED_NAMES = ["heliumdb", "neondb", "production"];
const PROTECTED_HOSTS = ["neon.tech"];

/** Comma/space-separated, matching the shell guard's _td_split. */
function split(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter(Boolean);
}

export function productionDbRefusal(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if ((env["NODE_ENV"] ?? "").toLowerCase() === "production") {
    return "NODE_ENV=production — refusing to run destructive e2e SQL.";
  }
  if (!url) {
    return "no DATABASE_URL set — refusing to run destructive e2e SQL against an unknown database. Point it at the test database (heliumdb_test on Replit, overhype_test in CI).";
  }

  let name: string;
  let host: string;
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    host = parsed.hostname;
  } catch {
    return "could not parse DATABASE_URL — refusing to proceed.";
  }
  if (!name) return "no database name in DATABASE_URL — refusing to proceed.";

  for (const p of [...PROTECTED_NAMES, ...split(env["TEST_DB_PROTECTED_NAMES"])]) {
    if (name === p) {
      return `database "${name}" is a protected live database (heliumdb=dev, neondb=production) — refusing. Point DATABASE_URL at the test database instead.`;
    }
  }
  if (name.includes("prod")) {
    return `database name "${name}" looks like production (contains "prod") — refusing.`;
  }
  for (const p of [...PROTECTED_HOSTS, ...split(env["TEST_DB_PROTECTED_HOSTS"])]) {
    if (host.includes(p)) {
      return `host "${host}" matches a protected marker ("${p}") — refusing.`;
    }
  }
  return null;
}

/** Throws unless the configured database is safe to mutate. */
export function assertNotProductionDb(url: string | undefined = process.env["DATABASE_URL"]): void {
  const refusal = productionDbRefusal(url);
  if (refusal) throw new Error(`[e2e safety] ${refusal}`);
}
