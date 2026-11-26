/**
 * The application's database login (Launch Phase 15, 5b; ./connection.ts): each refusal
 * and each fallback, and the scrub of the owner's credential. Pure: no database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AppDatabaseUrlRefusal, resolveAppDatabaseUrl, scrubOwnerCredential } from "./connection.js";

const OWNER = "postgresql://neondb_owner:ownerpw@ep-example.neon.tech:5432/neondb?sslmode=require";
const APP = "postgresql://overhype_app:apppw@ep-example.neon.tech/neondb?sslmode=require";

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    resolveAppDatabaseUrl(env);
  } catch (err) {
    assert.ok(err instanceof AppDatabaseUrlRefusal);
    return (err as Error).message;
  }
  assert.fail("expected a refusal");
}

describe("resolveAppDatabaseUrl", () => {
  it("development without APP_DATABASE_URL uses DATABASE_URL, as before", () => {
    assert.deepEqual(resolveAppDatabaseUrl({ DATABASE_URL: OWNER }), { url: OWNER, source: "DATABASE_URL" });
  });

  it("development passes DATABASE_URL through as given, the unix-socket form included (the acceptance run's relay)", () => {
    const socket = "postgres://overhype:pw@/overhype_acceptance_fixture_1?host=%2Ftmp%2Frelay&port=5432";
    assert.deepEqual(resolveAppDatabaseUrl({ DATABASE_URL: socket }), { url: socket, source: "DATABASE_URL" });
  });

  it("the socket form compares by socket directory, port and database", () => {
    const owner = "postgres://owner:pw@/db?host=%2Ftmp%2Frelay&port=5432";
    const app = "postgres://app:pw2@/db?host=%2Ftmp%2Frelay&port=5432";
    assert.equal(resolveAppDatabaseUrl({ DATABASE_URL: owner, APP_DATABASE_URL: app }).source, "APP_DATABASE_URL");
    assert.match(
      refusal({ DATABASE_URL: owner, APP_DATABASE_URL: app.replace("%2Ftmp%2Frelay", "%2Ftmp%2Fother") }),
      /names a different database/,
    );
  });

  it("a published deployment without APP_DATABASE_URL refuses to start", () => {
    assert.match(refusal({ DATABASE_URL: OWNER, REPLIT_DEPLOYMENT: "1" }), /must connect through APP_DATABASE_URL/);
  });

  it("NODE_ENV=production alone is not a deployment (the local production-mode launcher sets it)", () => {
    assert.equal(resolveAppDatabaseUrl({ DATABASE_URL: OWNER, NODE_ENV: "production" }).source, "DATABASE_URL");
  });

  it("a deployment with APP_DATABASE_URL on the same database connects as the app", () => {
    assert.deepEqual(resolveAppDatabaseUrl({ DATABASE_URL: OWNER, APP_DATABASE_URL: APP, REPLIT_DEPLOYMENT: "1" }), {
      url: APP,
      source: "APP_DATABASE_URL",
    });
  });

  it("APP_DATABASE_URL naming another host, port or database is refused everywhere", () => {
    for (const other of [
      APP.replace("ep-example.neon.tech", "ep-other.neon.tech"),
      APP.replace("neon.tech/", "neon.tech:6543/"),
      APP.replace("/neondb", "/otherdb"),
    ]) {
      for (const deployment of [{}, { REPLIT_DEPLOYMENT: "1" }]) {
        const message = refusal({ DATABASE_URL: OWNER, APP_DATABASE_URL: other, ...deployment });
        assert.match(message, /names a different database/);
        assert.doesNotMatch(message, /apppw|ownerpw/, "a refusal never echoes a password");
      }
    }
  });

  it("a deployment whose APP_DATABASE_URL is the owner's login is refused", () => {
    const sameUser = APP.replace("overhype_app:apppw", "neondb_owner:otherpw");
    assert.match(refusal({ DATABASE_URL: OWNER, APP_DATABASE_URL: sameUser, REPLIT_DEPLOYMENT: "1" }), /same login as DATABASE_URL/);
  });

  it("no DATABASE_URL at all is refused, and an unparseable value is refused without echoing it", () => {
    assert.match(refusal({}), /DATABASE_URL must be set/);
    const message = refusal({ DATABASE_URL: OWNER, APP_DATABASE_URL: "not a url secretpw" });
    assert.match(message, /APP_DATABASE_URL is not a valid connection URL/);
    assert.doesNotMatch(message, /secretpw/);
  });
});

describe("scrubOwnerCredential", () => {
  it("removes DATABASE_URL and libpq's connection variables, and nothing else", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: OWNER,
      PGHOST: "h",
      PGPORT: "5432",
      PGUSER: "neondb_owner",
      PGPASSWORD: "ownerpw",
      PGDATABASE: "neondb",
      APP_DATABASE_URL: APP,
      PGOPTIONS: "-c x=y",
      OTHER: "kept",
    };
    const removed = scrubOwnerCredential(env);
    assert.deepEqual(removed.sort(), ["DATABASE_URL", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER"]);
    assert.deepEqual(env, { APP_DATABASE_URL: APP, PGOPTIONS: "-c x=y", OTHER: "kept" });
  });
});
