/**
 * Record — or replay — the AI baseline (Launch Phase 2, increment 4, #631;
 * design `docs/plans/PLAN_PHASE2_INC4_AI_DOUBLES.md` D6/D7).
 *
 *   --mode record   On the Repl only, never in CI. Boots the server through
 *                   `src/testing/aiRecorderLauncher.ts` with AI_BACKEND=recorder
 *                   and drives the baseline (`scripts/drive-ai-baseline.ts`);
 *                   every AI request/response pair lands in --out. Needs
 *                   FAL_AI_API_KEY (or FAL_KEY), OPENAI_API_KEY and
 *                   --allowance <usd>, the spending ceiling David approved.
 *                   --out must be empty: a new recording reaches the current
 *                   clients for every request. --resume tops up an existing
 *                   directory instead, paying only for requests it does not
 *                   hold, and reports how many it answered from disk. Any
 *                   call the recorder refused fails the run.
 *   --mode replay   Anywhere, with no credential. Boots the server with
 *                   AI_BACKEND=recorded-double over the committed recordings
 *                   and drives the same baseline: the proof that the
 *                   recordings carry the real consumers through. Any baseline
 *                   call with no recording fails the run, even one the
 *                   application tolerates and falls back from (#654 round 2).
 *
 * Both modes run in a FRESH database created for the run on the server
 * DATABASE_URL points at (marked as a test database, schema pushed, migrated,
 * accounts seeded) and dropped afterwards, so the two runs start from the
 * same state and their requests match. DATABASE_URL must itself be a marked
 * test database: it is only used to reach that server.
 *
 * The server gets an explicitly constructed environment — nothing inherited
 * beyond PATH and HOME — so no credential outside the AI baseline can reach
 * it, objects go to a temporary local storage directory, and it listens on
 * its own port. It is stopped on success and on failure.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/record-ai-baseline.ts --mode replay
 *   pnpm --filter @workspace/api-server exec tsx scripts/record-ai-baseline.ts --mode record \
 *     --allowance 5 --out /tmp/ai-recordings/recordings [--resume]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { markTestDatabaseSql, testDatabaseRefusal } from "@workspace/db/test-database";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const mode = arg("mode");
if (mode !== "record" && mode !== "replay") {
  console.error("usage: record-ai-baseline.ts --mode record|replay [--allowance <usd> --out <dir> [--resume]] [--keep-db]");
  process.exit(2);
}

// --- refusals, before anything is created ----------------------------------
const refusals: string[] = [];
if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production") refusals.push("never in a production environment");
if (process.env.CI) refusals.push(mode === "record" ? "the recording run never runs in CI" : "");
const dbRefusal = await testDatabaseRefusal(process.env);
if (dbRefusal) refusals.push(dbRefusal);
const falKey = process.env.FAL_AI_API_KEY || process.env.FAL_KEY || "";
const openaiKey = process.env.OPENAI_API_KEY || "";
const out = path.resolve(arg("out") ?? path.join(API_ROOT, "src/lib/aiDouble/recordings"));
const allowance = arg("allowance") ?? "";
const resume = process.argv.includes("--resume");
const ledgerPath = path.join(out, "..", "ai-recorder-ledger.json");
if (mode === "record") {
  if (!falKey || !openaiKey) refusals.push("record mode needs FAL_AI_API_KEY (or FAL_KEY) and OPENAI_API_KEY");
  if (!(Number(allowance) > 0)) refusals.push("record mode needs --allowance <usd>, the approved spending ceiling");
  if (!arg("out")) refusals.push("record mode needs --out <dir>: recordings are reviewed and scrubbed before they are committed");
  const held = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith(".json")).length : 0;
  if (!resume && held > 0) refusals.push(`--out already holds ${held} recordings; a new recording starts empty, or pass --resume to top that directory up`);
  if (!resume && fs.existsSync(ledgerPath)) refusals.push(`a ledger from an earlier run is at ${ledgerPath}; remove it for a new recording, or pass --resume to continue that run`);
}
const real = refusals.filter(Boolean);
if (real.length > 0) {
  console.error(`[ai-baseline] refusing:\n${real.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(1);
}

// --- a fresh database for the run -------------------------------------------
const source = new URL(process.env.DATABASE_URL!);
const runDb = `overhype_ai_baseline_${Date.now()}`;
const control = new URL(source.href);
control.pathname = "/postgres";
const runUrl = new URL(source.href);
runUrl.pathname = `/${runDb}`;

function psql(url: URL, sql: string): void {
  execFileSync("psql", [url.href, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: ["ignore", "inherit", "inherit"] });
}
function pnpm(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("pnpm", args, { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ai-baseline-"));
/** A free local port, chosen by the kernel. */
const port = await new Promise<number>((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(free));
  });
});
let server: ChildProcess | null = null;

function cleanUp(): void {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (!process.argv.includes("--keep-db")) {
    try {
      psql(control, `DROP DATABASE IF EXISTS "${runDb}" WITH (FORCE)`);
    } catch {
      console.error(`[ai-baseline] could not drop ${runDb}; drop it by hand`);
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function waitForPort(p: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect(p, "127.0.0.1", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (open) return;
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`server exited with ${server.exitCode} before listening`);
    if (Date.now() > deadline) throw new Error(`server did not listen on ${p} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * One real error from each vendor, for the double's failure control (design
 * D5): a request the vendor rejects as invalid. Drawn from the same allowance
 * as the run, through the same recorder.
 */
async function recordVendorErrors(ledger: string, limit: string, fal: string, openai: string): Promise<string[]> {
  process.env.AI_RECORDINGS_DIR = out;
  const { fal: vendorFal } = await import("@fal-ai/client");
  const OpenAI = (await import("openai")).default;
  const { Allowance, recordingFal, recordingOpenAI, vendorRejectionCaptured, controlAlreadyCaptured } = await import("../src/lib/aiDouble/recorder");
  const { falSubscribeRequest } = await import("../src/lib/aiDouble/doubles");
  const { falUnitPrice } = await import("../src/lib/falClient");
  const shared = new Allowance(Number(limit), ledger);
  const ctx = { clients: { "@fal-ai/client": "see recordings", openai: "see recordings" } };
  const firstRecording = fs.readdirSync(out).find((f) => f.endsWith(".json"));
  if (firstRecording) ctx.clients = JSON.parse(fs.readFileSync(path.join(out, firstRecording), "utf8")).clients;
  vendorFal.config({ credentials: fal });
  const falRec = recordingFal(vendorFal as never, shared, ctx, falUnitPrice);
  const oaRec = recordingOpenAI(new OpenAI({ apiKey: openai, maxRetries: 0 }), shared, ctx);
  // Each probe names the status of the validation rejection it exists to capture (the
  // committed recordings hold fal's 422 and OpenAI's 400); any other failure is not it.
  const falInvalid = { input: { prompt: "" } };
  const openaiInvalid = { model: "gpt-5.4-mini", messages: [], max_completion_tokens: 16 };
  const probes: Array<{ vendor: string; kind: "fal.subscribe" | "openai.chat"; target: string; status: number; request: unknown; send: () => Promise<unknown> }> = [
    {
      vendor: "fal",
      kind: "fal.subscribe",
      target: "fal-ai/nano-banana-2",
      status: 422,
      request: falSubscribeRequest("fal-ai/nano-banana-2", falInvalid),
      send: () => falRec.subscribe("fal-ai/nano-banana-2", falInvalid),
    },
    { vendor: "OpenAI", kind: "openai.chat", target: "gpt-5.4-mini", status: 400, request: openaiInvalid, send: () => oaRec.chat.completions.create(openaiInvalid as never) },
  ];
  const missing: string[] = [];
  for (const probe of probes) {
    if (resume && controlAlreadyCaptured(probe.kind, probe.target, probe.request, probe.status)) {
      shared.noteReused();
      console.log(`[ai-baseline] ${probe.vendor} error already recorded (${probe.status}); reused, not sent again`);
      continue;
    }
    try {
      await probe.send();
      missing.push(`${probe.vendor} accepted the invalid request`);
    } catch (err) {
      if (vendorRejectionCaptured(probe.kind, probe.target, err, probe.status)) {
        console.log(`[ai-baseline] recorded ${probe.vendor} error: ${(err as Error).name} ${(err as { status?: number }).status}`);
      } else {
        missing.push(`${probe.vendor}: its ${probe.status} rejection was not recorded (${(err as Error).name}: ${(err as Error).message.slice(0, 160)})`);
      }
    }
  }
  return missing;
}

const missLog = path.join(scratch, "ai-double-misses.jsonl");
/** Ledger lines from an earlier attempt a `--resume` run continues; only this run's refusals count against it. */
const priorLedgerLines =
  mode === "record" && fs.existsSync(ledgerPath) ? (JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { lines: unknown[] }).lines.length : 0;

/**
 * The baseline calls no recording answered (replay) or the recorder refused
 * (record). The application treats several AI calls as best-effort and falls
 * back on any error, so a journey can pass over a missing call; this is what
 * makes that visible. fal's pricing warm-up is excluded: an unrecorded
 * catalogue price is a warning by design (sub-plan D2).
 */
function uncoveredCalls(): string[] {
  const rows: Array<{ kind: string; target: string; fingerprint?: string }> = [];
  if (mode === "replay" && fs.existsSync(missLog)) {
    rows.push(...fs.readFileSync(missLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  if (mode === "record" && fs.existsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { lines: Array<{ kind: string; target: string; outcome: string }> };
    rows.push(...ledger.lines.slice(priorLedgerLines).filter((l) => l.outcome === "refused"));
  }
  return rows
    .filter((r) => r.kind !== "fal.pricing")
    .map((r) => `${r.kind} ${r.target}${r.fingerprint ? ` (fingerprint ${r.fingerprint.slice(0, 12)})` : ""}`);
}

let exitCode = 0;
try {
  psql(control, `CREATE DATABASE "${runDb}"`);
  psql(control, markTestDatabaseSql(`"${runDb}"`));
  psql(runUrl, "CREATE EXTENSION IF NOT EXISTS vector");

  const toolEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: runUrl.href, NODE_ENV: "development" };
  pnpm(["--filter", "@workspace/db", "push-force"], toolEnv);
  pnpm(["--filter", "@workspace/db", "run", "migrate"], toolEnv);
  pnpm(["--filter", "@workspace/api-server", "exec", "tsx", "scripts/seed-e2e-test-accounts.ts"], { ...toolEnv, BCRYPT_SALT_ROUNDS: "4" });

  // The server's whole environment, constructed rather than inherited.
  const serverEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: runUrl.href,
    NODE_ENV: "development",
    PORT: String(port),
    ENABLE_DEV_ADMIN_LOGIN: "true",
    CRON_SECRET: "ai-baseline",
    STORAGE_BACKEND: "local-double",
    STORAGE_DOUBLE_DIR: path.join(scratch, "storage"),
    PRIVATE_OBJECT_DIR: "/ai-baseline-bucket/private",
    PUBLIC_OBJECT_SEARCH_PATHS: "/ai-baseline-bucket/public",
    AI_RECORDINGS_DIR: out,
  };
  let entry: string;
  if (mode === "record") {
    fs.mkdirSync(out, { recursive: true });
    Object.assign(serverEnv, {
      AI_BACKEND: "recorder",
      FAL_AI_API_KEY: falKey,
      OPENAI_API_KEY: openaiKey,
      AI_RECORDER_ALLOWANCE_USD: allowance,
      AI_RECORDER_LEDGER: ledgerPath,
    });
    entry = "src/testing/aiRecorderLauncher.ts";
  } else {
    serverEnv.AI_BACKEND = "recorded-double";
    serverEnv.AI_DOUBLE_MISS_LOG = missLog;
    if (process.env.AI_DOUBLE_FAIL) serverEnv.AI_DOUBLE_FAIL = process.env.AI_DOUBLE_FAIL;
    entry = "src/index.ts";
  }

  const logFile = path.join(scratch, "server.log");
  const logStream = fs.createWriteStream(logFile);
  server = spawn(process.execPath, ["--import", "tsx/esm", entry], { cwd: API_ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.pipe(logStream);
  server.stderr!.pipe(logStream);
  await waitForPort(port, 120_000);
  console.log(`[ai-baseline] ${mode}: server up on ${port} (AI_BACKEND=${serverEnv.AI_BACKEND}, database ${runDb})`);

  const { driveBaseline } = await import("./drive-ai-baseline");
  try {
    const evidence = await driveBaseline(`http://127.0.0.1:${port}`, (l) => console.log(`[baseline] ${l}`), {
      expectRenderFailure: process.env.AI_DOUBLE_FAIL === "fal.subscribe:fal-ai/nano-banana-2",
    });
    const uncovered = uncoveredCalls();
    console.log(JSON.stringify(evidence, null, 2));
    if (uncovered.length > 0) {
      exitCode = 1;
      const what = mode === "replay" ? "had no recording" : "were refused by the recorder";
      console.error(`[ai-baseline] ${mode}: incomplete: ${uncovered.length} baseline AI calls ${what}; the journeys got through only on the application's fallbacks:\n${uncovered.map((u) => `  - ${u}`).join("\n")}`);
    } else {
      console.log(
        "renderFailure" in evidence
          ? `[ai-baseline] ${mode}: the recorded vendor error reached the render job's failed state`
          : `[ai-baseline] ${mode}: every baseline journey passed`,
      );
    }
  } catch (err) {
    exitCode = 1;
    console.error(`[ai-baseline] ${mode}: ${(err as Error).message}`);
    const tail = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => /ai-double|ai-recorder|error|Error/.test(l)).slice(-40);
    console.error(`[ai-baseline] server log (filtered tail):\n${tail.join("\n")}`);
  }

  if (mode === "record" && exitCode === 0) {
    const missing = await recordVendorErrors(serverEnv.AI_RECORDER_LEDGER!, allowance, falKey, openaiKey);
    if (missing.length > 0) {
      exitCode = 1;
      console.error(`[ai-baseline] record: the failure control is incomplete:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
    }
  }

  if (mode === "record") {
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { limitUsd: number; committedUsd: number; reused?: number; lines: unknown[] };
      console.log(
        `[ai-baseline] spend: committed $${ledger.committedUsd.toFixed(4)} of $${ledger.limitUsd.toFixed(2)} over ${ledger.lines.length} vendor calls; ` +
          `${ledger.reused ?? 0} requests answered from recordings already on disk (ledger: ${ledgerPath})`,
      );
    }
    console.log(`[ai-baseline] recordings in ${out}: ${fs.readdirSync(out).filter((f) => f.endsWith(".json")).length} files`);
  }
} catch (err) {
  exitCode = 1;
  console.error(`[ai-baseline] ${(err as Error).message}`);
} finally {
  cleanUp();
}
process.exit(exitCode);
