/**
 * The daily maintenance run (launch Phase 14, increment 6; lib/maintenance.ts)
 * and the two cleanups it newly runs: the expired-session sweep, and the
 * retention-window job that had never once succeeded.
 *
 * Regression: `runRetentionWindowJobs` began with a DELETE from
 * `organization_invites`, a table no migration ever created, so it threw on
 * its first statement and expired tokens and old searches were never removed.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

process.env.CRON_SECRET ??= "test-cron-secret";

const { runDailyMaintenance, MAINTENANCE_JOB_NAMES } = await import("../lib/maintenance.js");
const { sweepExpiredSessions } = await import("../lib/sessionSweep.js");
const { runRetentionWindowJobs } = await import("../lib/dataLifecycle.js");
const { default: jobsRouter } = await import("../routes/jobs.js");
const { buildTestApp } = await import("./helpers/buildTestApp.js");

async function seedSession(sid: string, expire: string): Promise<void> {
  await db.execute(sql`INSERT INTO sessions (sid, sess, expire) VALUES (${sid}, '{}'::jsonb, ${sql.raw(expire)})`);
}
async function sessionExists(sid: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM sessions WHERE sid = ${sid}`);
  return r.rows.length === 1;
}

describe("the expired-session sweep", () => {
  it("deletes expired sessions, guest ones included, and keeps live ones", async () => {
    const expired = `sweep-old-${randomUUID()}`;
    const live = `sweep-live-${randomUUID()}`;
    await seedSession(expired, "now() - interval '1 day'");
    await seedSession(live, "now() + interval '1 day'");
    const result = await sweepExpiredSessions();
    assert.ok(result.deleted >= 1);
    assert.equal(await sessionExists(expired), false);
    assert.equal(await sessionExists(live), true);
  });

  it("works through a backlog in batches and stops on its budget", async () => {
    for (let i = 0; i < 5; i++) await seedSession(`sweep-batch-${i}-${randomUUID()}`, "now() - interval '1 hour'");
    const capped = await sweepExpiredSessions({ batchSize: 2, maxBatches: 1 });
    assert.deepEqual(capped, { deleted: 2, batches: 1, budgetExhausted: true });
    const rest = await sweepExpiredSessions({ batchSize: 2 });
    assert.equal(rest.budgetExhausted, false);
    assert.ok(rest.deleted >= 3);
  });
});

describe("the retention-window job", () => {
  it("runs to completion and deletes searches older than 90 days, keeping recent ones", async () => {
    const [user] = (await db.execute(sql`
      INSERT INTO users (id, email) VALUES (${randomUUID()}, ${`retention-${randomUUID()}@example.test`}) RETURNING id
    `)).rows as Array<{ id: string }>;
    await db.execute(sql`INSERT INTO search_history (user_id, query, created_at) VALUES
      (${user!.id}, 'old search', now() - interval '91 days'),
      (${user!.id}, 'new search', now() - interval '1 day')`);
    const result = await runRetentionWindowJobs();
    assert.ok(result.oldSearchHistoryDeleted >= 1);
    const left = await db.execute(sql`SELECT query FROM search_history WHERE user_id = ${user!.id}`);
    assert.deepEqual(left.rows.map((r) => (r as { query: string }).query), ["new search"]);
  });
});

describe("the daily maintenance run", () => {
  before(() => {
    delete process.env.REPLIT_DEPLOYMENT;
  });

  it("runs every job against a real database and reports each as done", async () => {
    const run = await runDailyMaintenance();
    assert.deepEqual(run.jobs.map((j) => j.job), [...MAINTENANCE_JOB_NAMES]);
    const failed = run.jobs.filter((j) => !j.ok);
    assert.deepEqual(failed, [], `failed jobs: ${JSON.stringify(failed)}`);
    assert.equal(run.ok, true);
  });

  it("records one job's failure and still runs the rest", async () => {
    const ran: string[] = [];
    const stub = (name: string) => async () => { ran.push(name); return name; };
    const jobs = Object.fromEntries(MAINTENANCE_JOB_NAMES.map((n) => [n, stub(n)]));
    jobs["retention-windows"] = async () => { throw new Error("boom"); };
    const run = await runDailyMaintenance(jobs);
    assert.equal(run.ok, false);
    const failed = run.jobs.filter((j) => !j.ok);
    assert.deepEqual(failed.map((j) => [j.job, j.error]), [["retention-windows", "boom"]]);
    assert.deepEqual(ran, MAINTENANCE_JOB_NAMES.filter((n) => n !== "retention-windows"));
  });

  it("the endpoint refuses a caller without the secret, including a wrong one of the same length", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, jobsRouter);
    assert.equal((await request(app).post("/api/jobs/maintenance")).status, 403);
    const wrong = "x".repeat(process.env.CRON_SECRET!.length);
    assert.equal((await request(app).post("/api/jobs/maintenance").set("x-cron-secret", wrong)).status, 403);
  });

  it("the endpoint runs the maintenance for the scheduled caller and answers with each job", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, jobsRouter);
    const res = await request(app).post("/api/jobs/maintenance").set("x-cron-secret", process.env.CRON_SECRET!);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.jobs.length, MAINTENANCE_JOB_NAMES.length);
  });
});
