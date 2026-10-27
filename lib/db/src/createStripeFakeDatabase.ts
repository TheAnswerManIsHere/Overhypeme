/**
 * Create an EMPTY database for fake-Stripe runs (#566, plan decision 12).
 *
 *   DATABASE_URL=<a marked test database> tsx src/createStripeFakeDatabase.ts <new-name>
 *
 * then fill it with the repo's own tooling, with DATABASE_URL pointed at it:
 *
 *   pnpm --filter @workspace/db run migrate      (builds it from the schema baseline)
 *   pnpm --filter @workspace/api-server exec tsx scripts/seed-dev-admin.ts
 *   pnpm --filter @workspace/api-server exec tsx scripts/seed-e2e-test-accounts.ts
 *
 * The ONLY writer of `overhype.stripe_fake_database`. What makes that setting
 * mean "created for the fake, with no real-Stripe history" is that this script
 * only ever applies it to a database it has just created, empty:
 *
 *   - it refuses an existing target name — it never converts a database;
 *   - nothing is copied: the database is created from `template0`, so it carries
 *     no settings, no Stripe mirror and no application payment state from
 *     anywhere. (It used to copy a test database and clean out the `stripe`
 *     schema, which left everything outside that schema behind — Codex, #671
 *     round 1.) The schema, migrations and accounts come from the fill above;
 *     the `stripe` schema is created at boot by the sync library, and
 *     `stripe_live_mode` is seeded `false` at boot by `ensureSchema()`;
 *   - `DATABASE_URL` must still name a marked test database: nothing is read
 *     from it, but it is the cheap proof that this server is a disposable
 *     cluster (production and the dev database are never marked).
 *
 * An interrupted run leaves at worst an empty, marked database; the next run's
 * "already exists" refusal names it, and dropping it starts over.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  markStripeFakeDatabaseSql,
  markTestDatabaseSql,
  testDatabaseRefusal,
  withDatabase,
} from "./testDatabaseMarker";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export async function createStripeFakeDatabase(env: NodeJS.ProcessEnv, target: string): Promise<void> {
  if (!NAME.test(target)) throw new Error(`target name ${JSON.stringify(target)} is not a plain lowercase identifier`);
  const refusal = await testDatabaseRefusal(env);
  if (refusal) {
    throw new Error(`DATABASE_URL must name a marked test database, the proof this is a disposable server: ${refusal}`);
  }

  const serverUrl = env.DATABASE_URL!;
  const admin = new pg.Client({ connectionString: withDatabase(serverUrl, "postgres") });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [target]);
    if (rows.length > 0) {
      throw new Error(
        `database '${target}' already exists. This script only creates; it never converts an existing ` +
          `database, because that is what would let a database with real-Stripe history carry the fake setting.`,
      );
    }
    await admin.query(`CREATE DATABASE "${target}" TEMPLATE template0`);
    await admin.query(markTestDatabaseSql(`"${target}"`));
    await admin.query(markStripeFakeDatabaseSql(`"${target}"`));
  } finally {
    await admin.end();
  }

  // pgvector, as every database needs (the baseline also creates it).
  const fresh = new pg.Client({ connectionString: withDatabase(serverUrl, target) });
  await fresh.connect();
  try {
    await fresh.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await fresh.end();
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
    process.stdout.write(
      `[stripe-fake-db] created '${target}', empty, for fake-Stripe runs. Fill it with DATABASE_URL pointed at it: ` +
        `migrate (which builds it from the schema baseline), then the account seeds (docs/tests/TESTING.md, "The Stripe fake").\n`,
    );
  } catch (err) {
    process.stderr.write(`[stripe-fake-db] refusing: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
