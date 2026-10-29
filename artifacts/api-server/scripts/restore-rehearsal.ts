/**
 * The isolated restore rehearsal (Launch Phase 3, increment 5, #770; plan
 * docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §4, "The isolated rehearsal";
 * runbook: docs/engineering/media-backup-and-restore.md).
 *
 * Restores one completed pair — its database dump and its media — into
 * targets the live app never reads, boots the real server over them with no
 * credential of any kind, and checks access:
 *   - a public object reads, with the bytes the pair recorded;
 *   - a private object reads for its owner;
 *   - the same private object is refused to another user and to no one;
 *   - quarantined evidence stays excluded: absent from the restore and refused
 *     by the route.
 * It records the recovery time, from the start of the restore to passing
 * verification, and the data-loss bound the pair stands for.
 *
 * Targets: a scratch database `restore_rehearsal_<id>` on DATABASE_URL's
 * server (dropped afterwards unless --keep), and the media under
 * `_restores/<id>/` in --target-bucket (default: the live bucket, which dev
 * and production share; a `_restores/` prefix can never take a live object's
 * name). Restored media is left in place: no tool here deletes objects.
 *
 * Run on the Repl, where the bucket is:
 *   pnpm --filter @workspace/api-server exec tsx scripts/restore-rehearsal.ts \
 *     (--pair <pairId> [--environment <env>] | --capture [--writes-stopped]) \
 *     [--target-bucket <bucket>] [--out <report.json>] [--keep]
 *
 * `--capture` takes a pair of DATABASE_URL first (environment "development"
 * unless --environment); `--writes-stopped` records that the app's workflows
 * were stopped for it (the first rehearsal's paired capture, plan §4).
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { backupBucket, liveBucket, livePrivatePrefix } from "../src/lib/mediaBackup/config.js";
import { capturePair, readManifest, type PairManifest } from "../src/lib/mediaBackup/capture.js";
import { restorePairMedia } from "../src/lib/mediaBackup/restore.js";
import { storageClient } from "../src/lib/storageClient.js";
import { constructEnvironment, RESTORE_REHEARSAL_ENV_ALLOWLIST } from "../src/testing/launchEnvironment.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function get(port: number, urlPath: string, sid?: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: sid ? { authorization: `Bearer ${sid}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${urlPath}`)));
  });
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}) before it was healthy`);
    try {
      if ((await get(port, "/api/healthz")).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the server did not become healthy in time");
}

/** `/<bucket>/<rest>` of the live bucket, moved under the restore prefix of the target bucket. */
function relocate(dir: string, live: string, target: string, prefix: string): string {
  const parts = dir.replace(/^\/+/, "").split("/");
  if (parts[0] !== live) throw new Error(`${dir} is not in the live bucket; the rehearsal cannot relocate it`);
  return `/${target}/${prefix}/${parts.slice(1).join("/")}`.replace(/\/+$/, "");
}

/** A port the OS says is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const md5 = (b: Buffer) => crypto.createHash("md5").update(b).digest("base64");

async function main(): Promise<void> {
  if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
  const server = process.env.DATABASE_URL;
  if (!server) throw new Error("DATABASE_URL (the server the scratch database is created on) is required");
  const backup = backupBucket();
  if (!backup) throw new Error("MEDIA_BACKUP_BUCKET is not set");
  const live = liveBucket();
  if (!live) throw new Error("PRIVATE_OBJECT_DIR is not set");
  const environment = arg("environment") ?? "development";
  const targetBucket = arg("target-bucket") ?? live;
  const id = crypto.randomBytes(4).toString("hex");
  const restoreRoot = `_restores/rehearsal-${id}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "restore-rehearsal-"));
  const failures: string[] = [];
  const times: Record<string, number> = {};

  // 1. The pair.
  let manifest: PairManifest;
  if (flag("capture")) {
    const t = Date.now();
    manifest = await capturePair({ backupBucket: backup, sourceBucket: live, environment, databaseUrl: server });
    times.captureMs = Date.now() - t;
  } else {
    const pairId = arg("pair");
    if (!pairId) throw new Error("--pair <pairId> or --capture is required");
    manifest = await readManifest(backup, environment, pairId);
  }
  if (manifest.status !== "completed") throw new Error(`pair ${manifest.pairId} is ${manifest.status}: ${manifest.reasons.join("; ")}`);
  if (!manifest.database.dump) throw new Error(`pair ${manifest.pairId} has no database dump (${manifest.database.dumpError ?? "none taken"})`);

  const scratchName = `restore_rehearsal_${id}`;
  const scratch = new URL(server);
  scratch.pathname = `/${scratchName}`;
  scratch.searchParams.delete("options");
  const control = new pg.Client({ connectionString: server });
  await control.connect();
  let child: ReturnType<typeof spawn> | null = null;
  const t0 = Date.now();
  let report: Record<string, unknown> = {};
  try {
    // 2. The database, from the pair's dump, its digest checked.
    const dumpFile = path.join(work, "database.dump");
    const [dumpBytes] = await storageClient().bucket(backup).file(manifest.database.dump.key).download();
    fs.writeFileSync(dumpFile, dumpBytes);
    const digest = crypto.createHash("sha256").update(dumpBytes).digest("hex");
    if (digest !== manifest.database.dump.sha256) throw new Error(`the dump's sha256 is ${digest}, the manifest says ${manifest.database.dump.sha256}`);
    await control.query(`CREATE DATABASE "${scratchName}" TEMPLATE template0`);
    execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", scratch.href, dumpFile], { stdio: "inherit" });
    times.databaseMs = Date.now() - t0;

    // 3. The media, into the isolated prefix.
    const tm = Date.now();
    const media = await restorePairMedia(backup, manifest, { bucket: targetBucket, prefix: restoreRoot });
    // restorePairMedia puts the pair in <root>/<pairId>/; everything below reads from there.
    const prefix = `${restoreRoot}/${manifest.pairId}`;
    times.mediaMs = Date.now() - tm;

    // 4. The server, over both, with no credential.
    const tb = Date.now();
    const port = await freePort();
    const recordings = path.join(work, "no-recordings");
    fs.mkdirSync(recordings);
    const env = constructEnvironment(RESTORE_REHEARSAL_ENV_ALLOWLIST, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: scratch.href,
      NODE_ENV: "development",
      PORT: String(port),
      // The boot requires one; a fresh random value guards nothing outside this run.
      CRON_SECRET: crypto.randomBytes(16).toString("hex"),
      STORAGE_BACKEND: process.env.STORAGE_BACKEND === "local-double" ? "local-double" : undefined,
      STORAGE_DOUBLE_DIR: process.env.STORAGE_BACKEND === "local-double" ? process.env.STORAGE_DOUBLE_DIR : undefined,
      PRIVATE_OBJECT_DIR: relocate(process.env.PRIVATE_OBJECT_DIR ?? "", live, targetBucket, prefix),
      PUBLIC_OBJECT_SEARCH_PATHS: (process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => relocate(d, live, targetBucket, prefix))
        .join(","),
      AI_BACKEND: "recorded-double",
      AI_RECORDINGS_DIR: recordings,
      AI_DOUBLE_MISS_LOG: path.join(work, "ai-misses.jsonl"),
      AI_DOUBLE_CALL_LOG: path.join(work, "ai-calls.jsonl"),
    });
    const log = fs.createWriteStream(path.join(work, "server.log"));
    child = spawn(process.execPath, ["--import", "tsx/esm", "src/testing/restoreRehearsalLauncher.ts"], { cwd: API_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    await waitForHealth(port, child, 180_000);
    times.bootMs = Date.now() - tb;

    // 5. Access checks.
    const tc = Date.now();
    const db = new pg.Client({ connectionString: scratch.href });
    db.on("error", () => {});
    await db.connect();
    const privatePrefix = `${livePrivatePrefix()}/`;
    const acl = (o: PairManifest["objects"][number]) => {
      try {
        return JSON.parse(o.metadata["custom:aclPolicy"] ?? "null") as { owner: string; visibility: string } | null;
      } catch {
        return null;
      }
    };
    const served = manifest.objects.filter((o) => o.name.startsWith(privatePrefix) && o.size > 0);
    const route = (o: { name: string }) => `/api/storage/objects/${o.name.slice(privatePrefix.length)}`;
    const session = async (userId: string) => {
      const sid = crypto.randomBytes(32).toString("hex");
      await db.query("INSERT INTO sessions (sid, sess, expire, user_id) VALUES ($1, $2, now() + interval '1 hour', $3)", [
        sid,
        JSON.stringify({ user: { id: userId }, access_token: "" }),
        userId,
      ]);
      return sid;
    };
    const activeUsers = new Set((await db.query<{ id: string }>("SELECT id FROM users WHERE is_active")).rows.map((r) => r.id));
    const checks: Record<string, unknown> = {};

    const pub = served.find((o) => acl(o)?.visibility === "public");
    if (!pub) failures.push("no public object in the pair to check");
    else {
      const r = await get(port, route(pub));
      const bytesOk = pub.md5Hash ? md5(r.body) === pub.md5Hash : r.body.length === pub.size;
      checks.publicReads = { object: pub.name, status: r.status, bytesMatch: bytesOk };
      if (r.status !== 200 || !bytesOk) failures.push(`public object ${pub.name}: status ${r.status}, bytes ${bytesOk ? "match" : "differ"}`);
    }

    const priv = served.find((o) => acl(o)?.visibility === "private" && activeUsers.has(acl(o)!.owner));
    const stranger = priv ? [...activeUsers].find((u) => u !== acl(priv)!.owner) : undefined;
    if (!priv || !stranger) failures.push("no private object with an active owner, and another active user, to check");
    else {
      const owner = await get(port, route(priv), await session(acl(priv)!.owner));
      const other = await get(port, route(priv), await session(stranger));
      const anon = await get(port, route(priv));
      const bytesOk = priv.md5Hash ? md5(owner.body) === priv.md5Hash : owner.body.length === priv.size;
      checks.privateObject = { object: priv.name, owner: owner.status, ownerBytesMatch: bytesOk, otherUser: other.status, anonymous: anon.status };
      if (owner.status !== 200 || !bytesOk) failures.push(`private object: its owner got ${owner.status}`);
      if (other.status !== 403) failures.push(`private object: another user got ${other.status}, not 403`);
      if (anon.status !== 401) failures.push(`private object: no one got ${anon.status}, not 401`);
    }

    const evidence = (await db.query<{ p: string }>("SELECT evidence_object_path AS p FROM quarantined_memes WHERE evidence_object_path IS NOT NULL")).rows.map((r) => r.p);
    let evidenceRestored = 0;
    let evidenceServed = 0;
    for (const p of evidence) {
      const rest = p.replace(/^\/objects\//, "");
      const [exists] = await storageClient().bucket(targetBucket).file(`${prefix}/${privatePrefix}${rest}`).exists();
      if (exists) evidenceRestored++;
      if ((await get(port, `/api/storage/objects/${rest}`)).status !== 404) evidenceServed++;
    }
    checks.quarantinedEvidence = { rows: evidence.length, restored: evidenceRestored, served: evidenceServed };
    if (evidenceRestored > 0 || evidenceServed > 0) failures.push(`quarantined evidence: ${evidenceRestored} restored, ${evidenceServed} served`);
    await db.end();
    times.checksMs = Date.now() - tc;
    times.recoveryMs = Date.now() - t0;

    report = {
      verdict: failures.length === 0 ? "pass" : "fail",
      failures,
      pair: {
        pairId: manifest.pairId,
        environment: manifest.environment,
        window: manifest.window,
        databaseAt: manifest.database.at,
        objects: manifest.objects.length,
        captureDurationMs: manifest.durationMs,
        writesStopped: flag("writes-stopped"),
      },
      targets: { database: scratchName, media: media.target, mediaRestored: media.restored },
      checks,
      times,
      dataLossBound: {
        thisPair: "everything after the pair's window start is outside it",
        recurring: "the hourly capture: at most the interval since the latest completed pair, plus a capture's duration; read it with `media-backup.ts status`",
      },
      credentials: "none: Stripe unconfigured, no email key, the AI double with no recordings, no media backup",
    };
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2000));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (!flag("keep")) await control.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    await control.end();
    if (failures.length > 0 || Object.keys(report).length === 0) {
      const serverLog = path.join(work, "server.log");
      if (fs.existsSync(serverLog)) console.error(fs.readFileSync(serverLog, "utf8").split("\n").slice(-40).join("\n"));
    }
    fs.rmSync(work, { recursive: true, force: true });
  }

  const out = arg("out");
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exit(1);
  process.exit(0);
}

await main();
