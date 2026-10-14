/**
 * The part of an acceptance run that executes inside the namespace (Launch
 * Phase 2, increment 6, #631; plan D1, D4). The host-side runner writes a
 * config file and starts this under the namespace wrapper; it never inherits
 * the runner's environment.
 *
 *   node --import tsx/esm src/testing/acceptance/inner.ts <config.json>
 *
 * Every job starts with the detector's self-test when the config asks for it,
 * so whatever the observers record afterwards belongs to the job.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import pg from "pg";

import { runSelfTest } from "./selfTest";

export interface InnerConfig {
  job: "probe";
  work: string;
  /** Through the relay's socket: the namespace has no route to a TCP database. */
  databaseUrl: string;
  selfTest: boolean;
  /** `forbidden-request`: after the self-test, make one vendor request and catch its error, as application code would. */
  control?: "forbidden-request";
}

async function probe(cfg: InnerConfig): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const { rows } = await client.query<{ db: string }>("SELECT current_database() AS db");
  await client.end();
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  server.close();
  return { database: rows[0]?.db ?? null, localHttp: body };
}

const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as InnerConfig;
const result: Record<string, unknown> = {};
try {
  if (cfg.selfTest) await runSelfTest(path.join(cfg.work, "selftest.json"));
  if (cfg.control === "forbidden-request") {
    result.control = await fetch("https://api.openai.com/v1/models", { signal: AbortSignal.timeout(4000) }).then(
      (r) => `status ${r.status}`,
      (e) => `caught ${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}`,
    );
  }
  if (cfg.job === "probe") Object.assign(result, await probe(cfg));
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = (err as Error).stack ?? String(err);
}
fs.writeFileSync(path.join(cfg.work, "inner-result.json"), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
