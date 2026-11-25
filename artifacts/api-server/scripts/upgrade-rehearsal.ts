/**
 * The upgrade rehearsal (Launch Phase 3, increment 4, #770; plan
 * docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §2): proves that a real database
 * — the frozen snapshot of dev taken in increment 1, before this phase changed
 * anything — upgrades under the current code without losing anything.
 *
 * It restores the snapshot's dump into an isolated scratch database on
 * DATABASE_URL's server, records what it holds, runs the server's database
 * boot (scripts/boot-database.ts: migrations, ensureSchema, the engine
 * catalogue), and asserts:
 *
 *   - nothing is lost: every product and excluded-class table keeps its exact
 *     row count; configuration and runtime tables may only gain rows (seeds);
 *     no table disappears. The excluded classes are reported apart. The one
 *     declared exception is migration 0142's deletion of retired variants:
 *     the rows it will delete are counted per table from the restored snapshot
 *     before the boot (src/lib/retirementLosses.ts), each such table must
 *     then hold exactly that many fewer, and the report lists them under
 *     `intendedDeletions`, apart from `failures`. Migration 0149's deletion of
 *     the retired review_duplicate_threshold setting is declared the same way
 *     (RETIRED_ADMIN_CONFIG_KEYS): its row is expected gone and every other
 *     setting is still compared. Migration 0160's taxonomy drops are declared
 *     too: its deleted jobs counted the same way, and the three tables it
 *     drops whole named in RETIRED_TABLES, each expected gone and reported
 *     under `intendedTableDrops`; and 3.2e's (0167's table, 0169's jobs) and
 *     0170's (the eval_runs table) the same way;
 *   - relationships resolve: no foreign key has an orphan row;
 *   - sequences are usable: every sequence-backed column's next value is above
 *     the column's largest value, so the next insert cannot collide;
 *   - operator settings are kept: every admin-owned value
 *     (lib/db/src/tableClassification.ts) reads as it did before the boot.
 *
 * A failed rehearsal is fixed in the migration or the code, never by
 * refreshing the snapshot, and an intended deletion is declared by name and
 * counted from the snapshot, never excused after the fact. The acceptance journeys run separately, over the
 * same dump: `acceptance-run.ts --source-dump <file>`.
 *
 * It never touches DATABASE_URL's own database: the dump is restored into a
 * new database it creates, and drops afterwards unless --keep.
 *
 * Run (on the Repl, where the bucket is):
 *   pnpm --filter @workspace/api-server exec tsx scripts/upgrade-rehearsal.ts \
 *     [--label phase3-frozen-dev] [--dump <local database.dump>] [--out <report.json>] [--keep]
 *   …/upgrade-rehearsal.ts --download-only <file>   (the dump alone, for the journeys)
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { TABLE_CLASSIFICATION } from "@workspace/db/table-classification";
import { adminValues, exhaustedSequences, orphans, rowCounts } from "../src/lib/databaseChecks.js";
import { pgCommandConnection } from "../src/lib/pgCommandLine.js";
import {
  RETIRED_TABLES,
  aiMemeBackfillDropLosses,
  isRetiredSettingValue,
  mergeLosses,
  refreshRetirementLosses,
  retiredSettingLosses,
  taxonomyDropLosses,
  variantRetirementLosses,
} from "../src/lib/retirementLosses.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** The newest database.dump under _snapshots/<label>/ in the private bucket, downloaded. */
async function downloadSnapshot(label: string, into: string): Promise<{ file: string; object: string }> {
  const privateDir = (process.env.PRIVATE_OBJECT_DIR ?? "").replace(/^\//, "").replace(/\/$/, "");
  const bucketName = privateDir.split("/")[0];
  if (!bucketName) throw new Error("PRIVATE_OBJECT_DIR is not set; pass --dump <file> instead");
  const { objectStorageClient } = await import("../src/lib/objectStorage.js");
  const prefix = `${privateDir.slice(bucketName.length + 1)}/_snapshots/${label}/`.replace(/^\//, "");
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix });
  const dumps = files.filter((f) => f.name.endsWith("/database.dump")).map((f) => f.name).sort();
  if (dumps.length === 0) throw new Error(`no database.dump under /${bucketName}/${prefix}`);
  const object = dumps[dumps.length - 1];
  const file = path.join(into, "database.dump");
  await objectStorageClient.bucket(bucketName).file(object).download({ destination: file });
  return { file, object: `/${bucketName}/${object}` };
}

async function main(): Promise<void> {
  if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Refusing to run in a deployment");
  const server = process.env.DATABASE_URL;
  if (!server) throw new Error("DATABASE_URL (the server the scratch database is created on) is required");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-rehearsal-"));
  const label = arg("label") ?? "phase3-frozen-dev";
  const downloadOnly = arg("download-only");
  if (downloadOnly) {
    // For the journeys: acceptance-run.ts --source-dump reads a local file.
    const { file, object } = await downloadSnapshot(label, work);
    fs.copyFileSync(file, downloadOnly);
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`[upgrade-rehearsal] ${object} → ${downloadOnly}`);
    return;
  }
  const source = arg("dump") ? { file: path.resolve(arg("dump")!), object: path.resolve(arg("dump")!) } : await downloadSnapshot(label, work);

  const scratchName = `upgrade_rehearsal_${crypto.randomBytes(3).toString("hex")}`;
  const url = new URL(server);
  url.pathname = `/${scratchName}`;
  // Keep connection settings (sslmode); drop only the test runner's schema-isolation options.
  url.searchParams.delete("options");
  const control = new pg.Client({ connectionString: server });
  await control.connect();
  const failures: string[] = [];
  let report: Record<string, unknown> = {};
  try {
    await control.query(`CREATE DATABASE "${scratchName}" TEMPLATE template0`);
    const t0 = Date.now();
    // The password travels in PGPASSWORD, so a failure's message cannot carry it.
    const restoreConn = pgCommandConnection(url.href);
    execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", restoreConn.url, source.file], { stdio: "inherit", env: restoreConn.env });
    const restoreMs = Date.now() - t0;

    const db = new pg.Client({ connectionString: url.href });
    db.on("error", () => {}); // the scratch database's drop ends it; the drop is ours
    await db.connect();
    const before = await rowCounts(db);
    // Intended deletions, counted before they run: migration 0142's retired
    // variants, 0151's retired refresh and resubmission reviews, and the
    // admin_config rows of settings a migration retires (0149, 0160), and the
    // jobs 0160 and 0169 delete. The tables 0160, 0167 and 0170 drop whole are
    // RETIRED_TABLES.
    const intended = mergeLosses(
      await variantRetirementLosses(db),
      await refreshRetirementLosses(db),
      await retiredSettingLosses(db),
      await taxonomyDropLosses(db),
      await aiMemeBackfillDropLosses(db),
    );
    const settingsBefore = await adminValues(db);
    const ledgerBefore = Number((await db.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);
    await db.end();

    const t1 = Date.now();
    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url.href, PGOPTIONS: "" },
      stdio: "inherit",
    });
    const bootMs = Date.now() - t1;

    const after = new pg.Client({ connectionString: url.href });
    after.on("error", () => {});
    await after.connect();
    const counts = await rowCounts(after);
    const settingsAfter = await adminValues(after);
    const ledgerAfter = Number((await after.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);

    const heldBack: Record<string, number> = {};
    const droppedTables: Record<string, number> = {};
    for (const [table, n] of before) {
      const entry = TABLE_CLASSIFICATION[table];
      const now = counts.get(table);
      if (now === undefined && RETIRED_TABLES.includes(table)) {
        droppedTables[table] = n;
        continue;
      }
      if (now === undefined) {
        failures.push(`lost: table ${table} (${n} rows) is gone`);
        continue;
      }
      const mayGrow = entry?.class === "config" || entry?.class === "runtime";
      const deleted = intended.get(table) ?? 0;
      const expected = n - deleted;
      if (mayGrow ? now < expected : now !== expected) {
        failures.push(`lost: ${table} had ${n} rows, now ${now}${deleted ? ` (${deleted} intended deletions, so ${expected} expected)` : ""}`);
      }
      if (entry?.class === "excluded") heldBack[entry.excluded] = (heldBack[entry.excluded] ?? 0) + now;
    }
    for (const [key, value] of settingsBefore) {
      // A retired setting is expected gone; it is listed under intendedDeletions.
      if (isRetiredSettingValue(key)) {
        if (settingsAfter.has(key)) failures.push(`setting: ${key} was retired but is still present`);
        continue;
      }
      if (settingsAfter.get(key) !== value) failures.push(`setting: ${key} was ${value}, now ${settingsAfter.get(key) ?? "absent"}`);
    }
    failures.push(...(await orphans(after)).map((o) => `relationship: ${o}`));
    failures.push(...(await exhaustedSequences(after)).map((s) => `sequence: ${s}`));
    await after.end();

    report = {
      snapshot: source.object,
      verdict: failures.length === 0 ? "pass" : "fail",
      failures,
      restoreMs,
      bootMs,
      ledger: { before: ledgerBefore, after: ledgerAfter },
      tables: { before: before.size, after: counts.size, new: [...counts.keys()].filter((t) => !before.has(t)) },
      rows: {
        before: [...before.values()].reduce((a, b) => a + b, 0),
        after: [...counts.values()].reduce((a, b) => a + b, 0),
      },
      heldBack,
      intendedDeletions: Object.fromEntries(intended),
      intendedTableDrops: droppedTables,
      settingsChecked: settingsBefore.size,
    };
  } finally {
    if (!process.argv.includes("--keep")) await control.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await control.end();
    fs.rmSync(work, { recursive: true, force: true });
  }

  const out = arg("out");
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exit(1);
}

await main();
