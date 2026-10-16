/**
 * The part of a run that executes inside the boundary (Launch Phase 2,
 * increment 6, #631; plan D1, D4, D5, D6). The host-side runner
 * (`scripts/acceptance-run.ts`) writes a config file and starts this — under
 * the namespace wrapper in acceptance mode, directly otherwise — with a
 * constructed environment: PATH and HOME, plus the vendor keys only in the
 * record and live modes.
 *
 *   node --import tsx/esm src/testing/acceptance/inner.ts <config.json>
 *
 * Order: the detector's self-test (when asked) → for the fixture variant, the
 * committed fixture and the prompt pins → the account seed → the server, from
 * a constructed environment through its launcher → journeys 2–7 → in live mode
 * over the fixture, one Pexels-only legacy meme read → the server stopped, so
 * its teardown is observed too.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { checkImage } from "./imageCheck";
import { ACCEPTANCE_ENV_ALLOWLIST, constructEnvironment, LIVE_ENV_ALLOWLIST, RECORDER_ENV_ALLOWLIST } from "../launchEnvironment";
import { runSelfTest } from "./selfTest";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type InnerMode = "acceptance" | "replay" | "record" | "live" | "capture";

export interface InnerConfig {
  job: "probe" | "journeys";
  work: string;
  /** Through the relay's socket under the namespace; the database's own URL otherwise. */
  databaseUrl: string;
  selfTest: boolean;
  /** `forbidden-request`: after the self-test, one vendor request whose error is caught, as application code would. */
  control?: "forbidden-request" | "render-failure" | "upload-failure" | "corrupt-source";
  mode?: InnerMode;
  variant?: "fresh" | "fixture";
  /** Where AI recordings are read (replay, acceptance) or written (record, live). */
  recordingsDir?: string;
  /** The double's call log (acceptance, replay) or the recorder's ledger (record, live). */
  callRecord?: string;
  missLog?: string;
  allowanceUsd?: string;
  aiDoubleFail?: string;
  /** Keep the server running after the journeys until SIGTERM (serve mode). */
  serve?: { port: number; origin: string };
  /** Capture mode (increment 8, D7): run the capture journeys instead of 2–7, writing images to `out`. */
  capture?: { out: string; commit: string };
}

const node = process.execPath;

function run(script: string, env: NodeJS.ProcessEnv, label: string): void {
  const r = spawnSync(node, ["--import", "tsx/esm", script], { cwd: API_ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").slice(-2000)}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, server: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (open) return;
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode} before listening`);
    if (Date.now() > deadline) throw new Error(`the server did not listen on ${port} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
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

/** The three AI prompt rows set to the code defaults (David, 2026-10-14, option 2; plan D5). */
async function pinPrompts(databaseUrl: string): Promise<Array<{ key: string; differed: boolean }>> {
  process.env.DATABASE_URL = databaseUrl;
  const { FACT_ENRICHMENT_SYSTEM_DEFAULT } = await import("../../lib/factEnrichmentConfig");
  const { FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT } = await import("../../lib/visualConceptsConfig");
  const { FACT_IMAGE_PROMPT_SYSTEM_DEFAULT } = await import("../../lib/imagePromptConfig");
  const pins: Array<[string, string]> = [
    ["fact_enrichment_system", FACT_ENRICHMENT_SYSTEM_DEFAULT],
    ["fact_visual_concepts_system", FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT],
    ["fact_image_prompt_system", FACT_IMAGE_PROMPT_SYSTEM_DEFAULT],
  ];
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const out: Array<{ key: string; differed: boolean }> = [];
  try {
    for (const [key, value] of pins) {
      const { rows } = await client.query<{ value: string }>("SELECT value FROM admin_config WHERE key = $1", [key]);
      if (rows.length === 0) throw new Error(`the fixture has no ${key} row to pin`);
      await client.query("UPDATE admin_config SET value = $1 WHERE key = $2", [value, key]);
      out.push({ key, differed: rows[0]!.value !== value });
    }
  } finally {
    await client.end();
  }
  return out;
}

/** One Pexels-only legacy meme read anonymously (live mode over the fixture; David, 2026-10-14, option 1). */
async function readPexelsMeme(databaseUrl: string, base: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const { rows } = await client.query<{ slug: string }>(
    `SELECT permalink_slug AS slug FROM memes
      WHERE image_source->>'type' = 'stock' AND NOT image_source ? 'photoUrl' AND is_public AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
  );
  await client.end();
  if (!rows[0]) return { ok: false, problem: "the fixture holds no public Pexels-only meme" };
  const res = await fetch(`${base}/api/memes/${rows[0].slug}/image`);
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) return { ok: false, slug: rows[0].slug, problem: `${res.status} from the meme image route` };
  const check = await checkImage(body, res.headers.get("content-type"));
  return check.ok ? { ok: true, slug: rows[0].slug, ...check.image } : { ok: false, slug: rows[0].slug, problem: check.problem };
}

/** The active fixture fact the PR223 capture generates for: the first whose text personalises the name. */
async function captureFact(databaseUrl: string): Promise<{ id: number; text: string } | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: number; text: string }>(
      `SELECT id, text FROM facts WHERE is_active AND text LIKE '%{NAME}%' ORDER BY id LIMIT 1`,
    );
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

function storageEnv(work: string) {
  return {
    STORAGE_BACKEND: "local-double",
    STORAGE_DOUBLE_DIR: path.join(work, "storage"),
    PRIVATE_OBJECT_DIR: "/acceptance-bucket/private",
    PUBLIC_OBJECT_SEARCH_PATHS: "/acceptance-bucket/public",
  };
}

/** Overwrite one stored object with bytes that are not an image (the corrupt-source control). */
function corruptStoredObject(work: string, objectPath: string): string {
  const entity = objectPath.replace(/^\/objects\//, "");
  const root = path.join(work, "storage", "data");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (full.endsWith(`/${entity}`)) {
        fs.writeFileSync(full, "this is not an image");
        return full;
      }
    }
  }
  throw new Error(`no stored object for ${objectPath}`);
}

async function journeys(cfg: InnerConfig): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: cfg.databaseUrl };
  const storage = storageEnv(cfg.work);

  if (cfg.variant === "fixture") {
    run("scripts/load-legacy-fixture.ts", { ...base, ...storage }, "loading the legacy fixture");
    out.promptPins = await pinPrompts(cfg.databaseUrl);
  }
  run("scripts/seed-e2e-test-accounts.ts", { ...base, BCRYPT_SALT_ROUNDS: "4" }, "seeding the test accounts");

  const port = cfg.serve?.port ?? (await freePort());
  const mode = cfg.mode ?? "acceptance";
  const recording = mode === "record" || mode === "live" || mode === "capture";
  const values: Record<string, string | undefined> = {
    ...base,
    ...storage,
    NODE_ENV: "development",
    PORT: String(port),
    ENABLE_DEV_ADMIN_LOGIN: "true",
    CRON_SECRET: "acceptance",
    AI_RECORDINGS_DIR: cfg.recordingsDir,
  };
  let env: NodeJS.ProcessEnv;
  let entry: string;
  if (recording) {
    Object.assign(values, {
      AI_BACKEND: "recorder",
      FAL_AI_API_KEY: process.env.FAL_AI_API_KEY || process.env.FAL_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AI_RECORDER_ALLOWANCE_USD: cfg.allowanceUsd,
      AI_RECORDER_LEDGER: cfg.callRecord,
    });
    // Capture is the recorder with reuse off, like the live check, but only the
    // AI vendors: every vendor call it makes stays inside the recorder's allowance.
    if (mode === "capture") Object.assign(values, { AI_RECORDER_LIVE: "1" });
    if (mode === "live") {
      Object.assign(values, {
        AI_RECORDER_LIVE: "1",
        PEXELS_API_KEY: process.env.PEXELS_API_KEY,
        ARACHNID_SHIELD_USERNAME: process.env.ARACHNID_SHIELD_USERNAME || undefined,
        ARACHNID_SHIELD_PASSWORD: process.env.ARACHNID_SHIELD_PASSWORD || undefined,
      });
    }
    env = constructEnvironment(mode === "live" || mode === "capture" ? LIVE_ENV_ALLOWLIST : RECORDER_ENV_ALLOWLIST, values);
    entry = "src/testing/aiRecorderLauncher.ts";
  } else {
    Object.assign(values, {
      AI_BACKEND: "recorded-double",
      AI_DOUBLE_MISS_LOG: cfg.missLog,
      AI_DOUBLE_CALL_LOG: cfg.callRecord,
      AI_DOUBLE_FAIL: cfg.aiDoubleFail,
      ...(cfg.serve ? { ALLOWED_ORIGINS: cfg.serve.origin } : {}),
    });
    env = constructEnvironment(ACCEPTANCE_ENV_ALLOWLIST, values);
    entry = "src/testing/acceptanceLauncher.ts";
  }

  const log = fs.createWriteStream(path.join(cfg.work, "server.log"));
  const server = spawn(node, ["--import", "tsx/esm", entry], { cwd: API_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.pipe(log);
  server.stderr!.pipe(log);
  try {
    await waitForPort(port, server, 120_000);
    const baseUrl = `http://127.0.0.1:${port}`;
    if (cfg.serve) {
      process.stdout.write(`[acceptance] serving on ${baseUrl}; stop with Ctrl-C\n`);
      await new Promise<void>((r) => process.once("SIGINT", () => r()).once("SIGTERM", () => r()));
      return out;
    }
    const callRecordLines = () => {
      if (!cfg.callRecord || !fs.existsSync(cfg.callRecord)) return 0;
      const text = fs.readFileSync(cfg.callRecord, "utf8").trim();
      if (!text) return 0;
      return text.startsWith("{") && text.includes('"lines"') ? (JSON.parse(text) as { lines: unknown[] }).lines.length : text.split("\n").length;
    };
    if (cfg.capture) {
      const { driveCaptures } = await import("./captureJourneys");
      out.capture = await driveCaptures(baseUrl, {
        out: cfg.capture.out,
        commit: cfg.capture.commit,
        fact: await captureFact(cfg.databaseUrl),
        log: (l) => process.stdout.write(`[capture] ${l}\n`),
      });
      return out;
    }
    const { driveBaseline } = await import("./driver");
    out.drive = await driveBaseline(baseUrl, (l) => process.stdout.write(`[journeys] ${l}\n`), {
      expectRenderFailure: cfg.control === "render-failure",
      aiCallCount: callRecordLines,
      ...(cfg.control === "corrupt-source" ? { beforeJourney4: (objectPath: string) => { out.corrupted = corruptStoredObject(cfg.work, objectPath); } } : {}),
    });
    if (mode === "live" && cfg.variant === "fixture") out.pexelsMeme = await readPexelsMeme(cfg.databaseUrl, baseUrl);
  } finally {
    server.kill("SIGTERM");
    await new Promise<void>((r) => (server.exitCode !== null ? r() : server.once("exit", () => r())));
  }
  return out;
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
  else Object.assign(result, await journeys(cfg));
  result.ok = true;
} catch (err) {
  result.ok = false;
  result.error = (err as Error).stack ?? String(err);
}
fs.writeFileSync(path.join(cfg.work, "inner-result.json"), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
