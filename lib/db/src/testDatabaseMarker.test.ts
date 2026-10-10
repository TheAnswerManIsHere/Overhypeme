/**
 * The test-database marker (testDatabaseMarker.ts), against a real Postgres.
 *
 * Each case creates its own scratch database through the maintenance database,
 * so it never depends on how the database it was started against was set up.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  TEST_DATABASE_SETTING,
  TEST_DATABASE_VALUE,
  markTestDatabaseSql,
  readTestDatabaseMarker,
  testDatabaseRefusal,
} from "./testDatabaseMarker";

const SCRATCH = `marker_probe_${process.pid}`;

function urlFor(database: string, query = ""): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = query;
  return url.toString();
}

describe("test-database marker", () => {
  let control: pg.Client;

  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point at a Postgres this suite may create databases on");
    control = new pg.Client({ connectionString: urlFor("postgres") });
    await control.connect();
    await control.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await control.query(`CREATE DATABASE ${SCRATCH}`);
  });

  after(async () => {
    await control.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await control.end();
  });

  it("refuses an unmarked database, naming it", async () => {
    assert.deepEqual(await readTestDatabaseMarker(urlFor(SCRATCH)), { database: SCRATCH, marked: false });
    assert.match((await testDatabaseRefusal({ DATABASE_URL: urlFor(SCRATCH) }))!, new RegExp(`'${SCRATCH}' is not marked`));
  });

  it("is not fooled by a connection string that sets the same name for its session", async () => {
    const spoof = urlFor(SCRATCH, `?options=${encodeURIComponent(`-c ${TEST_DATABASE_SETTING}=${TEST_DATABASE_VALUE}`)}`);
    const session = new pg.Client({ connectionString: spoof });
    await session.connect();
    const { rows } = await session.query("SELECT current_setting($1, true) AS v", [TEST_DATABASE_SETTING]);
    await session.end();
    assert.equal(rows[0].v, TEST_DATABASE_VALUE, "precondition: the session really does carry the setting");
    assert.equal((await readTestDatabaseMarker(spoof)).marked, false);
  });

  it("accepts the database once its creator marks it", async () => {
    await control.query(markTestDatabaseSql(SCRATCH));
    assert.deepEqual(await readTestDatabaseMarker(urlFor(SCRATCH)), { database: SCRATCH, marked: true });
    assert.equal(await testDatabaseRefusal({ DATABASE_URL: urlFor(SCRATCH) }), null);
  });

  it("refuses a real deployment whatever its database says", async () => {
    assert.match((await testDatabaseRefusal({ DATABASE_URL: urlFor(SCRATCH), REPLIT_DEPLOYMENT: "1" }))!, /deployment/);
  });

  it("refuses when the database cannot be read, rather than proceeding", async () => {
    assert.match((await testDatabaseRefusal({}))!, /DATABASE_URL is not set/);
    assert.match((await testDatabaseRefusal({ DATABASE_URL: urlFor(`${SCRATCH}_missing`) }))!, /could not read/);
  });

  it("is written with this exact setting by every creator of a test database", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const expected = `SET ${TEST_DATABASE_SETTING} = '${TEST_DATABASE_VALUE}'`;
    for (const file of ["scripts/setup-test-db.sh", ".github/workflows/build.yml"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const writes = text.match(/ALTER DATABASE [^\n]*?SET [a-z_.]+ = '[^']*'/g) ?? [];
      assert.ok(writes.length > 0, `${file} marks the test databases it creates`);
      for (const write of writes) assert.ok(write.includes(expected), `${file}: ${write}`);
    }
  });
});
