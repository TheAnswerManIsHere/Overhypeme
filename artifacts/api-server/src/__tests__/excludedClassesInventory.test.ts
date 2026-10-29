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

import {
  createLiveStripeReader,
  inventoryExcludedClasses,
  type LiveStripeClient,
} from "../lib/excludedClassesInventory.js";

const PREFIX = "t_p3i1_";
const adminId = `${PREFIX}${randomUUID()}`;
const userId = `${PREFIX}${randomUUID()}`;
const sids = [`${PREFIX}s1`, `${PREFIX}s2`, `${PREFIX}s3`];

const noLiveKey = null;
const ACCOUNT = "acct_live_expected";
const cleanLive = async () => ({
  accountId: ACCOUNT,
  livemode: true as const,
  obligatingSubscriptions: {},
  unrefundedPayments: 0,
  fullyRefundedPayments: 0,
  notThisApp: { subscriptions: 0, payments: [] },
});

async function* items<T>(list: T[], failAfter?: number): AsyncGenerator<T> {
  let i = 0;
  for (const item of list) {
    if (failAfter !== undefined && i === failAfter) throw new Error("page 2 failed");
    yield item;
    i += 1;
  }
}

function stubClient(opts: {
  accountId?: string;
  livemode?: boolean;
  subscriptions?: Array<{ status: string; metadata?: Record<string, string>; customer?: { metadata?: Record<string, string> } | string }>;
  payments?: Array<{
    status: string;
    latest_charge?: { refunded?: boolean } | string | null;
    metadata?: Record<string, string>;
    customer?: { metadata?: Record<string, string> } | string;
    description?: string;
  }>;
  paymentsFailAfter?: number;
}): LiveStripeClient {
  return {
    accounts: { retrieve: async () => ({ id: opts.accountId ?? ACCOUNT }) },
    balance: { retrieve: async () => ({ livemode: opts.livemode ?? true }) },
    subscriptions: { list: () => items(opts.subscriptions ?? []) },
    paymentIntents: {
      list: () =>
        items(
          (opts.payments ?? []).map((p, i) => ({ id: `pi_${i}`, amount: 14500, currency: "usd", ...p })),
          opts.paymentsFailAfter,
        ),
    },
  };
}

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

  it("counts usable auth tokens and OAuth states as auth state to purge, not used or expired ones", async () => {
    await db.execute(sql`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES
      (${userId}, ${`${PREFIX}pr1`}, ${future.toISOString()}::timestamptz),
      (${userId}, ${`${PREFIX}pr2`}, ${past.toISOString()}::timestamptz)`);
    try {
      const r = await inventoryExcludedClasses(cleanLive, now);
      assert.equal(r.authState.unusedPasswordResetTokens - base.authState.unusedPasswordResetTokens, 1);
      assert.equal(r.verdict.cleanupRequired, true);
      assert.ok(r.verdict.reasons.some((s) => s.includes("usable auth token")));
    } finally {
      await db.execute(sql`DELETE FROM password_reset_tokens WHERE token_hash LIKE ${`${PREFIX}%`}`);
    }
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
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(stubClient({
          subscriptions: [
            { status: "active", customer: { metadata: { userId: "u1" } } },
            { status: "active", metadata: { app: "overhype" } },
            { status: "canceled", metadata: { app: "overhype" } },
          ],
        }), ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"),
      now,
    );
    assert.equal(r.verdict.blocksReplacement, true);
    assert.ok(r.verdict.reasons.some((s) => s.includes("2 live-mode subscription")));
  });

  it("reports live objects this app did not create, without blocking on them", async () => {
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(
        stubClient({
          subscriptions: [{ status: "active", customer: { metadata: {} } }],
          payments: [
            { status: "succeeded", latest_charge: { refunded: false }, description: "AVAILERON CONSULTING" },
            { status: "succeeded", latest_charge: { refunded: false }, customer: "cus_unexpanded" },
          ],
        }),
        ACCOUNT,
        "STRIPE_ACCOUNT_ID_LIVE",
      ),
      now,
    );
    assert.ok(r.payments.liveStripe.checked);
    if (r.payments.liveStripe.checked) {
      assert.equal(r.payments.liveStripe.unrefundedPayments, 0);
      assert.deepEqual(r.payments.liveStripe.obligatingSubscriptions, {});
      assert.equal(r.payments.liveStripe.notThisApp.subscriptions, 1);
      assert.deepEqual(r.payments.liveStripe.notThisApp.payments.map((p) => p.id), ["pi_0", "pi_1"]);
    }
    assert.equal(r.verdict.blocksReplacement, false);
    assert.ok(r.verdict.reasons.some((s) => s.startsWith("not this app's (does not block): 1 subscription(s), 2 payment(s): pi_0 14500 usd \"AVAILERON CONSULTING\"")));
  });

  it("does not block on payments when live mode was read and holds nothing", async () => {
    const r = await inventoryExcludedClasses(cleanLive, now);
    assert.equal(r.payments.liveStripe.checked, true);
    assert.equal(r.verdict.blocksReplacement, false);
  });

  it("blocks on a lifetime purchase even with no subscription and no local entitlement", async () => {
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(stubClient({ payments: [{ status: "succeeded", latest_charge: { refunded: false }, metadata: { membership: "true", userId: "u1" } }] }), ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"),
      now,
    );
    assert.equal(r.payments.liveStripe.checked, true);
    assert.equal(r.verdict.blocksReplacement, true);
    assert.ok(r.verdict.reasons.some((s) => s.includes("1 succeeded live-mode payment")));
  });

  it("counts a partially refunded or unexpanded payment, and excludes only a full refund", async () => {
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(
        stubClient({
          payments: [
            { status: "succeeded", latest_charge: { refunded: true }, metadata: { app: "overhype" } },
            { status: "succeeded", latest_charge: { refunded: false }, metadata: { app: "overhype" } },
            { status: "succeeded", latest_charge: "ch_unexpanded", customer: { metadata: { userId: "u1" } } },
            { status: "canceled", latest_charge: null },
          ],
        }),
        ACCOUNT,
        "STRIPE_ACCOUNT_ID_LIVE",
      ),
      now,
    );
    assert.ok(r.payments.liveStripe.checked);
    if (r.payments.liveStripe.checked) {
      assert.equal(r.payments.liveStripe.unrefundedPayments, 2);
      assert.equal(r.payments.liveStripe.fullyRefundedPayments, 1);
    }
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when a later page of payments fails", async () => {
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(
        stubClient({ payments: [{ status: "canceled" }, { status: "canceled" }], paymentsFailAfter: 1 }),
        ACCOUNT,
        "STRIPE_ACCOUNT_ID_LIVE",
      ),
      now,
    );
    assert.equal(r.payments.liveStripe.checked, false);
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when the key belongs to a different account, before enumerating anything", async () => {
    let enumerated = false;
    const client = stubClient({ accountId: "acct_someone_else" });
    client.subscriptions.list = () => { enumerated = true; return items([]); };
    const r = await inventoryExcludedClasses(createLiveStripeReader(client, ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"), now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.ok(!r.payments.liveStripe.checked && r.payments.liveStripe.reason.includes("acct_someone_else"));
    assert.equal(enumerated, false);
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when the key reads test-mode data for the right account, before enumerating anything", async () => {
    let enumerated = false;
    const client = stubClient({ livemode: false });
    client.subscriptions.list = () => { enumerated = true; return items([]); };
    client.paymentIntents.list = () => { enumerated = true; return items([]); };
    const r = await inventoryExcludedClasses(createLiveStripeReader(client, ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"), now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.ok(!r.payments.liveStripe.checked && r.payments.liveStripe.reason.includes("test-mode"));
    assert.equal(enumerated, false);
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when the mode cannot be read (a restricted key without balance access)", async () => {
    const client = stubClient({});
    client.balance.retrieve = async () => { throw new Error("permission denied: balance"); };
    const r = await inventoryExcludedClasses(createLiveStripeReader(client, ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"), now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("blocks when the expected account id is not set", async () => {
    const r = await inventoryExcludedClasses(createLiveStripeReader(stubClient({}), undefined, "STRIPE_ACCOUNT_ID_LIVE"), now);
    assert.equal(r.payments.liveStripe.checked, false);
    assert.ok(!r.payments.liveStripe.checked && r.payments.liveStripe.reason.includes("STRIPE_ACCOUNT_ID_LIVE is not set"));
    assert.equal(r.verdict.blocksReplacement, true);
  });

  it("clears a verified, fully enumerated, empty live account and reports which account it read", async () => {
    const r = await inventoryExcludedClasses(
      createLiveStripeReader(stubClient({ subscriptions: [{ status: "canceled" }], payments: [{ status: "canceled" }] }), ACCOUNT, "STRIPE_ACCOUNT_ID_LIVE"),
      now,
    );
    assert.ok(r.payments.liveStripe.checked && r.payments.liveStripe.accountId === ACCOUNT);
    assert.ok(r.payments.liveStripe.checked && r.payments.liveStripe.livemode === true);
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
