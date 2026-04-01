#!/usr/bin/env node
/**
 * db-sync-prod.mjs — copy development database → production
 *
 * Usage:
 *   PROD_URL=https://your-app.replit.app node scripts/db-sync-prod.mjs
 *
 * Requires ADMIN_API_KEY and DATABASE_URL in the current environment.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";

const execFileAsync = promisify(execFile);

const PROD_URL  = process.env.PROD_URL?.replace(/\/$/, "");
const API_KEY   = process.env.ADMIN_API_KEY;
const DEV_DB    = process.env.DATABASE_URL;

if (!PROD_URL)  { console.error("ERROR: Set PROD_URL=https://your-app.replit.app"); process.exit(1); }
if (!API_KEY)   { console.error("ERROR: ADMIN_API_KEY env var not set");             process.exit(1); }
if (!DEV_DB)    { console.error("ERROR: DATABASE_URL env var not set");              process.exit(1); }

const headers = { "x-api-key": API_KEY };

// ── Step 1: Backup production ──────────────────────────────────────────────
console.log("\n[1/3] Backing up production database…");
const backupRes = await fetch(`${PROD_URL}/api/admin/db/dump`, { headers });
if (!backupRes.ok) {
  const body = await backupRes.text();
  console.error(`FAILED (${backupRes.status}): ${body}`);
  process.exit(1);
}
const backupSql = await backupRes.text();
const backupFile = `prod-backup-${Date.now()}.sql`;
writeFileSync(backupFile, backupSql);
console.log(`✓ Production backup saved to: ${backupFile}  (${(backupSql.length / 1024).toFixed(0)} KB)`);

// ── Step 2: Dump development database ─────────────────────────────────────
console.log("\n[2/3] Dumping development database…");
const { stdout: devDump, stderr: dumpStderr } = await execFileAsync("pg_dump", [
  "--no-owner", "--no-acl", "--clean", "--if-exists",
  "--exclude-schema=stripe", "--exclude-schema=_system",
  DEV_DB,
], { maxBuffer: 50 * 1024 * 1024 });
if (dumpStderr) console.warn("pg_dump stderr:", dumpStderr.slice(0, 300));
console.log(`✓ Dev dump ready  (${(devDump.length / 1024).toFixed(0)} KB)`);

// ── Step 3: Restore to production ─────────────────────────────────────────
console.log("\n[3/3] Restoring dev dump to production…");
const restoreRes = await fetch(`${PROD_URL}/api/admin/db/restore`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "text/plain" },
  body: devDump,
});
const restoreBody = await restoreRes.json();
if (!restoreRes.ok || !restoreBody.success) {
  console.error(`FAILED (${restoreRes.status}):`, restoreBody);
  console.error(`\nYour production backup is safe in: ${backupFile}`);
  process.exit(1);
}

console.log("\n✓ Done! Production database now mirrors development.");
console.log(`  Backup of old production data: ${backupFile}`);
