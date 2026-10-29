/**
 * Launch Phase 3, increment 8, plan amendment 1, Part A and Part C step 2
 * (docs/plans/PLAN_PHASE3_AMENDMENT_1.md): preparing production's reset refuses
 * while another session is connected; takes a final capture that restores;
 * writes, once, a case record holding every child-safety row, the rows they
 * reference and an evidence manifest, and reads it back; and stops the reset
 * when production's child-safety rows differ from dev's or evidence is
 * missing — keeping the record either way. Production is only read.
 *
 * Scratch databases built and booted in a child process, like the other
 * phase-3 database tests; the bucket is the local storage double.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "production-reset-store-"));
const LIVE = "live-bucket";
const BACKUP = "backup-bucket";
process.env.STORAGE_BACKEND = "local-double";
process.env.STORAGE_DOUBLE_DIR = ROOT;
process.env.PRIVATE_OBJECT_DIR = `/${LIVE}/private`;

const { databaseUrl } = await import("../lib/devRebuild.js");
const { prepareReset, otherSessions } = await import("../lib/productionReset.js");
const { LocalObjectStorage } = await import("../lib/localObjectStorage.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const suffix = crypto.randomBytes(3).toString("hex");
const prodName = `p3_prod_${suffix}`;
const devName = `p3_devcopy_${suffix}`;
const url = (db: string) => databaseUrl(process.env.DATABASE_URL!, db);
const storage = new LocalObjectStorage(ROOT);
const EVIDENCE = "/objects/restricted/quarantine/2026/05/case-a.jpg";

let control: pg.Pool;
let workDir: string;
let creatable = true;
let inventoried: string[] = [];

async function query<T extends pg.QueryResultRow>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const prepare = (resetId: string) =>
  prepareReset({
    productionUrl: url(prodName),
    devUrl: url(devName),
    backup: BACKUP,
    resetId,
    workDir,
    inventory: async (scratchUrl) => {
      inventoried.push(scratchUrl);
      return { verdict: { blocksReplacement: false, reasons: [] } };
    },
  });

async function stored(key: string): Promise<Buffer | null> {
  const f = storage.bucket(BACKUP).file(key);
  if (!(await f.exists())[0]) return null;
  return (await f.download())[0];
}

describe("preparing production's reset", () => {
  before(async () => {
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "production-reset-test-"));
    try {
      await control.query(`CREATE DATABASE "${prodName}" TEMPLATE template0`);
    } catch {
      creatable = false;
      return;
    }
    execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url(prodName), PGOPTIONS: "" },
      stdio: "pipe",
    });
    // Production's cases: one user, a quarantine and a pending report on the same evidence.
    await query(prodName, "INSERT INTO users (id) VALUES ('case-user')");
    await query(prodName, "INSERT INTO quarantined_memes (user_id, evidence_object_path, source) VALUES ('case-user', $1, 'classifier')", [EVIDENCE]);
    await query(prodName, "INSERT INTO ncmec_reports (match_source, evidence_uri, user_id) VALUES ('classifier', $1, 'case-user')", [EVIDENCE]);
    // Dev holds byte-identical copies, as measured on 2026-10-29.
    await control.query(`CREATE DATABASE "${devName}" TEMPLATE "${prodName}"`);
    await storage.bucket(LIVE).file("private/restricted/quarantine/2026/05/case-a.jpg").save(Buffer.from("evidence"), { resumable: false });
  });

  after(async () => {
    if (creatable) {
      const { rows } = await control.query<{ d: string }>(
        "SELECT datname AS d FROM pg_database WHERE datname = ANY($1) OR datname LIKE 'reset_capture_%'",
        [[prodName, devName]],
      );
      for (const { d } of rows) await control.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
    }
    await control.end();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("refuses while another session is connected to production, and writes nothing", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here; CI runs per-database");
    const writer = new pg.Client({ connectionString: url(prodName) });
    await writer.connect();
    try {
      assert.equal((await otherSessions(url(prodName))).length, 1);
      const report = await prepare("busy");
      assert.equal(report.verdict, "fail");
      assert.match(report.reasons[0], /1 other session\(s\) connected to production/);
      assert.equal(await stored("cases/production-reset-busy/record.json"), null);
    } finally {
      await writer.end();
    }
  });

  it("captures, records every case with what it references, and passes when dev holds the same rows", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here; CI runs per-database");
    inventoried = [];
    const report = await prepare("r1");
    assert.deepEqual(report.reasons, []);
    assert.equal(report.verdict, "pass");
    assert.equal(inventoried.length, 1, "the inventory ran on the restored capture");
    assert.deepEqual(report.childSafetyCounts, { ncmec_reports: 1, quarantined_memes: 1, ncmec_safety_audit_log: 0 });
    assert.equal(report.referencedCounts.users, 1);
    assert.deepEqual(report.evidence.map((e) => [e.path, e.present, e.size]), [[EVIDENCE, true, 8]]);

    const body = await stored("cases/production-reset-r1/record.json");
    assert.ok(body, "the case record is in the bucket");
    const { sha256, record } = JSON.parse(body.toString("utf8"));
    assert.equal(sha256, report.recordSha256);
    assert.equal(crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"), sha256);
    assert.equal(record.referenced.users[0].id, "case-user");
    assert.equal(record.childSafety.ncmec_reports[0].row.evidence_uri, EVIDENCE);
    assert.match(record.handling, /dev's rows are the authoritative handling copy/);

    const dump = await stored("cases/production-reset-r1/final-capture.dump");
    assert.equal(crypto.createHash("sha256").update(dump!).digest("hex"), report.capture!.dumpSha256);
    // Nothing left behind but the bucket's record: no scratch database, no working dump.
    assert.equal((await control.query("SELECT 1 FROM pg_database WHERE datname LIKE 'reset_capture_%'")).rowCount, 0);
    assert.deepEqual(fs.readdirSync(workDir), []);
    // Production is only read.
    assert.equal((await query<{ n: number }>(prodName, "SELECT count(*)::int AS n FROM ncmec_reports"))[0].n, 1);
  });

  it("never overwrites a case record: a reset id is used once", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await assert.rejects(prepare("r1"), (err: Error & { code?: number }) => err.code === 412);
  });

  it("stops the reset when a case has moved on one side, and keeps the record", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await query(devName, "UPDATE ncmec_reports SET last_error = 'handled on dev'");
    try {
      const report = await prepare("r2");
      assert.equal(report.verdict, "fail");
      assert.equal(report.differencesFromDev.length, 1);
      assert.equal(report.differencesFromDev[0].table, "ncmec_reports");
      assert.equal(report.differencesFromDev[0].onlyInProduction.length, 1);
      assert.equal(report.differencesFromDev[0].onlyInDev.length, 1);
      assert.match(report.reasons.join("\n"), /differ from dev's .*back to David/);
      assert.ok(await stored("cases/production-reset-r2/record.json"), "the record is kept");
    } finally {
      await query(devName, "UPDATE ncmec_reports SET last_error = NULL");
    }
  });

  it("stops the reset when evidence is missing", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await query(prodName, "UPDATE quarantined_memes SET evidence_object_path = '/objects/restricted/quarantine/2026/05/gone.jpg'");
    await query(devName, "UPDATE quarantined_memes SET evidence_object_path = '/objects/restricted/quarantine/2026/05/gone.jpg'");
    const report = await prepare("r3");
    assert.equal(report.verdict, "fail");
    assert.deepEqual(report.differencesFromDev, []);
    assert.match(report.reasons.join("\n"), /1 evidence object\(s\) missing: .*gone\.jpg/);
  });

  it("refuses a production connection that names dev's own database", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await assert.rejects(
      prepareReset({ productionUrl: url(devName), devUrl: url(devName), backup: BACKUP, resetId: "x", workDir, inventory: async () => ({}) }),
      /names dev's own database/,
    );
  });
});
