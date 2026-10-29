/**
 * Freeze a private snapshot of the database at DATABASE_URL, plus a manifest of
 * the stored media (Launch Phase 3, #770; plan §2 and increment 1).
 *
 * Writes, under `<PRIVATE_OBJECT_DIR>/_snapshots/<label>/<takenAt>/`:
 *   - database.dump  — `pg_dump -Fc`: schema, data and the migration ledger;
 *   - schema.sql     — `pg_dump --schema-only`, the catalog alone;
 *   - ledger.json    — the `drizzle.__drizzle_migrations` rows;
 *   - media.json     — every object in the bucket (outside `_snapshots/`) with
 *                      its size, generation, metageneration, hash, content type
 *                      and custom metadata (the ACL policy lives there);
 *   - snapshot.json  — what was taken, when, from which commit, and each
 *                      file's sha256.
 *
 * Every object is written with no ACL policy, which `canAccessObject` reads as
 * "nobody", so no app route can serve a snapshot; and with
 * `ifGenerationMatch: 0`, so nothing is ever overwritten. A snapshot is never
 * refreshed in place: a new one gets a new `takenAt`.
 *
 * `--reference-dir <dir>` also writes schema.sql and ledger.json there — the
 * historical schema-and-ledger reference increment 2 commits (no rows of
 * anyone's data are in either file).
 *
 * `--dry-run` writes everything to a local temp directory instead of the
 * bucket and skips the media manifest when no bucket is configured.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/snapshot-database.ts --label <label>
 */

import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { pgCommandConnection } from "../src/lib/pgCommandLine.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const label = arg("label");
const referenceDir = arg("reference-dir");
const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;

if (!label || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(label)) {
  console.error("--label is required: lowercase letters, digits and hyphens");
  process.exit(2);
}
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const takenAt = new Date().toISOString().replace(/[:.]/g, "-");
const work = mkdtempSync(path.join(tmpdir(), "snapshot-"));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// 1. The database, whole, and its catalog alone.
// The password travels in PGPASSWORD, so a failure's message cannot carry it.
const dumpConn = pgCommandConnection(databaseUrl);
execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", path.join(work, "database.dump"), dumpConn.url], { env: dumpConn.env });
execFileSync("pg_dump", ["--schema-only", "--no-owner", "--no-acl", "-f", path.join(work, "schema.sql"), dumpConn.url], { env: dumpConn.env });

// 2. The ledger, as rows.
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const ledger = await client.query(
  "SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id",
);
await client.end();
writeFileSync(path.join(work, "ledger.json"), `${JSON.stringify(ledger.rows, null, 2)}\n`);

// 3. The media manifest.
const privateDir = (process.env.PRIVATE_OBJECT_DIR ?? "").replace(/^\//, "").replace(/\/$/, "");
const bucketName = privateDir.split("/")[0];
let mediaCount: number | null = null;
if (bucketName) {
  const { objectStorageClient } = await import("../src/lib/objectStorage");
  const [files] = await objectStorageClient.bucket(bucketName).getFiles();
  const snapshotsPrefix = `${privateDir.slice(bucketName.length + 1)}/_snapshots/`.replace(/^\//, "");
  const media = files
    .filter((f) => !f.name.startsWith(snapshotsPrefix))
    .map((f) => ({
      name: f.name,
      size: Number(f.metadata.size ?? 0),
      generation: String(f.metadata.generation ?? ""),
      metageneration: String(f.metadata.metageneration ?? ""),
      md5Hash: f.metadata.md5Hash ?? null,
      contentType: f.metadata.contentType ?? null,
      metadata: f.metadata.metadata ?? {},
    }));
  mediaCount = media.length;
  writeFileSync(path.join(work, "media.json"), `${JSON.stringify(media, null, 2)}\n`);
} else if (!dryRun) {
  console.error("PRIVATE_OBJECT_DIR is not set; a real snapshot needs the bucket");
  process.exit(2);
}

const names = ["database.dump", "schema.sql", "ledger.json", ...(mediaCount === null ? [] : ["media.json"])];
const summary = {
  label,
  takenAt,
  gitHead: gitHead(),
  ledgerEntries: ledger.rows.length,
  mediaObjects: mediaCount,
  files: Object.fromEntries(names.map((n) => [n, sha256(path.join(work, n))])),
};
writeFileSync(path.join(work, "snapshot.json"), `${JSON.stringify(summary, null, 2)}\n`);

if (referenceDir) {
  mkdirSync(referenceDir, { recursive: true });
  copyFileSync(path.join(work, "schema.sql"), path.join(referenceDir, "schema.sql"));
  copyFileSync(path.join(work, "ledger.json"), path.join(referenceDir, "ledger.json"));
}

// 4. Store it: the bucket, or the local directory on a dry run.
if (dryRun) {
  console.log(JSON.stringify({ ...summary, storedAt: work, dryRun: true }, null, 2));
  process.exit(0);
}

const { objectStorageClient } = await import("../src/lib/objectStorage");
const bucket = objectStorageClient.bucket(bucketName);
const prefix = `${privateDir.slice(bucketName.length + 1)}/_snapshots/${label}/${takenAt}`.replace(/^\//, "");
for (const name of [...names, "snapshot.json"]) {
  await bucket.upload(path.join(work, name), {
    destination: `${prefix}/${name}`,
    // Never overwrite: a second write to the same name fails rather than
    // replacing a frozen snapshot.
    preconditionOpts: { ifGenerationMatch: 0 },
    resumable: false,
  });
}
console.log(JSON.stringify({ ...summary, storedAt: `/${bucketName}/${prefix}` }, null, 2));
process.exit(0);
