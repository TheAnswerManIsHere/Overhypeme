/**
 * The test-database marker: how test tooling knows a database is disposable.
 *
 * A database is a test database when, and only when, it carries the stored
 * database-level setting `overhype.test_database = 'yes'`. Whatever CREATES a
 * throwaway database writes it, once, against a target it names itself (CI's
 * service database, `scripts/setup-test-db.sh`'s local cluster, a database a CI
 * step has just created) — never against an ambient `DATABASE_URL`. Every
 * destructive or test-only operation reads it and refuses without it:
 * `push-force`, the api-server test runners, the E2E account seed and the
 * production-mode launcher.
 *
 * Why a marker in the database rather than a rule about its name or host
 * (David, 2026-10-10): a connection string is an address, and the same data is
 * reachable at many addresses — a pooled hostname, a branch, a restored copy
 * under a new name. A list of protected names fails open on every name it has
 * not learned yet; the one it replaced already did once, protecting dev while
 * production was renamed past it. The marker fails closed: production and the
 * dev database never carry it, so they are refused with nothing to maintain.
 *
 * The setting is read from the catalog (`pg_db_role_setting`), not through
 * `current_setting()`, so a connection string carrying `options=-c ...` cannot
 * claim it. `drizzle-kit push` does not touch database-level settings, so the
 * marker survives every schema push. It is NOT copied by `CREATE DATABASE ...
 * TEMPLATE`; nothing checks the per-worker clones, whose creator is the runner.
 */
import pg from "pg";

export const TEST_DATABASE_SETTING = "overhype.test_database";
export const TEST_DATABASE_VALUE = "yes";

/** The SQL a database's creator runs to mark it. Quote the name yourself. */
export const markTestDatabaseSql = (quotedDatabaseName: string): string =>
  `ALTER DATABASE ${quotedDatabaseName} SET ${TEST_DATABASE_SETTING} = '${TEST_DATABASE_VALUE}'`;

/** True when the connected database carries the stored setting `$<param>` ("name=value"). Read from the catalog. */
const settingStoredSql = (param: number): string => `EXISTS (
  SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
   WHERE d.datname = current_database() AND s.setrole = 0 AND $${param} = ANY (s.setconfig)
)`;

/** `connectionString` pointed at another database on the same server. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestDatabaseMarker {
  database: string;
  marked: boolean;
}

export async function readTestDatabaseMarker(connectionString: string): Promise<TestDatabaseMarker> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ database: string; marked: boolean }>(
      `SELECT current_database() AS database, ${settingStoredSql(1)} AS marked`,
      [`${TEST_DATABASE_SETTING}=${TEST_DATABASE_VALUE}`],
    );
    return rows[0]!;
  } finally {
    await client.end();
  }
}

/**
 * Why `env` must not be used as a test database's environment, or null when it
 * may. Also refuses a production process outright: a deployment is never a
 * place for test tooling, whatever its database says.
 */
export async function testDatabaseRefusal(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.REPLIT_DEPLOYMENT === "1") return "this is a real deployment (REPLIT_DEPLOYMENT=1)";
  const url = env.DATABASE_URL;
  if (!url) return "DATABASE_URL is not set";
  let marker: TestDatabaseMarker;
  try {
    marker = await readTestDatabaseMarker(url);
  } catch (err) {
    return `could not read the test-database marker (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!marker.marked) {
    return (
      `database '${marker.database}' is not marked as a test database. Only whatever created a ` +
      `throwaway database marks it (${markTestDatabaseSql('"<name>"')}); production and the dev ` +
      `database are never marked.`
    );
  }
  return null;
}

/**
 * The fake-Stripe ownership setting (#566, plan decision 12).
 *
 * The test marker says a database is disposable; it does not say the database
 * is FRESH — `scripts/setup-test-db.sh` marks pre-existing databases on every
 * run. So the fake Stripe driver needs a second, narrower fact: that this
 * database was CREATED for fake runs. `createStripeFakeDatabase.ts` is the only
 * writer, and it refuses an existing database name, so the setting can never be
 * stamped onto a database that already has history.
 *
 * The two settings partition databases between the Stripe drivers: the fake
 * runs only where both are set, and the real driver with credentials only where
 * neither is (`artifacts/api-server/src/lib/stripeDatabasePartition.ts`).
 */
export const STRIPE_FAKE_DATABASE_SETTING = "overhype.stripe_fake_database";

/** The SQL `createStripeFakeDatabase.ts` — and only it — runs to mark a database it has just created. */
export const markStripeFakeDatabaseSql = (quotedDatabaseName: string): string =>
  `ALTER DATABASE ${quotedDatabaseName} SET ${STRIPE_FAKE_DATABASE_SETTING} = '${TEST_DATABASE_VALUE}'`;

export interface DatabasePartitionSettings {
  database: string;
  testMarked: boolean;
  fakeOwned: boolean;
}

/** Both partition settings for the connected database, from the catalog, in one query. */
export const DATABASE_PARTITION_SETTINGS_SQL =
  `SELECT current_database() AS database, ${settingStoredSql(1)} AS "testMarked", ${settingStoredSql(2)} AS "fakeOwned"`;

export const DATABASE_PARTITION_SETTINGS_PARAMS = [
  `${TEST_DATABASE_SETTING}=${TEST_DATABASE_VALUE}`,
  `${STRIPE_FAKE_DATABASE_SETTING}=${TEST_DATABASE_VALUE}`,
] as const;
