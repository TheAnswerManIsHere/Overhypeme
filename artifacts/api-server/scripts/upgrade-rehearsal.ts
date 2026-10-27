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
 *     no table disappears. The excluded classes are reported apart;
 *   - relationships resolve: no foreign key has an orphan row;
 *   - sequences are usable: every sequence-backed column's next value is above
 *     the column's largest value, so the next insert cannot collide;
 *   - operator settings are kept: every admin-owned value
 *     (lib/db/src/tableClassification.ts) reads as it did before the boot.
 *
 * A failed rehearsal is fixed in the migration or the code, never by
 * refreshing the snapshot. The acceptance journeys run separately, over the
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

import { TABLE_CLASSIFICATION, configTables } from "@workspace/db/table-classification";

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

type Counts = Map<string, number>;

async function rowCounts(c: pg.Client): Promise<Counts> {
  const { rows } = await c.query<{ t: string }>(
    "SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1",
  );
  const out: Counts = new Map();
  for (const { t } of rows) out.set(t, Number((await c.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n));
  return out;
}

/** Every admin-owned value, keyed table/key/column, honouring adminOnlyWhere. */
async function adminValues(c: pg.Client): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [table, owners] of configTables()) {
    if (owners.admin.length === 0) continue;
    const flags = Object.entries(owners.adminOnlyWhere ?? {}).map(([col, p]) => `, (${p}) AS "__admin_${col}"`);
    const { rows } = await c.query(`SELECT *${flags.join("")} FROM public."${table}"`);
    for (const r of rows) {
      const key = owners.key.map((k) => String(r[k])).join("/");
      for (const col of owners.admin) {
        if (owners.adminOnlyWhere?.[col] && r[`__admin_${col}`] !== true) continue;
        out.set(`${table}/${key}/${col}`, JSON.stringify(r[col] instanceof Date ? r[col].toISOString() : r[col] ?? null));
      }
    }
  }
  return out;
}

/** Foreign keys with at least one row whose referenced row is missing. */
async function orphans(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ name: string; child: string; parent: string; ccols: string[]; pcols: string[] }>(`
    SELECT con.conname AS name, ch.relname AS child, pa.relname AS parent,
           array_agg(ca.attname::text ORDER BY k.n) AS ccols, array_agg(pa_att.attname::text ORDER BY k.n) AS pcols
    FROM pg_constraint con
    JOIN pg_class ch ON ch.oid = con.conrelid
    JOIN pg_class pa ON pa.oid = con.confrelid
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(c, p, n)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.c
    JOIN pg_attribute pa_att ON pa_att.attrelid = con.confrelid AND pa_att.attnum = k.p
    WHERE con.contype = 'f' AND ch.relnamespace = 'public'::regnamespace
    GROUP BY con.conname, ch.relname, pa.relname`);
  const out: string[] = [];
  for (const fk of rows) {
    const notNull = fk.ccols.map((col) => `c."${col}" IS NOT NULL`).join(" AND ");
    const join = fk.ccols.map((col, i) => `p."${fk.pcols[i]}" = c."${col}"`).join(" AND ");
    const { rows: n } = await c.query(
      `SELECT count(*) AS n FROM public."${fk.child}" c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM public."${fk.parent}" p WHERE ${join})`,
    );
    if (Number(n[0].n) > 0) out.push(`${fk.child}.${fk.name}: ${n[0].n} orphan row(s)`);
  }
  return out;
}

/** Sequence-backed columns whose next value would collide with an existing row. */
async function exhaustedSequences(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ seq: string; t: string; col: string }>(`
    SELECT s.oid::regclass::text AS seq, t.relname AS t, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace`);
  const out: string[] = [];
  for (const { seq, t, col } of rows) {
    const { rows: r } = await c.query(
      `SELECT nextval($1::regclass) AS next, (SELECT max("${col}") FROM public."${t}") AS max`,
      [seq],
    );
    if (r[0].max !== null && BigInt(r[0].next) <= BigInt(r[0].max)) out.push(`${t}.${col}: next ${r[0].next} ≤ max ${r[0].max}`);
  }
  return out;
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
    execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", url.href, source.file], { stdio: "inherit" });
    const restoreMs = Date.now() - t0;

    const db = new pg.Client({ connectionString: url.href });
    db.on("error", () => {}); // the scratch database's drop ends it; the drop is ours
    await db.connect();
    const before = await rowCounts(db);
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
    for (const [table, n] of before) {
      const entry = TABLE_CLASSIFICATION[table];
      const now = counts.get(table);
      if (now === undefined) {
        failures.push(`lost: table ${table} (${n} rows) is gone`);
        continue;
      }
      const mayGrow = entry?.class === "config" || entry?.class === "runtime";
      if (mayGrow ? now < n : now !== n) failures.push(`lost: ${table} had ${n} rows, now ${now}`);
      if (entry?.class === "excluded") heldBack[entry.excluded] = (heldBack[entry.excluded] ?? 0) + now;
    }
    for (const [key, value] of settingsBefore) {
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
