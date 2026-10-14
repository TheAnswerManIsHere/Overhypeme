/**
 * The acceptance runner (Launch Phase 2, increment 6, #631; plan
 * `docs/plans/PLAN_PHASE2_INC6_ACCEPTANCE.md`).
 *
 *   --mode probe   The detector's feasibility check (plan step 1): build the
 *                  namespace, run the self-test, reach the database through
 *                  the relay and a local HTTP server, and judge both
 *                  observers. DATABASE_URL must be a marked test database.
 *                  `--control forbidden-request` adds one vendor request whose
 *                  error is caught; the run must then be red.
 *
 * Exit codes: 0 green; 1 red (a journey, the self-test, or an outbound
 * attempt); 2 usage or refusal; 90 environment failure (the boundary could
 * not be built here).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabaseRefusal } from "@workspace/db/test-database";

import { evaluateDetector, launchInNamespace, namespaceRoute } from "../src/testing/acceptance/detector";
import type { InnerConfig } from "../src/testing/acceptance/inner";
import { startPgRelay } from "../src/testing/acceptance/pgRelay";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const mode = arg("mode");
if (mode !== "probe") {
  console.error("usage: acceptance-run.ts --mode probe");
  process.exit(2);
}
const refusal = await testDatabaseRefusal(process.env);
if (refusal) {
  console.error(`[acceptance] refusing: ${refusal}`);
  process.exit(2);
}

const route = namespaceRoute();
if (route.kind === "unavailable") {
  console.error(`[acceptance] environment failure: no network namespace can be created here (${route.reason})`);
  process.exit(90);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
fs.chmodSync(work, 0o755);
const dbUrl = new URL(process.env.DATABASE_URL!);
const control = arg("control");
if (control !== undefined && control !== "forbidden-request") {
  console.error(`[acceptance] unknown control: ${control}`);
  process.exit(2);
}
// "localhost" may resolve to ::1 first; the relay targets the IPv4 loopback the database listens on.
const dbHost = !dbUrl.hostname || dbUrl.hostname === "localhost" ? "127.0.0.1" : dbUrl.hostname;
const relay = await startPgRelay(path.join(work, "pg"), { host: dbHost, port: Number(dbUrl.port || 5432) });
const cfg: InnerConfig = { job: "probe", work, databaseUrl: relay.url(dbUrl.href), selfTest: true, ...(control ? { control } : {}) };
fs.writeFileSync(path.join(work, "inner-config.json"), JSON.stringify(cfg));

const child = launchInNamespace(route, work, API_ROOT, ["--import", "tsx/esm", "src/testing/acceptance/inner.ts", path.join(work, "inner-config.json")]);
child.stdout!.pipe(process.stdout);
child.stderr!.pipe(process.stderr);
const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
await relay.close();

const verdict = evaluateDetector(work);
let inner: Record<string, unknown> = {};
try { inner = JSON.parse(fs.readFileSync(path.join(work, "inner-result.json"), "utf8")); } catch {}
const report = { mode, control: control ?? null, route: route.kind, wrapperExit: code, inner, detector: verdict };
console.log(JSON.stringify(report, null, 2));
fs.rmSync(work, { recursive: true, force: true });
if (code === 90 || (verdict.netns && !verdict.netns.ok)) process.exit(90);
process.exit(verdict.ok && inner.ok === true ? 0 : 1);
