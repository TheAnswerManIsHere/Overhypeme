/**
 * Adopts production's first database with proof (Launch Phase 3, increment 8,
 * plan amendment 2; src/lib/productionAdopt.ts). Run once, on David's go,
 * after Replit's publish has copied dev's structure into the new production
 * database and the server refuses at boot ("Refusing to migrate: … records no
 * migrations"). It reads production through RESET_PRODUCTION_DATABASE_URL.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/production-adopt.ts [--out <report.json>]
 *
 * Exit 0 only when production was adopted. Anything else refused and changed
 * nothing; the report says why, with a three-way diagnosis on a structural
 * difference.
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import fs from "node:fs";

import { adoptProduction } from "../src/lib/productionAdopt.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
const productionUrl = process.env.RESET_PRODUCTION_DATABASE_URL;
if (!productionUrl) throw new Error("RESET_PRODUCTION_DATABASE_URL (David's operator connection to production) is not set");
const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error("DATABASE_URL (dev; its server hosts the reference) is required");
if (new URL(productionUrl).host === new URL(devUrl).host) throw new Error("RESET_PRODUCTION_DATABASE_URL names dev's own server");

const report = await adoptProduction({ productionUrl, devUrl });
const text = `${JSON.stringify(report, null, 2)}\n`;
const out = arg("out");
if (out) fs.writeFileSync(out, text);
process.stdout.write(text);
process.exit(report.verdict === "adopted" ? 0 : 1);
