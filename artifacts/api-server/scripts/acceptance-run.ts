/**
 * The baseline runner (Launch Phase 2, increments 4 and 6, #631; plans
 * `PLAN_PHASE2_INC4_AI_DOUBLES.md` D6/D7 and `PLAN_PHASE2_INC6_ACCEPTANCE.md`).
 * One scaffold, every mode: a fresh marked database per variant (schema push,
 * migrations), then the inner program (`src/testing/acceptance/inner.ts`) —
 * the committed legacy fixture and the prompt pins for the fixture variant,
 * the account seed, the server booted from a constructed environment through
 * its launcher, journeys 2–7 — then the evidence report, and the database and
 * scratch directory dropped.
 *
 *   --mode acceptance  The acceptance run. The AI double answers from the
 *                      committed recordings; no credential anywhere; the whole
 *                      inner program runs inside the outbound-request detector
 *                      (`src/testing/acceptance/detector.ts`). Green only when
 *                      every journey passed, both observers recorded the
 *                      self-test and nothing after it, no AI call went
 *                      uncovered, and every expected operation has evidence.
 *   --mode replay      The same without the detector: the proof that the
 *                      recordings carry the consumers through.
 *   --mode record      On the Repl only, never in CI: the real AI clients under
 *                      the recorder and its allowance, writing to --out.
 *                      `--resume` tops up an existing directory.
 *   --mode live        On the Repl only, never in CI: the live check. The real
 *                      AI vendors and Pexels, reuse off, recordings discarded,
 *                      under a per-invocation cap (default $5, never more
 *                      without --allowance-raised-by-david <YYYY-MM-DD>).
 *                      Green only when every operation shows a usable current
 *                      answer.
 *   --mode serve       The acceptance server, left running on --port for a
 *                      browser spec (`e2e:storage`); no journeys.
 *   --mode probe       The detector's feasibility check alone.
 *
 *   --variant fresh|fixture|both   (default: both for acceptance and live, fresh otherwise)
 *   --control forbidden-request|render-failure|upload-failure|corrupt-source
 *                      A negative control: the exit code says whether the run
 *                      failed in exactly the way the control expects.
 *   --report-dir <dir> Where the report is written (default: a fresh temporary directory).
 *
 * DATABASE_URL must be a marked test database; it is used only to reach its
 * server. Exit codes: 0 green (or a control that behaved); 1 red; 2 usage or
 * refusal; 90 environment failure (the detector's boundary cannot be built here).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { markTestDatabaseSql, testDatabaseRefusal } from "@workspace/db/test-database";

import { falSubscribeRequest } from "../src/lib/aiDouble/doubles";
import { evaluateCoverage, readCallRecords, unattributedCalls, type CallRecord, type Mode, type Row, type Variant } from "../src/testing/acceptance/coverage";
import { evaluateDetector, launchInNamespace, namespaceRoute, type DetectorVerdict, type NamespaceRoute } from "../src/testing/acceptance/detector";
import type { DriveResult } from "../src/testing/acceptance/driver";
import type { InnerConfig } from "../src/testing/acceptance/inner";
import { startPgRelay } from "../src/testing/acceptance/pgRelay";
import { redReasons } from "../src/testing/acceptance/verdict";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const COMMITTED_RECORDINGS = path.join(API_ROOT, "src/lib/aiDouble/recordings");
const FIXTURE_DIR = path.join(API_ROOT, "fixtures/legacy");
const PHOTO = path.join(API_ROOT, "scripts/fixtures/ai-baseline/photo.jpg");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const MODES = ["probe", "acceptance", "replay", "record", "live", "serve"] as const;
type RunMode = (typeof MODES)[number];
const CONTROLS = ["forbidden-request", "render-failure", "upload-failure", "corrupt-source"] as const;
type Control = (typeof CONTROLS)[number];

const mode = arg("mode") as RunMode | undefined;
if (!mode || !MODES.includes(mode)) {
  console.error(`usage: acceptance-run.ts --mode ${MODES.join("|")} [--variant fresh|fixture|both] [--control ${CONTROLS.join("|")}] [--report-dir <dir>]
       record: --allowance <usd> --out <dir> [--resume];  live: [--allowance <usd>] [--allowance-raised-by-david <date>];  serve: [--port <n>]`);
  process.exit(2);
}
const control = arg("control") as Control | undefined;
const variantArg = arg("variant") ?? (mode === "acceptance" || mode === "live" ? "both" : "fresh");
const variants: Variant[] = variantArg === "both" ? ["fresh", "fixture"] : [variantArg as Variant];

// --- refusals, before anything is created ----------------------------------
const refusals: string[] = [];
if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production") refusals.push("never in a production environment");
if (!["fresh", "fixture", "both"].includes(variantArg)) refusals.push(`unknown variant ${variantArg}`);
if (control !== undefined && !CONTROLS.includes(control)) refusals.push(`unknown control ${control}`);
if (control === "forbidden-request" && mode !== "acceptance" && mode !== "probe") refusals.push("the forbidden-request control needs the detector: --mode acceptance");
if ((control === "render-failure" || control === "upload-failure" || control === "corrupt-source") && mode !== "acceptance" && mode !== "replay") {
  refusals.push(`the ${control} control runs over the recordings: --mode acceptance or replay`);
}
if (control === "upload-failure" && variantArg !== "fixture") refusals.push("the upload-failure control needs the fixture's fail-open classifier: --variant fixture");
if (control && variants.length > 1) refusals.push("a control runs one variant: pass --variant");
const CREDENTIAL = /^(FAL_|OPENAI_|STRIPE_|RESEND_|PEXELS_|ARACHNID_|NCMEC_|HCAPTCHA_|SENTRY_DSN)/;
if (mode === "acceptance" || mode === "replay" || mode === "serve" || mode === "probe") {
  const held = Object.keys(process.env).filter((k) => CREDENTIAL.test(k) && (process.env[k] ?? "").trim() !== "");
  if (held.length) refusals.push(`a ${mode} run holds no credential; unset ${held.join(", ")}`);
}
const falKey = process.env.FAL_AI_API_KEY || process.env.FAL_KEY || "";
const openaiKey = process.env.OPENAI_API_KEY || "";
const out = path.resolve(arg("out") ?? COMMITTED_RECORDINGS);
const resume = flag("resume");
const recordLedger = path.join(out, "..", "ai-recorder-ledger.json");
let allowance = arg("allowance") ?? "";
if (mode === "record" || mode === "live") {
  if (process.env.CI) refusals.push(`the ${mode} run never runs in CI`);
  if (!falKey || !openaiKey) refusals.push(`${mode} mode needs FAL_AI_API_KEY (or FAL_KEY) and OPENAI_API_KEY`);
}
if (mode === "record") {
  if (!(Number(allowance) > 0)) refusals.push("record mode needs --allowance <usd>, the approved spending ceiling");
  if (!arg("out")) refusals.push("record mode needs --out <dir>: recordings are reviewed and scrubbed before they are committed");
  const held = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith(".json")).length : 0;
  if (!resume && held > 0) refusals.push(`--out already holds ${held} recordings; a new recording starts empty, or pass --resume to top that directory up`);
  if (!resume && fs.existsSync(recordLedger)) refusals.push(`a ledger from an earlier run is at ${recordLedger}; remove it for a new recording, or pass --resume to continue that run`);
}
if (mode === "live") {
  if (!process.env.PEXELS_API_KEY) refusals.push("live mode needs PEXELS_API_KEY: the fixture variant reads a Pexels-only meme");
  allowance ||= "5";
  const raisedBy = arg("allowance-raised-by-david");
  if (!(Number(allowance) > 0)) refusals.push("--allowance must be a positive dollar amount");
  else if (Number(allowance) > 5 && !/^\d{4}-\d{2}-\d{2}$/.test(raisedBy ?? "")) {
    refusals.push("the live check's cap is $5 per run (David, 2026-10-14); a higher --allowance needs --allowance-raised-by-david <YYYY-MM-DD>");
  }
}
const dbRefusal = await testDatabaseRefusal(process.env);
if (dbRefusal) refusals.push(dbRefusal);
if (refusals.length > 0) {
  console.error(`[acceptance] refusing:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(2);
}

// --- the boundary, when this mode needs it ----------------------------------
const detecting = mode === "acceptance" || mode === "probe";
let route: NamespaceRoute | null = null;
if (detecting) {
  const r = namespaceRoute();
  if (r.kind === "unavailable") {
    console.error(`[acceptance] environment failure: no network namespace can be created here (${r.reason})`);
    process.exit(90);
  }
  route = r;
}

const source = new URL(process.env.DATABASE_URL!);
const controlDb = new URL(source.href);
controlDb.pathname = "/postgres";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
fs.chmodSync(scratch, 0o755);
const created: string[] = [];
let inner: ChildProcess | null = null;

function psql(url: URL, sql: string): void {
  execFileSync("psql", [url.href, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: ["ignore", "inherit", "inherit"] });
}
function pnpm(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("pnpm", args, { cwd: REPO_ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
}
function cleanUp(): void {
  if (inner && inner.exitCode === null) inner.kill("SIGTERM");
  if (!flag("keep-db")) {
    for (const db of created) {
      try {
        psql(controlDb, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      } catch {
        console.error(`[acceptance] could not drop ${db}; drop it by hand`);
      }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.once("SIGINT", () => { cleanUp(); process.exit(130); });

function freshDatabase(variant: string): URL {
  const name = `overhype_acceptance_${variant}_${Date.now()}`;
  psql(controlDb, `CREATE DATABASE "${name}"`);
  created.push(name);
  psql(controlDb, markTestDatabaseSql(`"${name}"`));
  const url = new URL(source.href);
  url.pathname = `/${name}`;
  psql(url, "CREATE EXTENSION IF NOT EXISTS vector");
  const toolEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url.href, NODE_ENV: "development" };
  pnpm(["--filter", "@workspace/db", "push-force"], toolEnv);
  pnpm(["--filter", "@workspace/db", "run", "migrate"], toolEnv);
  return url;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function recordingsIdentity(dir: string): { files: number; listingSha256: string } {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const listing = files.map((f) => `${f}:${sha256(path.join(dir, f))}`).join("\n");
  return { files: files.length, listingSha256: createHash("sha256").update(listing).digest("hex") };
}
function pexelsOnlyMemes(): number {
  return fs
    .readFileSync(path.join(FIXTURE_DIR, "memes.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { image_source?: { type?: string; photoUrl?: string } })
    .filter((m) => m.image_source?.type === "stock" && !m.image_source.photoUrl).length;
}

// --- recording mode's own checks (unchanged from increment 4) ---------------
const FAL_INVALID = { input: { prompt: "" } };
const OPENAI_INVALID = { model: "gpt-5.4-mini", messages: [], max_completion_tokens: 16 };
const FAILURE_CONTROLS = [
  { vendor: "fal", kind: "fal.subscribe" as const, target: "fal-ai/nano-banana-2", status: 422, request: falSubscribeRequest("fal-ai/nano-banana-2", FAL_INVALID) },
  { vendor: "OpenAI", kind: "openai.chat" as const, target: "gpt-5.4-mini", status: 400, request: OPENAI_INVALID },
];

/** One real error from each vendor for the double's failure control (inc 4, D5), drawn from the same allowance. */
async function recordVendorErrors(): Promise<string[]> {
  process.env.AI_RECORDINGS_DIR = out;
  const { fal: vendorFal } = await import("@fal-ai/client");
  const OpenAI = (await import("openai")).default;
  const { Allowance, recordingFal, recordingOpenAI, vendorRejectionCaptured, controlAlreadyCaptured } = await import("../src/lib/aiDouble/recorder");
  const { falUnitPrice } = await import("../src/lib/falClient");
  const shared = new Allowance(Number(allowance), recordLedger);
  const ctx = { clients: { "@fal-ai/client": "see recordings", openai: "see recordings" } };
  const firstRecording = fs.readdirSync(out).find((f) => f.endsWith(".json"));
  if (firstRecording) ctx.clients = JSON.parse(fs.readFileSync(path.join(out, firstRecording), "utf8")).clients;
  vendorFal.config({ credentials: falKey });
  const falRec = recordingFal(vendorFal as never, shared, ctx, falUnitPrice);
  const oaRec = recordingOpenAI(new OpenAI({ apiKey: openaiKey, maxRetries: 0 }), shared, ctx);
  const send: Record<string, () => Promise<unknown>> = {
    fal: () => falRec.subscribe("fal-ai/nano-banana-2", FAL_INVALID),
    OpenAI: () => oaRec.chat.completions.create(OPENAI_INVALID as never),
  };
  const missing: string[] = [];
  for (const probe of FAILURE_CONTROLS) {
    if (resume && controlAlreadyCaptured(probe.kind, probe.target, probe.request, probe.status)) {
      shared.noteReused();
      console.log(`[acceptance] ${probe.vendor} error already recorded (${probe.status}); reused, not sent again`);
      continue;
    }
    try {
      await send[probe.vendor]!();
      missing.push(`${probe.vendor} accepted the invalid request`);
    } catch (err) {
      if (vendorRejectionCaptured(probe.kind, probe.target, err, probe.status)) {
        console.log(`[acceptance] recorded ${probe.vendor} error: ${(err as Error).name} ${(err as { status?: number }).status}`);
      } else {
        missing.push(`${probe.vendor}: its ${probe.status} rejection was not recorded (${(err as Error).name}: ${(err as Error).message.slice(0, 160)})`);
      }
    }
  }
  return missing;
}

/**
 * The AI calls that got no real answer. Replay and acceptance read the
 * double's miss log; record reads the ledger and the corpus. Best-effort
 * callers fall back, so a journey can pass over such a call; this makes it
 * visible. fal's pricing warm-up is excluded by design (inc 4, D2), and the
 * recording's failure controls are the one exception.
 */
async function uncoveredCalls(missLog: string, priorLedgerLines: number): Promise<string[]> {
  const rows: Array<{ kind: string; target: string; fingerprint?: string; recordedErrorStatus?: number }> = [];
  if ((mode === "replay" || mode === "acceptance") && fs.existsSync(missLog)) {
    rows.push(...fs.readFileSync(missLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  if (mode === "record" && fs.existsSync(recordLedger)) {
    const ledger = JSON.parse(fs.readFileSync(recordLedger, "utf8")) as { lines: Array<{ kind: string; target: string; outcome: string; fingerprint?: string }> };
    const answered = (l: { kind: string; fingerprint?: string }): boolean => {
      const file = path.join(out, `${l.kind}--${l.fingerprint}.json`);
      return !!l.fingerprint && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).response !== undefined;
    };
    rows.push(...ledger.lines.slice(priorLedgerLines).filter((l) => l.outcome === "refused" || (l.outcome === "error" && !answered(l))));
    process.env.AI_RECORDINGS_DIR = out;
    const { strayErrorRecordings } = await import("../src/lib/aiDouble/recorder");
    rows.push(...strayErrorRecordings(FAILURE_CONTROLS).map((r) => ({ kind: r.kind, target: r.target, fingerprint: r.fingerprint, recordedErrorStatus: r.error!.status })));
  }
  const seen = new Set<string>();
  return rows
    .sort((a, b) => Number(!!b.recordedErrorStatus) - Number(!!a.recordedErrorStatus))
    .filter((r) => {
      const key = `${r.kind}\0${r.fingerprint ?? r.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return r.kind !== "fal.pricing";
    })
    .map((r) => `${r.kind} ${r.target}${r.fingerprint ? ` (fingerprint ${r.fingerprint.slice(0, 12)})` : ""}` + (r.recordedErrorStatus ? `: answered only by a recorded ${r.recordedErrorStatus} vendor error` : ""));
}

// --- one variant ---------------------------------------------------------------
interface VariantReport {
  variant: Variant;
  database: string;
  journeys: DriveResult["outcomes"];
  setupError?: string;
  innerError?: string;
  control?: DriveResult["control"];
  detector?: Pick<DetectorVerdict, "ok" | "problems" | "netns" | "selfTest" | "info"> & { violations: { sink: unknown[]; syscall: string[] } };
  uncovered: string[];
  coverage: Row[];
  /** AI calls with no recording, so no operation can claim them (see coverage.ts). */
  unattributed: CallRecord[];
  promptPins?: unknown;
  pexelsMeme?: unknown;
  corrupted?: string;
  red: string[];
  serverLogTail?: string[];
}

async function runVariant(variant: Variant, liveRecordings: string, liveLedger: string): Promise<VariantReport> {
  const url = freshDatabase(variant);
  const work = path.join(scratch, variant);
  fs.mkdirSync(work, { recursive: true });
  fs.chmodSync(work, 0o777);
  const missLog = path.join(work, "ai-double-misses.jsonl");
  const recordingsDir = mode === "record" ? out : mode === "live" ? liveRecordings : COMMITTED_RECORDINGS;
  const callRecord = mode === "record" ? recordLedger : mode === "live" ? liveLedger : path.join(work, "ai-calls.jsonl");
  const ledgerLines = (f: string) => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { lines: unknown[] }).lines.length : 0);
  const priorLedgerLines = mode === "record" || mode === "live" ? ledgerLines(callRecord) : 0;
  if (mode === "record" || mode === "live") fs.mkdirSync(recordingsDir, { recursive: true });

  const relay = detecting ? await startPgRelay(path.join(work, "pg"), { host: !url.hostname || url.hostname === "localhost" ? "127.0.0.1" : url.hostname, port: Number(url.port || 5432) }) : null;
  const photoSha = sha256(PHOTO);
  const cfg: InnerConfig = {
    job: mode === "probe" ? "probe" : "journeys",
    work,
    databaseUrl: relay ? relay.url(url.href) : url.href,
    selfTest: detecting,
    mode: mode === "serve" || mode === "probe" ? "acceptance" : mode,
    variant,
    recordingsDir,
    callRecord,
    missLog,
    allowanceUsd: allowance || undefined,
    ...(control ? { control } : {}),
    aiDoubleFail:
      control === "render-failure" ? "fal.subscribe:fal-ai/nano-banana-2"
      : control === "upload-failure" ? `fal.storage.upload:storage@${photoSha}`
      : undefined,
    ...(mode === "serve" ? { serve: { port: Number(arg("port") ?? 8080) } } : {}),
  };
  const cfgPath = path.join(work, "inner-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const innerArgs = ["--import", "tsx/esm", "src/testing/acceptance/inner.ts", cfgPath];
  const innerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (mode === "record" || mode === "live") Object.assign(innerEnv, { FAL_AI_API_KEY: falKey, OPENAI_API_KEY: openaiKey });
  if (mode === "live") {
    Object.assign(innerEnv, { PEXELS_API_KEY: process.env.PEXELS_API_KEY });
    if (process.env.ARACHNID_SHIELD_USERNAME && process.env.ARACHNID_SHIELD_PASSWORD) {
      Object.assign(innerEnv, { ARACHNID_SHIELD_USERNAME: process.env.ARACHNID_SHIELD_USERNAME, ARACHNID_SHIELD_PASSWORD: process.env.ARACHNID_SHIELD_PASSWORD });
    }
  }
  inner = route
    ? launchInNamespace(route, work, API_ROOT, innerArgs)
    : spawn(process.execPath, innerArgs, { cwd: API_ROOT, env: innerEnv, stdio: ["ignore", "pipe", "pipe"] });
  inner.stdout!.pipe(process.stdout);
  inner.stderr!.pipe(process.stderr);
  if (mode === "serve") process.once("SIGINT", () => inner?.kill("SIGINT"));
  const code: number = await new Promise((r) => inner!.once("exit", (c) => r(c ?? 1)));
  await relay?.close();
  if (code === 90) {
    const v = evaluateDetector(work);
    console.error(`[acceptance] environment failure: ${v.problems.join("; ")}`);
    cleanUp();
    process.exit(90);
  }

  let result: Record<string, any> = {};
  try { result = JSON.parse(fs.readFileSync(path.join(work, "inner-result.json"), "utf8")); } catch {}
  const drive = result.drive as DriveResult | undefined;
  const report: VariantReport = {
    variant,
    database: url.pathname.slice(1),
    journeys: drive?.outcomes ?? [],
    uncovered: mode === "probe" ? [] : await uncoveredCalls(missLog, priorLedgerLines),
    coverage: [],
    unattributed: [],
    red: [],
    ...(drive?.setupError ? { setupError: drive.setupError } : {}),
    ...(drive?.control ? { control: drive.control } : {}),
    ...(result.ok === false ? { innerError: String(result.error).slice(0, 2000) } : {}),
    ...(result.promptPins ? { promptPins: result.promptPins } : {}),
    ...(result.pexelsMeme ? { pexelsMeme: result.pexelsMeme } : {}),
    ...(result.corrupted ? { corrupted: result.corrupted } : {}),
  };
  if (detecting) {
    const v = evaluateDetector(work);
    report.detector = {
      ok: v.ok,
      problems: v.problems,
      netns: v.netns,
      selfTest: v.selfTest,
      info: v.info,
      violations: { sink: v.violations.sink, syscall: v.violations.syscall.map((l) => l.raw) },
    };
  }
  if (mode === "probe") {
    report.red.push(...(report.detector ? redReasons({ journeys: [], coverage: [], uncovered: [], detector: report.detector }).filter((r) => r.startsWith("detector")) : []));
    if (result.ok !== true) report.red.push("the probe's database or local HTTP check failed");
  } else if (mode !== "serve") {
    const calls = readCallRecords(callRecord).slice(priorLedgerLines);
    report.coverage = evaluateCoverage({ mode: mode as Mode, variant, calls, recordingsDir, photoSha256: photoSha });
    report.unattributed = unattributedCalls({ calls, recordingsDir });
    report.red.push(
      ...redReasons({
        journeys: report.journeys,
        coverage: report.coverage,
        uncovered: report.uncovered,
        detector: report.detector,
        setupError: report.setupError,
        innerError: report.innerError,
        pexelsMeme: result.pexelsMeme as { ok?: boolean } | undefined,
        requirePexelsMeme: mode === "live" && variant === "fixture",
      }),
    );
  }
  if (report.red.length > 0 && fs.existsSync(path.join(work, "server.log"))) {
    report.serverLogTail = fs.readFileSync(path.join(work, "server.log"), "utf8").split("\n").slice(-200);
  }
  return report;
}

// --- did a control behave? -----------------------------------------------------
function controlVerdict(r: VariantReport): { behaved: boolean; why: string } {
  switch (control) {
    case "forbidden-request": {
      const named = (r.detector?.violations.sink as Array<{ name: string | null }> | undefined)?.some((e) => e.name === "api.openai.com") ?? false;
      const sys = (r.detector?.violations.syscall.length ?? 0) > 0;
      return { behaved: named && sys, why: named && sys ? "both observers recorded the caught request, the sink naming api.openai.com" : "the caught request was not recorded by both observers" };
    }
    case "render-failure":
      return { behaved: r.control?.ok === true, why: r.control?.detail ?? "journey 3 never reached its renders" };
    case "upload-failure": {
      const seven = r.journeys.find((j) => j.journey === "7")?.status === "passed";
      const missing = r.coverage.filter((c) => c.status === "missing").map((c) => c.key).sort();
      const expected = ["photo-classifier", "photo-upload"];
      const others = r.red.filter((x) => !x.startsWith("operation photo-upload") && !x.startsWith("operation photo-classifier"));
      const behaved = seven && JSON.stringify(missing) === JSON.stringify(expected) && others.length === 0;
      return { behaved, why: behaved ? "journey 7 completed on the fail-open path, and the evaluator marked the photo's upload and classification missing, and nothing else" : `journey 7 ${seven ? "passed" : "did not pass"}; missing rows ${missing.join(", ") || "none"}; other red reasons: ${others.join(" | ") || "none"}` };
    }
    case "corrupt-source": {
      const four = r.journeys.find((j) => j.journey === "4");
      const othersPassed = r.journeys.filter((j) => j.journey !== "4").every((j) => j.status === "passed");
      const behaved = four?.status === "failed" && /anyone reads the public meme image/.test(four.error ?? "") && othersPassed;
      return { behaved, why: behaved ? `journey 4 failed reading its composed image: ${four!.error}` : `journey 4 is ${four?.status} (${four?.error ?? "no error"}); every other journey passed: ${othersPassed}` };
    }
    default:
      return { behaved: false, why: "no control" };
  }
}

/** A Markdown table cell: backslashes first, then pipes, and no line breaks. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderMarkdown(report: Record<string, any>): string {
  const lines = [`# Acceptance report — ${report.mode}${report.control ? `, control ${report.control}` : ""}`, "", `**Result: ${report.verdict}**`, "", `Commit \`${report.commit}\` · recordings ${report.recordings.files} files, listing sha256 \`${report.recordings.listingSha256.slice(0, 16)}…\`${report.fixtureManifestSha256 ? ` · fixture manifest \`${report.fixtureManifestSha256.slice(0, 16)}…\`` : ""}`, ""];
  if (report.controlVerdict) lines.push(`Control: ${report.controlVerdict.behaved ? "behaved" : "did NOT behave"} — ${report.controlVerdict.why}`, "");
  for (const v of report.variants as VariantReport[]) {
    lines.push(`## Variant: ${v.variant}`, "", "| Journey | Outcome | Note |", "|---|---|---|");
    for (const j of v.journeys) lines.push(`| ${j.journey} | ${j.status} | ${cell((j.error ?? (j.deferred ?? []).join("; ")).slice(0, 200))} |`);
    if (v.coverage.length) {
      lines.push("", "| Operation | Journey | Evidence | Detail |", "|---|---|---|---|");
      for (const c of v.coverage) lines.push(`| ${cell(c.description)} | ${c.journey} | ${c.status} | ${cell(c.detail)} |`);
    }
    if (v.detector) {
      lines.push("", `Detector: ${v.detector.ok ? "clean" : "RED"} (${v.detector.netns?.privilege ?? "?"}, IPv6 ${v.detector.netns?.ipv6 ? "observed" : "absent on this kernel"}). Self-test: ${v.detector.selfTest.map((s) => `${s.key} ${s.observable ? (s.syscall && s.sink ? "seen by both" : "MISSED") : "not observable here"}`).join(", ")}. Outbound attempts after it: ${v.detector.violations.sink.length + v.detector.violations.syscall.length}.`);
    }
    if (v.unattributed.length) lines.push("", `AI calls with no recording (no operation can claim them): ${v.unattributed.map((c) => `${c.kind} ${c.target} (${c.outcome})`).join(", ")}`);
    if (v.red.length) lines.push("", "Red because:", ...v.red.map((x) => `- ${x}`));
    lines.push("");
  }
  lines.push("Deferred, never passed:", ...(report.deferrals as string[]).map((d) => `- ${d}`));
  return lines.join("\n") + "\n";
}

// --- the run ---------------------------------------------------------------------
let exitCode = 0;
const reportDir = path.resolve(arg("report-dir") ?? fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-report-")));
try {
  const liveRecordings = path.join(scratch, "live-recordings");
  const liveLedger = path.join(scratch, "live-ledger.json");
  const reports: VariantReport[] = [];
  for (const variant of variants) reports.push(await runVariant(variant, liveRecordings, liveLedger));
  if (mode === "serve") {
    cleanUp();
    process.exit(0);
  }
  if (mode === "record" && reports.every((r) => r.red.length === 0)) {
    const missing = await recordVendorErrors();
    if (missing.length) reports[reports.length - 1]!.red.push(...missing.map((m) => `the recording's failure control: ${m}`));
  }
  const spend = (f: string) => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { limitUsd: number; committedUsd: number; reused?: number; lines: unknown[] }) : null);
  const ledger = mode === "record" ? spend(recordLedger) : mode === "live" ? spend(liveLedger) : null;
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(); } catch {}
  const green = reports.every((r) => r.red.length === 0);
  const controlResult = control ? controlVerdict(reports[0]!) : undefined;
  const report = {
    mode,
    control: control ?? null,
    commit,
    verdict: control ? (controlResult!.behaved ? "control behaved" : "control did NOT behave") : green ? "green" : "red",
    recordings: recordingsIdentity(mode === "record" ? out : COMMITTED_RECORDINGS),
    fixtureManifestSha256: variants.includes("fixture") ? sha256(path.join(FIXTURE_DIR, "manifest.json")) : null,
    ...(ledger ? { spend: { capUsd: ledger.limitUsd, committedUsd: Number(ledger.committedUsd.toFixed(4)), vendorCalls: ledger.lines.length, reused: ledger.reused ?? 0 } } : {}),
    deferrals: [
      "journey 6: spend recorded against the user — deferred to #651 (David, 2026-10-12)",
      ...(variants.includes("fixture") && mode !== "live" ? [`the fixture's ${pexelsOnlyMemes()} Pexels-only stock memes: read by no acceptance journey; the live check reads one (David, 2026-10-14)`] : []),
    ],
    ...(controlResult ? { controlVerdict: controlResult } : {}),
    variants: reports,
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "acceptance-report.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(reportDir, "acceptance-report.md"), renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`[acceptance] report: ${path.join(reportDir, "acceptance-report.json")}`);
  exitCode = control ? (controlResult!.behaved ? 0 : 1) : green ? 0 : 1;
} catch (err) {
  exitCode = 1;
  console.error(`[acceptance] ${(err as Error).stack ?? err}`);
} finally {
  cleanUp();
}
process.exit(exitCode);
