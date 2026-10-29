/**
 * The excluded-classes inventory of a database this workspace cannot reach,
 * read from its backup instead (Launch Phase 3, increment 8, #770; plan §5 and
 * §7, production step 1). Production's database is reachable only from the
 * deployment, which takes an hourly pair with a dump of exactly one snapshot
 * (src/jobs/mediaBackupJob.ts). This restores a pair's dump into a scratch
 * database on DATABASE_URL's server, runs scripts/excluded-classes-inventory.ts
 * against it, prints the report with the pair it describes, and drops the
 * scratch database. Production itself is never touched.
 *
 * Live Stripe is read as the inventory always reads it, when the live key is set.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/inventory-pair.ts \
 *     [--environment production] [--pair <pairId>] [--out <report.json>]
 * Without --pair, the latest completed pair of the environment.
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { backupBucket } from "../src/lib/mediaBackup/config.js";
import { latestCompletedPair, readManifest } from "../src/lib/mediaBackup/capture.js";
import { databaseUrl } from "../src/lib/devRebuild.js";
import { pgCommandConnection } from "../src/lib/pgCommandLine.js";
import { storageClient } from "../src/lib/storageClient.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
const server = process.env.DATABASE_URL;
if (!server) throw new Error("DATABASE_URL (the server the scratch database is created on) is required");
const backup = backupBucket();
if (!backup) throw new Error("MEDIA_BACKUP_BUCKET is not set");
const environment = arg("environment") ?? "production";
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pairId = arg("pair") ?? (await latestCompletedPair(backup, environment))?.pairId;
if (!pairId) throw new Error(`no completed ${environment} pair in ${backup}`);
const manifest = await readManifest(backup, environment, pairId);
if (!manifest.database.dump) throw new Error(`pair ${pairId} has no dump${manifest.database.dumpError ? ` (${manifest.database.dumpError})` : ""}`);

const scratchName = `inventory_pair_${crypto.randomBytes(3).toString("hex")}`;
const scratchUrl = databaseUrl(server, scratchName);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-pair-"));
const control = new pg.Client({ connectionString: server });
await control.connect();
let code = 1;
try {
  const [bytes] = await storageClient().bucket(backup).file(manifest.database.dump.key).download();
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.database.dump.sha256) throw new Error(`the dump's sha256 is ${digest}, the manifest says ${manifest.database.dump.sha256}`);
  const dumpFile = path.join(work, "database.dump");
  fs.writeFileSync(dumpFile, bytes);
  await control.query(`CREATE DATABASE "${scratchName}" TEMPLATE template0`);
  const conn = pgCommandConnection(scratchUrl);
  execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", conn.url, dumpFile], { env: conn.env, stdio: "pipe" });
  const out = execFileSync("npx", ["tsx", "scripts/excluded-classes-inventory.ts"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: scratchUrl, PGOPTIONS: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const report = { pair: { pairId, environment, databaseAt: manifest.database.at }, inventory: JSON.parse(out) };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const file = arg("out");
  if (file) fs.writeFileSync(file, text);
  process.stdout.write(text);
  code = 0;
} finally {
  await control.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
  await control.end();
  // The dump is a full copy of the environment's database: it never outlives the run.
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
