/**
 * The fake-Stripe database partition (#566, plan decision 12), against a real
 * Postgres: the provisioner that is the only writer of the fake-ownership
 * setting, and the catalog query the API server reads both settings with.
 *
 * Each case uses scratch databases created through the maintenance database, so
 * nothing depends on how the database the suite started against was set up.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import pg from "pg";

import { createStripeFakeDatabase } from "./createStripeFakeDatabase";
import {
  DATABASE_PARTITION_SETTINGS_PARAMS,
  DATABASE_PARTITION_SETTINGS_SQL,
  markStripeFakeDatabaseSql,
  markTestDatabaseSql,
  withDatabase,
  type DatabasePartitionSettings,
} from "./testDatabaseMarker";

const SOURCE = `stripe_fake_src_${process.pid}`;
const UNMARKED = `stripe_fake_unmarked_${process.pid}`;
const TARGET = `stripe_fake_tgt_${process.pid}`;
const STAMPED = `stripe_fake_stamped_${process.pid}`;

const urlFor = (database: string): string => withDatabase(process.env.DATABASE_URL!, database);

async function settingsOf(database: string): Promise<DatabasePartitionSettings> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    const { rows } = await client.query<DatabasePartitionSettings>(DATABASE_PARTITION_SETTINGS_SQL, [
      ...DATABASE_PARTITION_SETTINGS_PARAMS,
    ]);
    return rows[0]!;
  } finally {
    await client.end();
  }
}

describe("fake-Stripe database partition", () => {
  let control: pg.Client;

  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point at a Postgres this suite may create databases on");
    control = new pg.Client({ connectionString: urlFor("postgres") });
    await control.connect();
    for (const db of [SOURCE, UNMARKED, TARGET, STAMPED]) await control.query(`DROP DATABASE IF EXISTS ${db}`);
    await control.query(`CREATE DATABASE ${SOURCE}`);
    await control.query(markTestDatabaseSql(SOURCE));
    await control.query(`CREATE DATABASE ${UNMARKED}`);
    await control.query(`CREATE DATABASE ${STAMPED}`);
    await control.query(markTestDatabaseSql(STAMPED));
    await control.query(markStripeFakeDatabaseSql(STAMPED));
    // The source carries a Stripe mirror, as a test database a real driver once
    // touched would. The copy must not inherit it.
    const source = new pg.Client({ connectionString: urlFor(SOURCE) });
    await source.connect();
    await source.query("CREATE SCHEMA stripe; CREATE TABLE stripe.products (id text primary key); INSERT INTO stripe.products VALUES ('prod_real')");
    await source.end();
  });

  after(async () => {
    for (const db of [SOURCE, UNMARKED, TARGET, STAMPED]) await control.query(`DROP DATABASE IF EXISTS ${db}`);
    await control.end();
  });

  it("reads each combination of settings from the catalog", async () => {
    assert.deepEqual(await settingsOf(UNMARKED), { database: UNMARKED, testMarked: false, fakeOwned: false });
    assert.deepEqual(await settingsOf(SOURCE), { database: SOURCE, testMarked: true, fakeOwned: false });
    assert.deepEqual(await settingsOf(STAMPED), { database: STAMPED, testMarked: true, fakeOwned: true });
  });

  it("creates a fake database: both settings set, and no Stripe mirror carried over from the source", async () => {
    await createStripeFakeDatabase({ DATABASE_URL: urlFor(SOURCE) }, TARGET);
    assert.deepEqual(await settingsOf(TARGET), { database: TARGET, testMarked: true, fakeOwned: true });
    const copy = new pg.Client({ connectionString: urlFor(TARGET) });
    await copy.connect();
    const { rows } = await copy.query("SELECT 1 FROM pg_namespace WHERE nspname = 'stripe'");
    await copy.end();
    assert.equal(rows.length, 0, "the copy's stripe schema must be gone");
  });

  it("refuses an existing target — it never converts a database", async () => {
    await assert.rejects(createStripeFakeDatabase({ DATABASE_URL: urlFor(SOURCE) }, UNMARKED), /already exists/);
    assert.equal((await settingsOf(UNMARKED)).fakeOwned, false, "the existing database must be left untouched");
  });

  it("refuses an unmarked source", async () => {
    await assert.rejects(
      createStripeFakeDatabase({ DATABASE_URL: urlFor(UNMARKED) }, `${TARGET}_x`),
      /source must be a marked test database/,
    );
  });

  it("refuses a real deployment and a name that is not a plain identifier", async () => {
    await assert.rejects(
      createStripeFakeDatabase({ DATABASE_URL: urlFor(SOURCE), REPLIT_DEPLOYMENT: "1" }, `${TARGET}_y`),
      /real deployment/,
    );
    await assert.rejects(createStripeFakeDatabase({ DATABASE_URL: urlFor(SOURCE) }, "x; DROP DATABASE y"), /plain lowercase identifier/);
  });
});
