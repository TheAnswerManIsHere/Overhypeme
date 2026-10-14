/**
 * The database relay (Launch Phase 2, increment 6, #631; plan D4).
 *
 * The acceptance run's network namespace has only its own loopback, so the
 * database a TCP URL names is unreachable from inside it. A unix socket is a
 * filesystem object and crosses that boundary, so the runner starts this relay
 * in the host namespace: it listens on `<dir>/.s.PGSQL.<port>` and forwards
 * each connection to the TCP address of the database. Inside, the
 * connection string names the socket directory (`?host=<dir>`), which
 * node-postgres and psql both read as a socket path.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface Relay {
  /** A connection string for the same database, through the relay's socket. */
  url(databaseUrl: string): string;
  close(): Promise<void>;
}

export async function startPgRelay(dir: string, target: { host: string; port: number }): Promise<Relay> {
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, `.s.PGSQL.${target.port}`);
  fs.rmSync(socketPath, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client).add(upstream);
    const done = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", done).on("close", done);
    upstream.on("error", done).on("close", done);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, () => resolve()));
  fs.chmodSync(socketPath, 0o777);
  return {
    url(databaseUrl: string) {
      const u = new URL(databaseUrl);
      const db = u.pathname.replace(/^\//, "");
      const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
      return `postgres://${auth}/${db}?host=${encodeURIComponent(dir)}&port=${target.port}`;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
