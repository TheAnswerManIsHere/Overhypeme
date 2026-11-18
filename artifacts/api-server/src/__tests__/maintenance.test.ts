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

const { runDailyMaintenance, MAINTENANCE_JOB_NAMES, judgeJobResult } = await import("../lib/maintenance.js");
const { runContentPurger } = await import("../jobs/contentPurger.js");
const { runAccountDeletionWorker } = await import("../lib/accountDeletion.js");
const { runTransientRenderPurger } = await import("../jobs/transientRenderPurger.js");
const { runProvenanceRetentionPurge } = await import("../jobs/provenanceRetentionPurger.js");
const { runScheduledMediaBackup } = await import("../jobs/mediaBackupJob.js");

type JobName = (typeof MAINTENANCE_JOB_NAMES)[number];
const ZERO_PURGE = { selected: 0, purged: 0, skipped: 0, failed: 0 };
/** A good-day answer per job, in the shape each real job returns. */
const OK_RESULTS: Record<JobName, unknown> = {
  "expired-sessions": { deleted: 0, batches: 1, budgetExhausted: false },
  "expired-sign-in-states": { deleted: 0 },
  "retention-windows": { expiredEmailTokensDeleted: 0, expiredPasswordTokensDeleted: 0, oldSearchHistoryDeleted: 0, oldGenerationCostsDeleted: 0, oldWebhookAuditDeleted: 0 },
  "finished-jobs": { deleted: { email: 0 } },
  "transient-renders": { deleted: 0, retentionDays: 7, cutoff: "2026-11-11T00:00:00.000Z" },
  "image-provenance": { retentionDays: 0, deletedRecords: 0, deletedRequests: 0 },
  "rate-limit-counters": { deleted: 0, runs: 1, budgetExhausted: false },
  "content-purge": { photos: ZERO_PURGE, generated: ZERO_PURGE, memes: ZERO_PURGE },
  "account-deletion": { opened: 0, selected: 0, advanced: 0, purged: 0, held: 0, failed: 0 },
  "media-backup": "skipped: not the published deployment",
};
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

  // Q15 (David, 2026-11-18).
  it("deletes picture costs older than 13 months and webhook audit rows older than 90 days, keeping newer ones", async () => {
    const who = `retention-costs-${randomUUID()}`;
    await db.execute(sql`INSERT INTO user_generation_costs
      (user_id, job_type, endpoint_id, unit_price_at_creation, billing_units, computed_cost_usd, pricing_fetched_at, created_at) VALUES
      (${who}, 'old', 'e', 0.04, 1, 0.04, now(), now() - interval '13 months 1 day'),
      (${who}, 'new', 'e', 0.04, 1, 0.04, now(), now() - interval '12 months')`);
    const evt = `evt_retention_${randomUUID()}`;
    await db.execute(sql`INSERT INTO stripe_webhook_audit (event_id, event_type, state, created_at) VALUES
      (${evt}, 'old', 'failed', now() - interval '91 days'),
      (${evt}, 'new', 'failed', now() - interval '89 days')`);
    const result = await runRetentionWindowJobs();
    assert.ok(result.oldGenerationCostsDeleted >= 1);
    assert.ok(result.oldWebhookAuditDeleted >= 1);
    const costs = await db.execute(sql`SELECT job_type FROM user_generation_costs WHERE user_id = ${who}`);
    assert.deepEqual(costs.rows.map((r) => (r as { job_type: string }).job_type), ["new"]);
    const audit = await db.execute(sql`SELECT event_type FROM stripe_webhook_audit WHERE event_id = ${evt}`);
    assert.deepEqual(audit.rows.map((r) => (r as { event_type: string }).event_type), ["new"]);
    await db.execute(sql`DELETE FROM user_generation_costs WHERE user_id = ${who}`);
    await db.execute(sql`DELETE FROM stripe_webhook_audit WHERE event_id = ${evt}`);
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
    const stub = (name: JobName) => async () => { ran.push(name); return OK_RESULTS[name]; };
    const jobs = Object.fromEntries(MAINTENANCE_JOB_NAMES.map((n) => [n, stub(n)]));
    jobs["retention-windows"] = async () => { throw new Error("boom"); };
    const run = await runDailyMaintenance(jobs);
    assert.equal(run.ok, false);
    const failed = run.jobs.filter((j) => !j.ok);
    assert.deepEqual(failed.map((j) => [j.job, j.error]), [["retention-windows", "boom"]]);
    assert.deepEqual(ran, MAINTENANCE_JOB_NAMES.filter((n) => n !== "retention-windows"));
  });

  // Review round 1 on PR #1044: three jobs report failure in what they
  // return rather than by throwing, and the run must not call that success.
  describe("a job that reports failure in its result", () => {
    const allOk = () => Object.fromEntries(MAINTENANCE_JOB_NAMES.map((n) => [n, async () => OK_RESULTS[n]]));
    const failing: Array<[string, (typeof MAINTENANCE_JOB_NAMES)[number], unknown]> = [
      ["a content-purge row it could not purge", "content-purge", { photos: ZERO_PURGE, generated: { ...ZERO_PURGE, failed: 2 }, memes: ZERO_PURGE }],
      ["an account-deletion step that failed", "account-deletion", { opened: 0, selected: 1, advanced: 0, purged: 0, held: 0, failed: 1 }],
      ["an incomplete backup capture", "media-backup", "incomplete"],
      ["a backup that is not configured", "media-backup", "skipped: the media backup is not configured"],
      ["a backup with no storage to copy", "media-backup", "skipped: PRIVATE_OBJECT_DIR is not set"],
    ];
    for (const [what, job, result] of failing) {
      it(`fails the job and the run on ${what}, keeping the result and running the rest`, async () => {
        const ran: string[] = [];
        const runners = Object.fromEntries(MAINTENANCE_JOB_NAMES.map((n) => [n, async () => { ran.push(n); return n === job ? result : OK_RESULTS[n]; }]));
        const run = await runDailyMaintenance(runners);
        assert.equal(run.ok, false);
        const outcome = run.jobs.find((j) => j.job === job)!;
        assert.equal(outcome.ok, false);
        assert.deepEqual(outcome.result, result);
        assert.ok(outcome.error && outcome.error.length > 5, "a plain reason");
        assert.deepEqual(ran, [...MAINTENANCE_JOB_NAMES]);
        assert.ok(run.jobs.filter((j) => j.job !== job).every((j) => j.ok));
      });
    }

    const benign: Array<[string, (typeof MAINTENANCE_JOB_NAMES)[number], unknown]> = [
      ["content purged with some rows skipped", "content-purge", { photos: { ...ZERO_PURGE, skipped: 3 }, generated: ZERO_PURGE, memes: { ...ZERO_PURGE, purged: 1 } }],
      ["an account deletion on hold", "account-deletion", { opened: 0, selected: 1, advanced: 0, purged: 0, held: 1, failed: 0 }],
      ["a recent backup pair", "media-backup", "skipped: pair abc is recent"],
      ["another instance capturing", "media-backup", "skipped: another instance is capturing"],
      ["a completed capture", "media-backup", "completed"],
      ["the development server", "media-backup", "skipped: not the published deployment"],
      ["a rate-limit backlog left for tomorrow", "rate-limit-counters", { deleted: 100, runs: 10, budgetExhausted: true }],
    ];
    for (const [what, job, result] of benign) {
      it(`counts ${what} as success`, async () => {
        const runners = { ...allOk(), [job]: async () => result };
        const run = await runDailyMaintenance(runners);
        assert.equal(run.jobs.find((j) => j.job === job)!.ok, true);
        assert.equal(run.ok, true);
      });
    }
  });

  // PR #1044's build report: a judgement that looked for particular words
  // and passed anything else would let a reworded job's failures go quiet.
  describe("an answer of a shape a judgement does not recognise", () => {
    it("every job's good-day answer is recognised", () => {
      for (const job of MAINTENANCE_JOB_NAMES) assert.equal(judgeJobResult(job, OK_RESULTS[job]), null, job);
    });

    const renamed = (v: unknown): unknown => {
      if (typeof v === "string") return `${v} (reworded)`;
      const o = { ...(v as Record<string, unknown>) };
      const [first] = Object.keys(o);
      o[`${first}Renamed`] = o[first!];
      delete o[first!];
      return o;
    };
    for (const job of MAINTENANCE_JOB_NAMES) {
      it(`fails ${job} on nothing, a bare number, and its answer with a field renamed or reworded`, () => {
        for (const value of [undefined, 3, renamed(OK_RESULTS[job])]) {
          assert.ok(judgeJobResult(job, value), `${job} accepted ${JSON.stringify(value)}`);
        }
      });
    }

    it("fails the content purge when one kind's counts are missing or not numbers", () => {
      assert.ok(judgeJobResult("content-purge", { photos: ZERO_PURGE, generated: ZERO_PURGE }));
      assert.ok(judgeJobResult("content-purge", { photos: ZERO_PURGE, generated: { ...ZERO_PURGE, failed: "2" }, memes: ZERO_PURGE }));
    });

    it("fails the account deletion when its failed count is missing", () => {
      const { failed: _failed, ...rest } = OK_RESULTS["account-deletion"] as Record<string, number>;
      assert.ok(judgeJobResult("account-deletion", rest));
    });

    it("fails the run, and keeps the answer, when a job's answer is unrecognised", async () => {
      const runners = Object.fromEntries(MAINTENANCE_JOB_NAMES.map((n) => [n, async () => (n === "retention-windows" ? { deleted: 4 } : OK_RESULTS[n])]));
      const run = await runDailyMaintenance(runners);
      assert.equal(run.ok, false);
      const outcome = run.jobs.find((j) => j.job === "retention-windows")!;
      assert.equal(outcome.ok, false);
      assert.match(outcome.error!, /does not recognise/);
      assert.deepEqual(outcome.result, { deleted: 4 });
    });
  });

  describe("the real jobs' answers", () => {
    // Each job called directly against the test database: its real answer is
    // recognised, and the same answer with its failure count renamed is not.
    // Scoped to rows that do not exist, so tests sharing the database are untouched.
    const NO_ROWS = { photoPaths: [`/objects/none-${randomUUID()}`], generatedIds: [-1], memeIds: [-1] };
    const real: Array<[JobName, () => Promise<unknown>]> = [
      ["expired-sessions", () => sweepExpiredSessions()],
      ["retention-windows", () => runRetentionWindowJobs()],
      ["transient-renders", () => runTransientRenderPurger()],
      ["image-provenance", () => runProvenanceRetentionPurge()],
      ["content-purge", () => runContentPurger(NO_ROWS)],
      ["account-deletion", () => runAccountDeletionWorker({ userIds: [randomUUID()] })],
    ];
    for (const [job, call] of real) {
      it(`recognises ${job}'s real answer`, async () => {
        const result = await call();
        assert.equal(judgeJobResult(job, result), null, JSON.stringify(result));
      });
    }

    it("fails the real content purge's answer with a kind's failed count renamed", async () => {
      const result = (await runContentPurger(NO_ROWS)) as unknown as Record<string, Record<string, number>>;
      const { failed, ...rest } = result.generated!;
      assert.ok(judgeJobResult("content-purge", { ...result, generated: { ...rest, failedRows: failed } }));
    });

    it("fails the real account deletion's answer with its failed count renamed", async () => {
      const { failed, ...rest } = await runAccountDeletionWorker({ userIds: [randomUUID()] });
      assert.ok(judgeJobResult("account-deletion", { ...rest, failures: failed }));
    });

    it("judges the real media backup's unconfigured answer a failure, by name", async () => {
      const result = await runScheduledMediaBackup();
      assert.equal(result, "skipped: the media backup is not configured");
      assert.match(judgeJobResult("media-backup", result)!, /cannot run/);
    });
  });

  it("the endpoint answers 500, with each job, when a job reports failure in its result", async () => {
    // In the published deployment with no backup configured (as in tests),
    // the media backup answers that it cannot run: a real returned failure.
    process.env.REPLIT_DEPLOYMENT = "1";
    try {
      const app = buildTestApp({ kind: "unauthenticated" }, jobsRouter);
      const res = await request(app).post("/api/jobs/maintenance").set("x-cron-secret", process.env.CRON_SECRET!);
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      const backup = res.body.jobs.find((j: { job: string }) => j.job === "media-backup");
      assert.equal(backup.ok, false);
      assert.match(backup.error, /cannot run/);
    } finally {
      delete process.env.REPLIT_DEPLOYMENT;
    }
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
