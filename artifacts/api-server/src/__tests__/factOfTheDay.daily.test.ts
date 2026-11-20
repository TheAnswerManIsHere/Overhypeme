/**
 * Fact of the Day at most once per send period, across every instance and
 * every retry (Issue #1092; jobs/factOfTheDay.ts, runDailyFactOfTheDay).
 * Driven with injected lock, record and send, so no email leaves.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  currentSendMark,
  msUntilNextSend,
  runDailyFactOfTheDay,
  __resetDailySendForTest,
  type DailySendDeps,
} from "../jobs/factOfTheDay.js";

function deps(over: Partial<DailySendDeps> & { lastAt?: Date | null } = {}) {
  const calls = { sends: 0, records: 0, released: 0 };
  let last = over.lastAt ?? null;
  const d: DailySendDeps = {
    now: over.now ?? new Date("2026-11-20T09:00:05Z"),
    lock: over.lock ?? (async () => async () => { calls.released++; }),
    lastCompleted: over.lastCompleted ?? (async () => last),
    send: over.send ?? (async () => (calls.sends++, { sent: 3, skipped: 0 })),
    record: over.record ?? (async () => { calls.records++; last = d.now!; return true; }),
  };
  return { d, calls };
}

describe("Fact of the Day, once per send period", () => {
  beforeEach(() => __resetDailySendForTest());

  it("sends and records once; a second call in the same period sends nothing", async () => {
    const { d, calls } = deps();
    assert.equal(await runDailyFactOfTheDay(d), "sent");
    assert.equal(await runDailyFactOfTheDay(d), "already-sent");
    assert.deepEqual(calls, { sends: 1, records: 1, released: 2 });
  });

  it("does nothing while another instance holds the send", async () => {
    const { d, calls } = deps({ lock: async () => null });
    assert.equal(await runDailyFactOfTheDay(d), "another-instance-is-sending");
    assert.equal(calls.sends, 0);
  });

  it("a send whose completion cannot be recorded throws, and its retry only records — no second email", async () => {
    let recordOk = false;
    const { d, calls } = deps({ record: async () => (calls.records++, recordOk) });
    await assert.rejects(runDailyFactOfTheDay(d));
    recordOk = true;
    assert.equal(await runDailyFactOfTheDay(d), "sent");
    assert.equal(calls.sends, 1);
    assert.equal(calls.records, 2);
  });

  it("a send that failed before emailing anyone is retried in full", async () => {
    let fail = true;
    const { d, calls } = deps({ send: async () => { if (fail) throw new Error("db down"); calls.sends++; return { sent: 1, skipped: 0 }; } });
    await assert.rejects(runDailyFactOfTheDay(d));
    assert.equal(calls.records, 0);
    fail = false;
    assert.equal(await runDailyFactOfTheDay(d), "sent");
    assert.equal(calls.sends, 1);
  });

  it("a start after 09:00 with no send recorded for today catches up; before 09:00 it waits", async () => {
    const yesterday = new Date("2026-11-19T09:00:04Z");
    const late = deps({ now: new Date("2026-11-20T09:20:00Z"), lastAt: yesterday });
    assert.equal(await runDailyFactOfTheDay(late.d), "sent");
    const early = deps({ now: new Date("2026-11-20T08:00:00Z"), lastAt: yesterday });
    assert.equal(await runDailyFactOfTheDay(early.d), "already-sent");
    assert.equal(early.calls.sends, 0);
  });

  it("the send period starts at the most recent 09:00 UTC, and the next is at most a day away", () => {
    assert.equal(currentSendMark(new Date("2026-11-20T08:59:59Z")).toISOString(), "2026-11-19T09:00:00.000Z");
    assert.equal(currentSendMark(new Date("2026-11-20T09:00:00Z")).toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(msUntilNextSend(new Date("2026-11-20T08:59:00Z")), 60_000);
    assert.equal(msUntilNextSend(new Date("2026-11-20T09:00:00Z")), 24 * 60 * 60 * 1000);
  });
});
