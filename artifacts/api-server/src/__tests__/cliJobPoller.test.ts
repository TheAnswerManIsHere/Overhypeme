/**
 * Unit tests for the shared CLI poll-to-terminal helper (cliJobPoller.ts),
 * used by the three bulk-backfill CLI scripts.
 *
 *   • terminal reporting: done → succeeded, done+{skipped:true} → skipped,
 *     failed → failed
 *   • a job that resolves mid-poll (not on the first check) is picked up on
 *     a later round
 *   • zero-progress stall ceiling: gives up once no job resolves for the
 *     configured window, returning the still-pending jobs as unresolved —
 *     this is a STALL ceiling, not a fixed total-duration cap, so it must
 *     NOT fire just because the batch is taking a while as long as jobs keep
 *     resolving
 *   • never logs a raw job/fact id — only each job's human-readable label
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

import { pollJobsToTerminal, type PollableJob } from "../lib/cliJobPoller.js";

const QUEUE = "t_cli_poller_test";
const insertedJobIds: number[] = [];

async function insertJob(status: "pending" | "done" | "failed", result?: unknown, lastError?: string): Promise<number> {
  const [row] = await db
    .insert(asyncJobsTable)
    .values({ queue: QUEUE, payload: {}, status, result: result ?? null, lastError: lastError ?? null })
    .returning({ id: asyncJobsTable.id });
  insertedJobIds.push(row!.id);
  return row!.id;
}

async function setStatus(jobId: number, status: "pending" | "done" | "failed", result?: unknown): Promise<void> {
  await db.update(asyncJobsTable).set({ status, result: result ?? null }).where(eq(asyncJobsTable.id, jobId));
}

after(async () => {
  if (insertedJobIds.length) await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, insertedJobIds));
});

describe("pollJobsToTerminal", () => {
  it("tallies done/skipped/failed jobs that are already terminal on the first check", async () => {
    const okId = await insertJob("done");
    const skippedId = await insertJob("done", { skipped: true, reason: "not_active" });
    const failedId = await insertJob("failed", null, "boom\nstack trace line 2");

    const jobs: PollableJob[] = [
      { jobId: okId, label: "fact A preview" },
      { jobId: skippedId, label: "fact B preview" },
      { jobId: failedId, label: "fact C preview" },
    ];
    const logs: string[] = [];
    const result = await pollJobsToTerminal(jobs, { pollIntervalMs: 10, log: (m) => logs.push(m) });

    assert.equal(result.succeeded, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.unresolved.length, 0);

    // Never surface a raw numeric id in operator-facing log lines — only the label.
    for (const log of logs) {
      assert.ok(!log.includes(String(okId)), "log line must not contain the raw job id");
      assert.ok(!log.includes(String(skippedId)), "log line must not contain the raw job id");
      assert.ok(!log.includes(String(failedId)), "log line must not contain the raw job id");
    }
    assert.ok(logs.some((l) => l.includes("fact A preview") && l.includes("[OK]")));
    assert.ok(logs.some((l) => l.includes("fact B preview") && l.includes("[SKIPPED]")));
    assert.ok(logs.some((l) => l.includes("fact C preview") && l.includes("[FAILED]") && l.includes("boom")));
    // Only the FIRST line of a multi-line error is surfaced.
    assert.ok(!logs.some((l) => l.includes("stack trace line 2")));
  });

  it("picks up a job that resolves on a later poll round, not just the first check", async () => {
    const jobId = await insertJob("pending");
    const jobs: PollableJob[] = [{ jobId, label: "slow fact" }];

    // Flip it to done shortly after polling starts, on its own timer —
    // simulates a real worker finishing mid-poll.
    setTimeout(() => { void setStatus(jobId, "done"); }, 30);

    const result = await pollJobsToTerminal(jobs, { pollIntervalMs: 10, stallCeilingMs: 2000 });
    assert.equal(result.succeeded, 1);
    assert.equal(result.unresolved.length, 0);
  });

  it("gives up after the zero-progress stall ceiling and reports the job as unresolved", async () => {
    const jobId = await insertJob("pending");
    const jobs: PollableJob[] = [{ jobId, label: "stuck fact" }];
    const logs: string[] = [];

    const result = await pollJobsToTerminal(jobs, { pollIntervalMs: 10, stallCeilingMs: 50, log: (m) => logs.push(m) });
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]!.label, "stuck fact");
    assert.ok(logs.some((l) => l.includes("STALLED")));
  });

  it("a healthy batch that keeps resolving (one every poll) never trips the stall ceiling, even past it in wall-clock time", async () => {
    const jobA = await insertJob("pending");
    const jobB = await insertJob("pending");
    const jobs: PollableJob[] = [{ jobId: jobA, label: "fact A" }, { jobId: jobB, label: "fact B" }];

    // Each GAP between resolutions stays comfortably under the stall
    // ceiling, but the batch's TOTAL wall-clock span exceeds it — proving
    // this is a zero-progress ceiling, not a fixed total-duration cap.
    //
    // TIMINGS ARE DELIBERATELY GENEROUS. The invariant needs two properties to
    // hold at once — each gap under the ceiling, and the total over it — and
    // the earlier values (25/90 against an 80ms ceiling) left the gap just
    // **15ms** of headroom. That has to absorb a real Postgres UPDATE plus a
    // poll tick, on a CI runner sharing one database container across four
    // shards. It held locally and failed repeatedly in CI, latterly on every
    // run (issue #508). Scaled ~8x so both margins are ~100ms; the assertions
    // and the property under test are unchanged, and the cost is about half a
    // second. Do not tighten these to speed the suite up — a failure here
    // reads as a real regression in the poller and burns a diagnosis.
    setTimeout(() => { void setStatus(jobA, "done"); }, 200);
    setTimeout(() => { void setStatus(jobB, "done"); }, 600);

    const result = await pollJobsToTerminal(jobs, { pollIntervalMs: 25, stallCeilingMs: 500 });
    assert.equal(result.succeeded, 2, "a serialized-lane batch making steady progress must not be prematurely abandoned");
    assert.equal(result.unresolved.length, 0);
  });

  it("empty job list resolves immediately with zero tallies", async () => {
    const result = await pollJobsToTerminal([]);
    assert.deepEqual(result, { succeeded: 0, skipped: 0, failed: 0, unresolved: [] });
  });
});
