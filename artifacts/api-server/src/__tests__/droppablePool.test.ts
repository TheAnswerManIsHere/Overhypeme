/**
 * @purpose Proves a test pool survives the server killing one of its idle connections, the path a force-dropped database takes (#808): a pool without an error listener throws that at the shared shard process and fails the whole shard after every test passed.
 * @subsystem tooling
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { droppablePool } from "./helpers/droppablePool.js";

const killer = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
after(() => killer.end());

describe("a droppable pool (#808)", () => {
  it("survives its idle connection being terminated, and serves the next query on a new one", async () => {
    const pool = droppablePool(process.env.DATABASE_URL!);
    try {
      const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]!.pid;
      // The connection is idle in the pool now; kill it the way DROP DATABASE … WITH (FORCE) does.
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 300));
      const { rows: again } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      assert.notEqual(again[0]!.pid, pid, "a fresh connection serves the next query");
    } finally {
      await pool.end();
    }
  });
});
