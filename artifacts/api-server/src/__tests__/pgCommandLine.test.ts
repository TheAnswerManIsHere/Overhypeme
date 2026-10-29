/**
 * Postgres command lines carry no password (Launch Phase 3, increment 5): the
 * URL's password moves to PGPASSWORD, and a message that might still quote it
 * is scrubbed of every encoding of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pgCommandConnection, withoutPassword } from "../lib/pgCommandLine.js";

describe("pgCommandConnection", () => {
  it("moves the password out of the URL and into PGPASSWORD", () => {
    const { url, env } = pgCommandConnection("postgres://app:s3cr%40t@db.example:5432/prod?sslmode=require", { PATH: "/bin" });
    assert.equal(url, "postgres://app@db.example:5432/prod?sslmode=require");
    assert.equal(env.PGPASSWORD, "s3cr@t");
    assert.equal(env.PATH, "/bin");
  });

  it("sets nothing when the URL has no password", () => {
    const { url, env } = pgCommandConnection("postgres://app@localhost/db", {});
    assert.equal(url, "postgres://app@localhost/db");
    assert.equal(env.PGPASSWORD, undefined);
  });
});

describe("withoutPassword", () => {
  it("removes the raw and the encoded password from a message", () => {
    const url = "postgres://app:s3cr%40t@db/x";
    assert.equal(withoutPassword("failed: postgres://app:s3cr%40t@db/x and s3cr@t", url), "failed: postgres://app:***@db/x and ***");
  });

  it("leaves a message alone when there is no password or no URL", () => {
    assert.equal(withoutPassword("plain", "postgres://app@db/x"), "plain");
    assert.equal(withoutPassword("plain", ""), "plain");
  });
});
