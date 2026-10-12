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
 *   --mode replay   Anywhere, with no credential. Boots the server with
 *                   AI_BACKEND=recorded-double over the committed recordings
 *                   and drives the same baseline: the proof that the
 *                   recordings carry the real consumers through.
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
 *     --allowance 5 --out /tmp/ai-recordings
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabaseRefusal } from "@workspace/db/test-database";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const mode = arg("mode");
if (mode !== "record" && mode !== "replay") {
  console.error("usage: record-ai-baseline.ts --mode record|replay [--allowance <usd> --out <dir>] [--keep-db]");
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
if (mode === "record") {
  if (!falKey || !openaiKey) refusals.push("record mode needs FAL_AI_API_KEY (or FAL_KEY) and OPENAI_API_KEY");
  if (!(Number(allowance) > 0)) refusals.push("record mode needs --allowance <usd>, the approved spending ceiling");
  if (!arg("out")) refusals.push("record mode needs --out <dir>: recordings are reviewed and scrubbed before they are committed");
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
const port = 20000 + Math.floor(Math.random() * 20000);
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
async function recordVendorErrors(ledger: string, limit: string, fal: string, openai: string): Promise<void> {
  process.env.AI_RECORDINGS_DIR = out;
  const { fal: vendorFal } = await import("@fal-ai/client");
  const OpenAI = (await import("openai")).default;
  const { Allowance, recordingFal, recordingOpenAI } = await import("../src/lib/aiDouble/recorder");
  const { falUnitPrice } = await import("../src/lib/falClient");
  const shared = new Allowance(Number(limit), ledger);
  const ctx = { clients: { "@fal-ai/client": "see recordings", openai: "see recordings" } };
  const firstRecording = fs.readdirSync(out).find((f) => f.endsWith(".json"));
  if (firstRecording) ctx.clients = JSON.parse(fs.readFileSync(path.join(out, firstRecording), "utf8")).clients;
  vendorFal.config({ credentials: fal });
  const falRec = recordingFal(vendorFal as never, shared, ctx, (e) => falUnitPrice(e, ctx));
  try {
    await falRec.subscribe("fal-ai/nano-banana-2", { input: { prompt: "" } });
    console.error("[ai-baseline] fal accepted an empty prompt; no error recorded for fal");
  } catch (err) {
    console.log(`[ai-baseline] recorded fal error: ${(err as Error).name} ${(err as { status?: number }).status ?? ""}`);
  }
  const oaRec = recordingOpenAI(new OpenAI({ apiKey: openai, maxRetries: 0 }), shared, ctx);
  try {
    await oaRec.chat.completions.create({ model: "gpt-5.4-mini", messages: [], max_completion_tokens: 16 });
    console.error("[ai-baseline] OpenAI accepted an empty message list; no error recorded for OpenAI");
  } catch (err) {
    console.log(`[ai-baseline] recorded OpenAI error: ${(err as Error).name} ${(err as { status?: number }).status ?? ""}`);
  }
}

let exitCode = 0;
try {
  psql(control, `CREATE DATABASE "${runDb}"`);
  psql(control, `ALTER DATABASE "${runDb}" SET overhype.test_database = 'yes'`);
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
      AI_RECORDER_LEDGER: path.join(out, "..", "ai-recorder-ledger.json"),
    });
    entry = "src/testing/aiRecorderLauncher.ts";
  } else {
    serverEnv.AI_BACKEND = "recorded-double";
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
    console.log(
      "renderFailure" in evidence
        ? `[ai-baseline] ${mode}: the recorded vendor error reached the render job's failed state`
        : `[ai-baseline] ${mode}: every baseline journey passed`,
    );
    console.log(JSON.stringify(evidence, null, 2));
  } catch (err) {
    exitCode = 1;
    console.error(`[ai-baseline] ${mode}: ${(err as Error).message}`);
    const tail = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => /ai-double|ai-recorder|error|Error/.test(l)).slice(-40);
    console.error(`[ai-baseline] server log (filtered tail):\n${tail.join("\n")}`);
  }

  if (mode === "record" && exitCode === 0) {
    await recordVendorErrors(serverEnv.AI_RECORDER_LEDGER!, allowance, falKey, openaiKey);
  }

  if (mode === "record") {
    const ledgerPath = serverEnv.AI_RECORDER_LEDGER!;
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { limitUsd: number; committedUsd: number; lines: unknown[] };
      console.log(`[ai-baseline] spend: committed $${ledger.committedUsd.toFixed(4)} of $${ledger.limitUsd.toFixed(2)} over ${ledger.lines.length} vendor calls (ledger: ${ledgerPath})`);
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
