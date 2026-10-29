/**
 * Prepares production's reset (Launch Phase 3, increment 8, plan amendment 1,
 * Part A and Part C step 2; src/lib/productionReset.ts). It reads production
 * through RESET_PRODUCTION_DATABASE_URL, the operator connection David creates
 * for the reset window and deletes after it. Production is only read.
 *
 * Run (on the Repl, with the production deployment paused):
 *   pnpm --filter @workspace/api-server exec tsx scripts/production-reset.ts check-connection
 *   pnpm --filter @workspace/api-server exec tsx scripts/production-reset.ts prepare --reset-id <id> [--out <report.json>]
 *
 * `check-connection` lists any other session on production and exits 1 if
 * there is one. `prepare` exits 0 only on `verdict: pass`: no other session,
 * a final capture that restores, an inventory that does not block, every
 * evidence object present, a case record written once and read back, and
 * child-safety rows equal to dev's. A reset id is used once: the case
 * directory is write-once, so a second prepare takes a new id.
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { backupBucket } from "../src/lib/mediaBackup/config.js";
import { otherSessions, prepareReset } from "../src/lib/productionReset.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
const productionUrl = process.env.RESET_PRODUCTION_DATABASE_URL;
if (!productionUrl) throw new Error("RESET_PRODUCTION_DATABASE_URL (David's operator connection to production) is not set");
const command = process.argv[2];

if (command === "check-connection") {
  const others = await otherSessions(productionUrl);
  process.stdout.write(`${JSON.stringify({ otherSessions: others }, null, 2)}\n`);
  process.exit(others.length === 0 ? 0 : 1);
}

if (command !== "prepare") throw new Error("usage: production-reset.ts check-connection | prepare --reset-id <id> [--out <file>]");
const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error("DATABASE_URL (dev, the handling copy) is required");
const backup = backupBucket();
if (!backup) throw new Error("MEDIA_BACKUP_BUCKET is not set");
const resetId = arg("reset-id");
if (!resetId) throw new Error("--reset-id is required");
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "production-reset-"));

let code = 1;
try {
  const report = await prepareReset({
    productionUrl,
    devUrl,
    backup,
    resetId,
    workDir,
    inventory: async (scratchUrl) =>
      JSON.parse(
        execFileSync("npx", ["tsx", "scripts/excluded-classes-inventory.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: scratchUrl, PGOPTIONS: "" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      ),
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const out = arg("out");
  if (out) fs.writeFileSync(out, text);
  process.stdout.write(text);
  code = report.verdict === "pass" ? 0 : 1;
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(code);
