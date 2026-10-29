/**
 * Rebuilds the Repl's dev database from code, keeping its content (Launch
 * Phase 3, increment 7, #770; plan §5 and §7). The mechanism and its checks are
 * src/lib/devRebuild.ts; the runbook is docs/engineering/dev-rebuild.md.
 *
 *   prepare  Inventories the excluded classes, then builds a new database
 *            from code beside DATABASE_URL's, loads its rows and verifies
 *            them. Reads the live database only. Stop the app's workflows
 *            first, or the final "dev has not moved" check fails.
 *   swap     Renames the live database aside (kept) and the verified build
 *            into its name. Refuses unless the live database still holds
 *            exactly what `prepare` verified. Needs --confirm.
 *   undo     Renames them back. Needs --confirm.
 *
 * Run (on the Repl, never in a deployment):
 *   pnpm --filter @workspace/api-server exec tsx scripts/rebuild-dev.ts prepare --out /tmp/rebuild-dev.json
 *   …/rebuild-dev.ts swap --report /tmp/rebuild-dev.json --confirm
 *   …/rebuild-dev.ts undo --previous <live>_pre_rebuild_<id> --confirm
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareRebuild, swapIn, undoSwap, type RebuildReport } from "../src/lib/devRebuild.js";
import { inventoryExcludedClasses } from "../src/lib/excludedClassesInventory.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment: this rebuilds dev only");
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL (the dev database) is required");
const command = process.argv[2];
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function print(out: unknown): void {
  const text = `${JSON.stringify(out, null, 2)}\n`;
  const file = arg("out");
  if (file) fs.writeFileSync(file, text);
  process.stdout.write(text);
}

if (command === "prepare") {
  // §5 step 1: the inventory beside the capture. Live Stripe is not read here: every payment row is carried, unchanged and checked.
  const inventory = await inventoryExcludedClasses(null);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-dev-"));
  try {
    const report = await prepareRebuild({ sourceUrl, apiRoot, workDir, keepOnFail: process.argv.includes("--keep-on-fail") });
    print({ ...report, inventory });
    process.exit(report.verdict === "pass" ? 0 : 1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
} else if (command === "swap") {
  if (!process.argv.includes("--confirm")) throw new Error("swap renames the live dev database: pass --confirm");
  const file = arg("report");
  if (!file) throw new Error("--report <the prepare report> is required");
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as RebuildReport;
  if (report.verdict !== "pass" || !report.target.kept) throw new Error("that rebuild did not pass; prepare it again");
  print(await swapIn({ sourceUrl, targetName: report.target.database, expectDigest: report.source.digest }));
} else if (command === "undo") {
  if (!process.argv.includes("--confirm")) throw new Error("undo renames the live dev database: pass --confirm");
  const previous = arg("previous");
  if (!previous) throw new Error("--previous <live>_pre_rebuild_<id> is required");
  print(await undoSwap({ sourceUrl, previous }));
} else {
  throw new Error("usage: rebuild-dev.ts prepare [--out <file>] [--keep-on-fail] | swap --report <file> --confirm | undo --previous <name> --confirm");
}
process.exit(0);
