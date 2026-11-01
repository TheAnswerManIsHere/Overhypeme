/**
 * A dropped connection must not crash the process (#826). pg-pool removes its
 * idle error listener from a client while it is checked out, so without a
 * listener of our own, the server ending a held client's connection is an
 * uncaught `error` event: the production crash of 2026-10-31.
 *
 * @purpose Proves pg-pool leaves a checked-out client with no error listener, that guardPool gives every connected client one for its whole life, that a held client and a standalone guarded client whose backends the server terminates raise no uncaught exception, and that the guarded pool keeps serving queries afterwards.
 * @subsystem data
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { guardPool, guardClient } from "./connectionErrors.js";

let control: pg.Pool;
let uncaught: unknown[] = [];
const onUncaught = (err: unknown) => { uncaught.push(err); };

async function terminate(pid: number): Promise<void> {
  await control.query("SELECT pg_terminate_backend($1)", [pid]);
}

/** Give the terminated socket's close a few ticks to surface as an event. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("guardPool / guardClient (#826)", () => {
  before(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at the test database");
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    process.on("uncaughtException", onUncaught);
  });
  after(async () => {
    process.removeListener("uncaughtException", onUncaught);
    await control.end();
  });

  it("an unguarded pool hands out a client with no error listener (the pg-pool behaviour this fixes)", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      assert.equal(client.listenerCount("error"), 0);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("a held client whose connection the server ends raises no uncaught exception, and the pool recovers", async () => {
    uncaught = [];
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    guardPool(pool, "test pool");
    const client = await pool.connect();
    assert.ok(client.listenerCount("error") >= 1, "a checked-out client keeps a listener");
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    await terminate(rows[0]!.pid);
    await settle();

    assert.deepEqual(uncaught, []);
    await assert.rejects(client.query("SELECT 1"));
    client.release(true);
    const again = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    assert.equal(again.rows[0]!.ok, 1);
    await pool.end();
  });

  it("an idle client whose connection the server ends raises no uncaught exception", async () => {
    uncaught = [];
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    guardPool(pool, "test pool");
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    client.release();

    await terminate(rows[0]!.pid);
    await settle();

    assert.deepEqual(uncaught, []);
    await pool.end();
  });

  it("a guarded standalone client whose connection the server ends raises no uncaught exception", async () => {
    uncaught = [];
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    guardClient(client, "test client");
    await client.connect();
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    await terminate(rows[0]!.pid);
    await settle();

    assert.deepEqual(uncaught, []);
    await client.end().catch(() => {});
  });
});
