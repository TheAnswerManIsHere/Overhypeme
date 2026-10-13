/**
 * Create a database for fake-Stripe runs (#566, plan decision 12).
 *
 *   DATABASE_URL=<a marked test database> tsx src/createStripeFakeDatabase.ts <new-name>
 *
 * The ONLY writer of `overhype.stripe_fake_database`. What makes that setting
 * mean "created for the fake" rather than "someone said so" is that this script
 * only ever applies it to a database it has just created:
 *
 *   - it refuses an existing target name — it never converts a database;
 *   - the source must be a marked test database, so the copy starts from a
 *     disposable one (schema, migrations and seeded test accounts come with it);
 *   - the copy's `stripe` schema is dropped before the script returns, so the new
 *     database carries no Stripe mirror rows from anywhere. The fake's boot
 *     recreates the schema with `runMigrations` and fills it from the fixture.
 *
 * `CREATE DATABASE ... TEMPLATE` does not copy database-level settings, so both
 * the test marker and the fake setting are written explicitly on the copy.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  STRIPE_FAKE_DATABASE_SETTING,
  TEST_DATABASE_SETTING,
  TEST_DATABASE_VALUE,
  testDatabaseRefusal,
} from "./testDatabaseMarker";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createStripeFakeDatabase(env: NodeJS.ProcessEnv, target: string): Promise<void> {
  if (!NAME.test(target)) throw new Error(`target name ${JSON.stringify(target)} is not a plain lowercase identifier`);
  const refusal = await testDatabaseRefusal(env);
  if (refusal) throw new Error(`the source must be a marked test database: ${refusal}`);

  const sourceUrl = env.DATABASE_URL!;
  const source = new URL(sourceUrl).pathname.replace(/^\//, "");
  if (source === target) throw new Error("the target must be a new database, not the source");

  // TEMPLATE needs the source to have no other sessions, so the CREATE runs from
  // the server's maintenance database rather than from a connection to the source.
  const admin = new pg.Client({ connectionString: withDatabase(sourceUrl, "postgres") });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [target]);
    if (rows.length > 0) {
      throw new Error(
        `database '${target}' already exists. This script only creates; it never converts an existing ` +
          `database, because that is what would let a database with real-Stripe history carry the fake setting.`,
      );
    }
    await admin.query(`CREATE DATABASE "${target}" TEMPLATE "${source}"`);
    await admin.query(`ALTER DATABASE "${target}" SET ${TEST_DATABASE_SETTING} = '${TEST_DATABASE_VALUE}'`);
    await admin.query(`ALTER DATABASE "${target}" SET ${STRIPE_FAKE_DATABASE_SETTING} = '${TEST_DATABASE_VALUE}'`);
  } finally {
    await admin.end();
  }

  const copy = new pg.Client({ connectionString: withDatabase(sourceUrl, target) });
  await copy.connect();
  try {
    await copy.query("DROP SCHEMA IF EXISTS stripe CASCADE");
  } finally {
    await copy.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("usage: DATABASE_URL=<marked test db> tsx src/createStripeFakeDatabase.ts <new-name>\n");
    process.exit(2);
  }
  try {
    await createStripeFakeDatabase(process.env, target);
    process.stdout.write(`[stripe-fake-db] created '${target}' for fake-Stripe runs\n`);
  } catch (err) {
    process.stderr.write(`[stripe-fake-db] refusing: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
