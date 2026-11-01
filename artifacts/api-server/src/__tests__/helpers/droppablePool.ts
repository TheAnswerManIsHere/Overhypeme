/**
 * @purpose A pg pool for a database a test will drop or force-disconnect (#808): it listens for its connections' errors, because `Pool.end()` resolves before its connections finish closing, and a `DROP DATABASE … WITH (FORCE)` that reaches the server first makes the closing connection emit an error the pool re-emits. With no listener that error is uncaught, and every test file in a shard shares one process (`--test-isolation=none`), so it fails the whole shard after every test passed.
 * @subsystem tooling
 */
import pg from "pg";

/** A pool whose connections may be killed under it without crashing the test process. */
export function droppablePool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 1 });
  // A query on a killed connection still fails loudly: this only stops an
  // error on an IDLE connection, which nothing is waiting on, from being
  // thrown at the process.
  pool.on("error", () => {});
  return pool;
}
