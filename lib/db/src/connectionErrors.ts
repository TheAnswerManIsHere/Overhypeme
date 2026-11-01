/**
 * Keeping a dropped database connection from crashing the process.
 *
 * A pg client whose connection the server drops emits an `error` event. With
 * no listener, Node turns that event into an uncaught exception and the
 * process exits. A pool's own `error` event covers only IDLE clients:
 * pg-pool removes that listener when it hands a client out
 * (`pg-pool/index.js`, `_acquireClient`: `client.removeListener('error',
 * idleListener)`). So a client held between queries — an advisory-lock
 * holder, a migration, a transaction — has no listener at all, and a
 * standalone `pg.Client` never had one (#826).
 *
 * The listeners here only log. The pool still discards a broken client on
 * release, and the next query on it rejects, so callers see the failure as an
 * ordinary query error rather than a dead process.
 *
 * @purpose Attaches permanent error listeners to a pool, to every client it ever connects, and to standalone clients, so a connection the database drops is logged instead of becoming an uncaught exception that ends the server.
 * @subsystem data
 */
import type pg from "pg";

function log(label: string, err: Error): void {
  console.error(`[db] ${label}: connection error (the connection is discarded): ${err.message}`);
}

/**
 * Guard a pool: its idle-client errors, and every client it connects, for that
 * client's whole life — checked out or idle.
 */
export function guardPool(pool: Pick<pg.Pool, "on">, label: string): void {
  pool.on("error", (err: Error) => log(`${label} (idle client)`, err));
  pool.on("connect", (client: pg.PoolClient) => {
    client.on("error", (err: Error) => log(`${label} (client)`, err));
  });
}

/** Guard a standalone client, created with `new pg.Client(...)`. */
export function guardClient(client: Pick<pg.Client, "on">, label: string): void {
  client.on("error", (err: Error) => log(label, err));
}
