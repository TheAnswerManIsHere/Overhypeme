/**
 * Fact of the Day at most once per send period, for every instance, entry
 * point and retry (Issue #1092; jobs/factOfTheDay.ts, runDailyFactOfTheDay).
 * Against the test database with real queue rows and the real transaction,
 * since only those show a rollback. Recipients and the fact are injected; the
 * rows are written under the test key and counted, never delivered.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { asyncJobsTable, workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  currentSendMark,
  msUntilNextSend,
  factOfTheDayStep,
  runDailyFactOfTheDay,
  type DailySendDeps,
} from "../jobs/factOfTheDay.js";
import { ADVISORY_LOCK_KEYS } from "../lib/advisoryLockKeys.js";
import { lastTaskCompletion, RETRY_AFTER_FAILURE_MS, TASK_INSTANCE_ID, taskLane } from "../lib/recurringTasks.js";
import { runStepsOnce } from "../lib/taskScheduler.js";

const DOMAIN = "fotd-daily.example.test";
const recipients = ["a", "b", "c"].map((n) => ({ id: `fotd-${n}`, email: `${n}@${DOMAIN}`, displayName: null, pronouns: null }));
const NOW = new Date("2026-11-20T09:00:05Z");

function deps(over: Partial<DailySendDeps> = {}): DailySendDeps {
  return {
    now: NOW,
    fact: async () => ({ id: 1, text: "{NAME} once out-stared the sun." }),
    recipients: async () => recipients,
    insertUnderTestKey: true,
    ...over,
  };
}

async function queued(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}->>'to' LIKE ${"%@" + DOMAIN}`));
  return rows[0]!.n;
}

async function clean(): Promise<void> {
  await db.delete(asyncJobsTable).where(and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}->>'to' LIKE ${"%@" + DOMAIN}`));
  await db.delete(workerLaneHeartbeatsTable).where(and(
    eq(workerLaneHeartbeatsTable.instanceId, TASK_INSTANCE_ID),
    eq(workerLaneHeartbeatsTable.lane, taskLane("fact_of_the_day")),
  ));
}

describe("Fact of the Day, once per send period", () => {
  beforeEach(clean);
  after(clean);

  it("queues one email per recipient and writes the day's mark in the same commit; a second call queues nothing", async () => {
    assert.equal((await runDailyFactOfTheDay(deps())).outcome, "sent");
    assert.equal(await queued(), 3);
    assert.equal((await lastTaskCompletion("fact_of_the_day"))?.toISOString(), NOW.toISOString());
    assert.equal((await runDailyFactOfTheDay(deps({ now: new Date("2026-11-20T15:00:00Z") }))).outcome, "already-sent");
    assert.equal(await queued(), 3);
  });

  it("a mark that fails to write leaves nothing queued, and the next call queues the full batch once", async () => {
    await assert.rejects(runDailyFactOfTheDay(deps({ beforeMark: async () => { throw new Error("mark write failed"); } })));
    assert.equal(await queued(), 0);
    assert.equal(await lastTaskCompletion("fact_of_the_day"), null);
    assert.equal((await runDailyFactOfTheDay(deps())).outcome, "sent");
    assert.equal(await queued(), 3);
  });

  it("a send stopped part-way leaves nothing queued, and the retry queues each member once", async () => {
    let fail = true;
    const third = {
      id: "fotd-c", displayName: null, pronouns: null,
      get email(): string {
        if (fail) throw new Error("process stopped mid-send");
        return `c@${DOMAIN}`;
      },
    };
    const partWay = deps({ recipients: async () => [recipients[0]!, recipients[1]!, third] });
    await assert.rejects(runDailyFactOfTheDay(partWay));
    assert.equal(await queued(), 0, "the two queued before the stop were rolled back with it");
    fail = false;
    assert.equal((await runDailyFactOfTheDay(partWay)).outcome, "sent");
    assert.equal(await queued(), 3);
  });

  it("two calls at once queue one batch between them", async () => {
    const results = await Promise.all([runDailyFactOfTheDay(deps()), runDailyFactOfTheDay(deps())]);
    const outcomes = results.map((r) => r.outcome).sort();
    assert.ok(outcomes.includes("sent"));
    assert.equal(await queued(), 3);
  });

  it("while another instance holds the send, it reports so and queues nothing; the scheduler looks again in minutes", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEYS.factOfTheDay]);
      assert.equal((await runDailyFactOfTheDay(deps())).outcome, "another-instance-is-sending");
      assert.equal(await queued(), 0);
      const delay = await runStepsOnce({
        cadenceMs: 24 * 60 * 60 * 1000,
        nextMarkMs: () => msUntilNextSend(NOW),
        steps: [factOfTheDayStep(deps())],
      });
      assert.equal(delay, RETRY_AFTER_FAILURE_MS);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    assert.equal((await runDailyFactOfTheDay(deps())).outcome, "sent");
    assert.equal(await queued(), 3);
  });

  it("a start after 09:00 with no send recorded for today catches up; before 09:00 it waits", async () => {
    assert.equal((await runDailyFactOfTheDay(deps({ now: new Date("2026-11-19T09:00:04Z") }))).outcome, "sent");
    await clean();
    assert.equal((await runDailyFactOfTheDay(deps({ now: new Date("2026-11-19T09:00:04Z") }))).outcome, "sent");
    assert.equal((await runDailyFactOfTheDay(deps({ now: new Date("2026-11-20T08:00:00Z") }))).outcome, "already-sent");
    assert.equal((await runDailyFactOfTheDay(deps({ now: new Date("2026-11-20T09:20:00Z") }))).outcome, "sent");
  });

  it("the send period starts at the most recent 09:00 UTC, and the next is at most a day away", () => {
    assert.equal(currentSendMark(new Date("2026-11-20T08:59:59Z")).toISOString(), "2026-11-19T09:00:00.000Z");
    assert.equal(currentSendMark(new Date("2026-11-20T09:00:00Z")).toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(msUntilNextSend(new Date("2026-11-20T08:59:00Z")), 60_000);
    assert.equal(msUntilNextSend(new Date("2026-11-20T09:00:00Z")), 24 * 60 * 60 * 1000);
  });

  it("no caller reaches the raw send around the guard", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? (n === "__tests__" ? [] : walk(p)) : /\.ts$/.test(n) ? [p] : [];
    });
    for (const f of walk(SRC)) {
      assert.ok(!readFileSync(f, "utf8").includes("runFactOfTheDayJob"), `${f} names the unguarded send`);
    }
  });
});
