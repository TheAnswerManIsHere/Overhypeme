/**
 * Launch Phase 3, increment 7 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §5 and §7): the dev rebuild refuses while a job is still queued, builds a
 * database from code beside the live one, carries every row across except
 * sessions, keeps every operator setting, and is exposed only by a rename that
 * refuses when the live database has moved — and that a second rename puts
 * back. A swap or an undo whose second rename fails puts the first back. A
 * table the code does not build fails the rebuild, and the failed build is
 * dropped.
 *
 * Its own scratch databases, built and booted in a child process, like the
 * other phase-3 database tests.
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

import {
  databaseUrl,
  prepareRebuild,
  swapIn,
  undoSwap,
  type RebuildReport,
} from "../lib/devRebuild.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const sourceName = `p3_dev_${crypto.randomBytes(3).toString("hex")}`;
const sourceUrl = () => databaseUrl(process.env.DATABASE_URL!, sourceName);

let control: pg.Pool;
let workDir: string;
let creatable = true;

async function query<T extends pg.QueryResultRow>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: databaseUrl(process.env.DATABASE_URL!, database) });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function exists(database: string): Promise<boolean> {
  return (await control.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount === 1;
}

describe("the dev rebuild", () => {
  let report: RebuildReport;
  let adminKey: string;

  before(async () => {
    control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-rebuild-test-"));
    try {
      await control.query(`CREATE DATABASE "${sourceName}" TEMPLATE template0`);
    } catch {
      creatable = false;
      return;
    }
    execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: sourceUrl(), PGOPTIONS: "" },
      stdio: "pipe",
    });
    // Dev's content: a user, a live session, a queued and a finished job, an operator setting.
    await query(sourceName, "INSERT INTO users (id) VALUES ('rebuild-user')");
    await query(sourceName, "INSERT INTO sessions (sid, sess, expire) VALUES ('s1', '{}', now() + interval '1 day')");
    await query(sourceName, "INSERT INTO async_jobs (queue, payload, status) VALUES ('fact_visual_concepts', '{}', 'pending'), ('q', '{\"n\":2}', 'done')");
    adminKey = (await query<{ key: string }>(sourceName, "SELECT key FROM admin_config ORDER BY key LIMIT 1"))[0].key;
    await query(sourceName, "UPDATE admin_config SET value = '7777' WHERE key = $1", [adminKey]);
    // A schema the code does not build, written at server start by stripe-replit-sync.
    await query(sourceName, "CREATE SCHEMA stripe; CREATE TABLE stripe.customers (id text PRIMARY KEY, email text); INSERT INTO stripe.customers VALUES ('cus_1', 'a@example.com')");
  });

  after(async () => {
    const { rows } = await control.query<{ d: string }>("SELECT datname AS d FROM pg_database WHERE datname LIKE $1", [`${sourceName}%`]);
    for (const { d } of rows) await control.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
    await control.end();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses while a job is still queued, naming it, and builds nothing", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here; CI runs per-database");
    const refused = await prepareRebuild({ sourceUrl: sourceUrl(), apiRoot, workDir });
    assert.equal(refused.verdict, "fail");
    assert.equal(refused.failures.length, 1);
    assert.match(refused.failures[0], /^job \d+ \(fact_visual_concepts\) is pending, next attempt .*: let the queue drain/);
    assert.equal(await exists(refused.target.database), false);
    // The worker drains it.
    await query(sourceName, "UPDATE async_jobs SET status = 'done' WHERE status = 'pending'");
  });

  it("builds from code and carries every row but sessions", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here; CI runs per-database");
    report = await prepareRebuild({ sourceUrl: sourceUrl(), apiRoot, workDir });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verdict, "pass");
    assert.equal(report.target.kept, true);
    assert.equal(report.dispositions.sessionsCleared.sessions, 1);

    const target = report.target.database;
    assert.deepEqual(await query(target, "SELECT id FROM users WHERE id = 'rebuild-user'"), [{ id: "rebuild-user" }]);
    assert.deepEqual(await query(target, "SELECT sid FROM sessions"), []);
    const jobs = await query<{ queue: string; status: string }>(target, "SELECT queue, status FROM async_jobs ORDER BY id");
    assert.deepEqual(jobs, [
      { queue: "fact_visual_concepts", status: "done" },
      { queue: "q", status: "done" },
    ]);
    assert.deepEqual(await query(target, "SELECT value FROM admin_config WHERE key = $1", [adminKey]), [{ value: "7777" }]);
    assert.deepEqual(report.schemasCarried, { stripe: 1 });
    // The child-safety audit log's append-only guards stay ALWAYS through the load.
    assert.equal((report.auditBoundary as { triggersEnabled: boolean }).triggersEnabled, true);
    const modes = await query<{ m: string }>(
      target,
      "SELECT tgenabled AS m FROM pg_trigger WHERE tgrelid = 'ncmec_safety_audit_log'::regclass AND NOT tgisinternal",
    );
    assert.deepEqual(modes.map((r) => r.m), ["A", "A"]);
    assert.deepEqual(await query(target, "SELECT id, email FROM stripe.customers"), [{ id: "cus_1", email: "a@example.com" }]);
    // The live database is only read.
    assert.equal((await query(sourceName, "SELECT count(*)::int AS n FROM sessions"))[0].n, 1);
  });

  it("refuses to swap when dev has moved since the rebuild was verified", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await query(sourceName, "INSERT INTO users (id) VALUES ('late-user')");
    await assert.rejects(
      swapIn({ sourceUrl: sourceUrl(), targetName: report.target.database, expectDigest: report.source.digest }),
      /has changed since the rebuild was verified/,
    );
    await query(sourceName, "DELETE FROM users WHERE id = 'late-user'");
  });

  it("puts dev back when the swap's second rename fails", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const fail = { beforeSecondRename: async () => Promise.reject(new Error("injected")) };
    await assert.rejects(
      swapIn({ sourceUrl: sourceUrl(), targetName: report.target.database, expectDigest: report.source.digest }, fail),
      new RegExp(`could not be renamed to ${sourceName} \\(injected\\); ${sourceName} was put back as it was`),
    );
    assert.equal((await query(sourceName, "SELECT count(*)::int AS n FROM sessions"))[0].n, 1);
    assert.equal(await exists(report.target.database), true);
  });

  it("swaps the rebuild in by renaming, keeps the old database, and undoes by renaming back", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    const swap = await swapIn({ sourceUrl: sourceUrl(), targetName: report.target.database, expectDigest: report.source.digest });
    assert.equal(swap.live, sourceName);
    assert.equal(await exists(report.target.database), false);
    assert.deepEqual(await query(sourceName, "SELECT sid FROM sessions"), []);
    assert.equal((await query(swap.previous, "SELECT count(*)::int AS n FROM sessions"))[0].n, 1);

    const fail = { beforeSecondRename: async () => Promise.reject(new Error("injected")) };
    await assert.rejects(undoSwap({ sourceUrl: sourceUrl(), previous: swap.previous }, fail), /was put back as it was/);
    assert.deepEqual(await query(sourceName, "SELECT sid FROM sessions"), []);
    assert.equal(await exists(swap.previous), true);

    const undo = await undoSwap({ sourceUrl: sourceUrl(), previous: swap.previous });
    assert.equal((await query(sourceName, "SELECT count(*)::int AS n FROM sessions"))[0].n, 1);
    assert.equal(await exists(swap.previous), false);
    assert.deepEqual(await query(undo.previous, "SELECT sid FROM sessions"), []);
  });

  it("fails on a table the code does not build, and drops its failed build", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await query(sourceName, "CREATE TABLE zz_drift (x int); INSERT INTO zz_drift VALUES (1)");
    const failed = await prepareRebuild({ sourceUrl: sourceUrl(), apiRoot, workDir });
    assert.equal(failed.verdict, "fail");
    assert.ok(failed.failures.some((f) => f.startsWith("not built by code: dev's table zz_drift")), failed.failures.join("; "));
    assert.equal(failed.target.kept, false);
    assert.equal(await exists(failed.target.database), false);
  });

  it("fails on a column the code does not build", async (t) => {
    if (!creatable) return t.skip("CREATE DATABASE is not permitted here");
    await query(sourceName, "DROP TABLE zz_drift; ALTER TABLE users ADD COLUMN zz_drift text");
    const failed = await prepareRebuild({ sourceUrl: sourceUrl(), apiRoot, workDir });
    assert.equal(failed.verdict, "fail");
    assert.ok(failed.failures.some((f) => /loading dev's rows failed: .*zz_drift/s.test(f)), failed.failures.join("; "));
    assert.equal(await exists(failed.target.database), false);
  });
});
