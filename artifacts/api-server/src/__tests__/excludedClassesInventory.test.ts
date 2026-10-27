/**
 * Launch Phase 3, increment 1 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §5): the excluded-classes inventory counts each class, reads nothing it should
 * not, and its verdict follows the plan's two rules — child-safety rows require a
 * carry-forward but do not block; a live-mode payment inventory that is positive
 * or incomplete blocks the replacement.
 *
 * Counts are asserted as deltas over a baseline taken first, so rows other tests
 * leave in the shared database cannot make this flaky.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, sessionsTable, asyncJobsTable, quarantinedMemesTable } from "@workspace/db/schema";
import { inArray, like, sql } from "drizzle-orm";

import { inventoryExcludedClasses } from "../lib/excludedClassesInventory.js";

const PREFIX = "t_p3i1_";
const adminId = `${PREFIX}${randomUUID()}`;
const userId = `${PREFIX}${randomUUID()}`;
const sids = [`${PREFIX}s1`, `${PREFIX}s2`, `${PREFIX}s3`];

const noLiveKey = null;
const cleanLive = async () => ({ obligatingSubscriptions: {} });

async function cleanUp() {
  await db.delete(sessionsTable).where(inArray(sessionsTable.sid, sids));
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${PREFIX}%`));
  await db.delete(quarantinedMemesTable).where(like(quarantinedMemesTable.evidenceObjectPath, `${PREFIX}%`));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, userId]));
}

describe("excluded-classes inventory", () => {
  let base: Awaited<ReturnType<typeof inventoryExcludedClasses>>;
  const now = new Date();
  const future = new Date(now.getTime() + 3_600_000);
  const past = new Date(now.getTime() - 3_600_000);

  before(async () => {
    await cleanUp();
    base = await inventoryExcludedClasses(cleanLive, now);
    await db.insert(usersTable).values([
      { id: adminId, email: `${adminId}@example.test`, isAdmin: true },
      { id: userId, email: `${userId}@example.test` },
    ]);
    await db.insert(sessionsTable).values([
      { sid: sids[0], sess: {}, expire: future, userId: adminId },
      { sid: sids[1], sess: {}, expire: future, userId: null },
      { sid: sids[2], sess: {}, expire: past, userId },
    ]);
    await db.insert(asyncJobsTable).values([
      { queue: `${PREFIX}q`, payload: {}, status: "pending" },
      { queue: `${PREFIX}q`, payload: {}, status: "processing" },
      { queue: `${PREFIX}q`, payload: {}, status: "done" },
    ]);
  });

  after(cleanUp);

  it("counts unexpired sessions, those with a user, and those held by an admin", async () => {
    const r = await inventoryExcludedClasses(cleanLive, now);
    assert.equal(r.sessions.total - base.sessions.total, 3);
    assert.equal(r.sessions.unexpired - base.sessions.unexpired, 2);
    assert.equal(r.sessions.unexpiredWithUser - base.sessions.unexpiredWithUser, 1);
    assert.equal(r.sessions.unexpiredAdmin - base.sessions.unexpiredAdmin, 1);
    assert.equal(r.verdict.cleanupRequired, true);
  });

  it("counts only pending and processing jobs, never terminal ones", async () => {
    const r = await inventoryExcludedClasses(cleanLive, now);
    assert.equal(r.nonTerminalJobs.total - base.nonTerminalJobs.total, 2);
    assert.equal(r.nonTerminalJobs.byQueueAndStatus[`${PREFIX}q/pending`], 1);
    assert.equal(r.nonTerminalJobs.byQueueAndStatus[`${PREFIX}q/processing`], 1);
    assert.equal(r.nonTerminalJobs.byQueueAndStatus[`${PREFIX}q/done`], undefined);
  });

  it("requires a carry-forward when a child-safety row exists, without blocking on it", async () => {
    await db.insert(quarantinedMemesTable).values({
      evidenceObjectPath: `${PREFIX}restricted/quarantine/x`,
      source: "classifier",
    });
    try {
      const r = await inventoryExcludedClasses(cleanLive, now);
      assert.equal(r.childSafety.quarantinedMemes - base.childSafety.quarantinedMemes, 1);
      assert.equal(r.verdict.carryForwardRequired, true);
      assert.equal(r.verdict.blocksReplacement, false);
    } finally {
      await db.delete(quarantinedMemesTable).where(like(quarantinedMemesTable.evidenceObjectPath, `${PREFIX}%`));
    }
  });

  it("blocks when live-mode Stripe could not be read: no key configured", async () => {
    const r = await inventoryExcludedClasses(noLiveKey, now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.equal(r.verdict.blocksReplacement, true);
    assert.ok(r.verdict.reasons.some((s) => s.startsWith("BLOCKS: live-mode Stripe inventory incomplete")));
  });

  it("blocks when the live-mode read fails", async () => {
    const r = await inventoryExcludedClasses(async () => { throw new Error("network down"); }, now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when live mode still holds an obligating subscription", async () => {
    const r = await inventoryExcludedClasses(async () => ({ obligatingSubscriptions: { active: 2 } }), now);
    assert.equal(r.verdict.blocksReplacement, true);
    assert.ok(r.verdict.reasons.some((s) => s.includes("2 live-mode subscription")));
  });

  it("does not block on payments when live mode was read and holds nothing", async () => {
    const r = await inventoryExcludedClasses(cleanLive, now);
    assert.equal(r.payments.liveStripe.checked, true);
    assert.equal(r.verdict.blocksReplacement, false);
  });

  it("runs read-only: a write attempted inside its transaction is refused", async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        await tx.execute(sql`DELETE FROM sessions WHERE sid = ${sids[0]}`);
      }),
      (err: Error & { cause?: Error }) => /read-only transaction/.test(err.cause?.message ?? err.message),
    );
  });
});
