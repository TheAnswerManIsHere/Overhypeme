/**
 * A suspended member does not receive ordinary emails (Issue #1212, plan
 * docs/plans/PLAN_SUSPENDED_MAIL.md; David's Q21–Q24: 1).
 *
 * Delivery is driven through the real Resend client with `Resend.prototype.post`
 * stubbed, so "sent" means a request would have left this process. The email
 * handler runs under a private queue name, so a tick claims only this file's rows.
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import request from "supertest";
import { Resend } from "resend";
import { db } from "@workspace/db";
import { asyncJobsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

import { asyncJobsTick, recoverStuckProcessing, registerJobHandler } from "../lib/asyncJobs.js";
import {
  EMAIL_IDEMPOTENCY_WINDOW_MS,
  EMAIL_RECOVERY_PROTOCOL,
  RECIPIENT_SUSPENDED_SKIP,
  SUSPENSION_PERMITTED_KINDS,
  _resetResendAuthDisabledForTests,
  classifyLegacyEmailKinds,
  emailJobHandler,
  isEnabled,
  recipientSuspended,
  sendEmail,
  type EmailDelivery,
  type EmailJobPayload,
} from "../lib/email.js";
import { suspendAccount } from "../lib/accountSuspension.js";
import { notifyUserAccessRevoked } from "../lib/userNotify.js";
import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const QUEUE_PREFIX = "test_email_suspension_";
const ORDINARY_KINDS = [
  "fact_of_the_day", "review_result", "share_invite", "email_change_verification",
  "admin_fact_notify", "admin_dispute_notify",
] as const;

let sent: { to: string; subject: string; key: string | undefined }[] = [];
let answer: () => { data: { id: string } | null; error: { name: string; message: string; statusCode: number } | null } =
  () => ({ data: { id: `re_${randomUUID().slice(0, 8)}` }, error: null });

let queue = "";
const userIds: string[] = [];

async function makeUser(opts: { suspended: boolean; email?: string }): Promise<string> {
  const id = `email_susp_${randomUUID().slice(0, 12)}`;
  userIds.push(id);
  const email = opts.email ?? `${id}@example.test`;
  await db.insert(usersTable).values({
    id, email, membershipTier: "registered", isActive: true,
    suspendedAt: opts.suspended ? new Date() : null,
  });
  return email;
}

async function getJob(id: number) {
  const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id)).limit(1);
  assert.ok(row, `expected job ${id}`);
  return row;
}

/** A row as this release enqueues it, through `sendEmail`, moved to this file's queue. */
async function enqueue(to: string, kind?: string): Promise<number> {
  const subject = `subject ${randomUUID()}`;
  await sendEmail({ to, ...(kind ? { kind } : {}), subject, text: "body" }, db);
  const [row] = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
    .where(sql`${asyncJobsTable.queue} = 'email' AND ${asyncJobsTable.payload}->>'subject' = ${subject}`).limit(1);
  await db.update(asyncJobsTable).set({ queue, nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, row!.id));
  return row!.id;
}

async function setDelivery(id: number, patch: Partial<EmailDelivery>): Promise<void> {
  await db.update(asyncJobsTable)
    .set({ payload: sql`jsonb_set(${asyncJobsTable.payload}, '{delivery}', COALESCE(${asyncJobsTable.payload}->'delivery', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)` })
    .where(eq(asyncJobsTable.id, id));
}

const tick = () => asyncJobsTick(db, new Date(), { queues: [queue] });
const deliveryOf = async (id: number) => ((await getJob(id)).payload as EmailJobPayload).delivery;

async function assertSkipped(id: number, why: string): Promise<void> {
  const row = await getJob(id);
  assert.equal(row.status, "done", `${why}: finished, not failed or retried`);
  assert.deepEqual(row.result, RECIPIENT_SUSPENDED_SKIP, `${why}: recorded as skipped for a suspended recipient`);
}

describe("a suspended member does not receive ordinary emails (Issue #1212)", () => {
  before(() => assert.equal(isEnabled(), true, "a Resend client must exist (RESEND_API_KEY is set above)"));

  beforeEach(() => {
    queue = `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;
    sent = [];
    answer = () => ({ data: { id: `re_${randomUUID().slice(0, 8)}` }, error: null });
    _resetResendAuthDisabledForTests();
    mock.method(Resend.prototype, "post", async (_path: string, entity: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
      sent.push({ to: String(entity["to"]), subject: String(entity["subject"]), key: options.idempotencyKey });
      return { ...answer(), headers: null };
    });
    mock.method(console, "error", () => { /* the 401 path writes here by design */ });
    registerJobHandler(queue, emailJobHandler, { executionLimitMs: 5 * 60_000, recoveryProtocol: EMAIL_RECOVERY_PROTOCOL, fastReclaim: true, retriesRecover: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    _resetResendAuthDisabledForTests();
    await db.delete(asyncJobsTable).where(sql`${asyncJobsTable.queue} LIKE ${QUEUE_PREFIX + "%"}`);
    if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds.splice(0)));
  });

  it("R1: every ordinary kind, and a job with no kind, is skipped for a suspended recipient: no send, the reason recorded", async () => {
    const to = await makeUser({ suspended: true });
    const ids = [];
    for (const kind of [...ORDINARY_KINDS, undefined]) ids.push(await enqueue(to, kind));
    await tick(); await tick(); await tick();
    assert.equal(sent.length, 0, "nothing reaches the provider");
    for (const id of ids) await assertSkipped(id, `job ${id}`);
    for (const id of ids) assert.equal((await getJob(id)).attempts, 1, "a skip uses no retry");
  });

  it("R1: mail queued before the suspension is skipped once the suspension commits", async () => {
    const to = await makeUser({ suspended: false });
    const id = await enqueue(to, "fact_of_the_day");
    const userId = userIds.at(-1)!;
    const result = await suspendAccount(userId, { by: null, reason: "test" });
    assert.equal(result.outcome, "suspended");
    await tick();
    assert.equal(sent.length, 0);
    await assertSkipped(id, "queued before");
  });

  it("R1: a retry after a failed attempt is skipped when the recipient was suspended in between", async () => {
    const to = await makeUser({ suspended: false });
    const id = await enqueue(to, "review_result");
    answer = () => ({ data: null, error: { name: "application_error", message: "provider down", statusCode: 500 } });
    await tick();
    assert.equal(sent.length, 1, "the first attempt reached the provider and failed");
    assert.notEqual((await getJob(id)).status, "done");
    await db.update(usersTable).set({ suspendedAt: new Date() }).where(eq(usersTable.id, userIds.at(-1)!));
    answer = () => ({ data: { id: "re_ok" }, error: null });
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
    await recoverStuckProcessing(db);
    await tick();
    assert.equal(sent.length, 1, "the retry is not sent");
    await assertSkipped(id, "retry");
    assert.equal((await deliveryOf(id))?.state, "possibly_sent", "the earlier attempt's delivery history is kept");
  });

  it("R1: an admin's Retry on the Email Queue does not get round a suspension, and the queue reports the skip", async () => {
    const to = await makeUser({ suspended: false });
    const id = await enqueue(to, "share_invite");
    // Held back as possibly sent by an earlier release: the admin's Retry is the only way on.
    await db.update(asyncJobsTable).set({ status: "failed", attempts: 3, lastError: "held back" }).where(eq(asyncJobsTable.id, id));
    await db.update(usersTable).set({ suspendedAt: new Date() }).where(eq(usersTable.id, userIds.at(-1)!));

    const adminId = `email_susp_admin_${randomUUID().slice(0, 8)}`;
    userIds.push(adminId);
    await db.insert(usersTable).values({ id: adminId, membershipTier: "registered", isAdmin: true });
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
    try {
      await db.update(asyncJobsTable).set({ queue: "email" }).where(eq(asyncJobsTable.id, id));
      assert.equal((await request(app).post(`/api/admin/email-queue/${id}/retry`)).status, 200);
      await db.update(asyncJobsTable).set({ queue, nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
      await tick();
      assert.equal(sent.length, 0, "the retried email is not sent");
      await assertSkipped(id, "admin retry");

      await db.update(asyncJobsTable).set({ queue: "email" }).where(eq(asyncJobsTable.id, id));
      const list = await request(app).get("/api/admin/email-queue?status=done&limit=100");
      assert.equal(list.status, 200);
      const mine = (list.body.rows as { id: number; skipReason: string | null }[]).find((r) => r.id === id);
      assert.ok(mine, "the skipped job is listed");
      assert.equal(mine.skipReason, "recipient_suspended", "the Email Queue API returns the skip's reason");
    } finally {
      await db.update(asyncJobsTable).set({ queue }).where(eq(asyncJobsTable.id, id));
    }
  });

  it("R2: every permitted kind still goes to a suspended recipient, including a reinstatement notice while suspended again", async () => {
    const to = await makeUser({ suspended: true });
    const ids = [];
    for (const kind of SUSPENSION_PERMITTED_KINDS) ids.push(await enqueue(to, kind));
    await tick(); await tick(); await tick(); await tick();
    assert.equal(sent.length, SUSPENSION_PERMITTED_KINDS.size, "each permitted kind is sent once");
    assert.ok(SUSPENSION_PERMITTED_KINDS.has("account_reinstated"));
    for (const id of ids) {
      const row = await getJob(id);
      assert.equal(row.status, "done");
      assert.notDeepEqual(row.result, RECIPIENT_SUSPENDED_SKIP);
    }
  });

  it("R3: an unsuspended member and an address with no account receive exactly as before", async () => {
    const member = await makeUser({ suspended: false });
    const a = await enqueue(member, "fact_of_the_day");
    const nobody = `nobody_${randomUUID().slice(0, 8)}@example.test`;
    const b = await enqueue(nobody);
    await tick();
    assert.deepEqual(sent.map((s) => s.to).sort(), [member, nobody].sort());
    for (const id of [a, b]) assert.notDeepEqual((await getJob(id)).result, RECIPIENT_SUSPENDED_SKIP);
  });

  it("matches the account's address case-insensitively", async () => {
    const to = await makeUser({ suspended: true, email: `Mixed_${randomUUID().slice(0, 8)}@Example.test` });
    const id = await enqueue(to.toUpperCase(), "fact_of_the_day");
    await tick();
    assert.equal(sent.length, 0);
    await assertSkipped(id, "different case");
  });

  it("decides on the frozen address the worker will send to, not the payload's top-level one", async () => {
    const suspended = await makeUser({ suspended: true });
    const active = await makeUser({ suspended: false });
    const frozen = (to: string) => ({ to, from: "Overhype.me <noreply@overhype.me>", subject: "frozen", text: "body", html: "<p>body</p>" });
    const now = new Date().toISOString();

    const toSuspended = await enqueue(active, "fact_of_the_day");
    await setDelivery(toSuspended, { state: "possibly_sent", firstDispatchAt: now, message: frozen(suspended) } as Partial<EmailDelivery>);
    const toActive = await enqueue(suspended, "fact_of_the_day");
    await setDelivery(toActive, { state: "possibly_sent", firstDispatchAt: now, message: frozen(active) } as Partial<EmailDelivery>);

    await tick();
    assert.deepEqual(sent.map((s) => s.to), [active], "only the job whose frozen address is unsuspended is sent");
    await assertSkipped(toSuspended, "frozen address suspended");
  });

  it("precedence: an expired possibly-sent job to a suspended recipient is skipped, not failed, and keeps its history", async () => {
    const to = await makeUser({ suspended: true });
    const id = await enqueue(to, "review_result");
    const longAgo = new Date(Date.now() - EMAIL_IDEMPOTENCY_WINDOW_MS - 60_000).toISOString();
    await setDelivery(id, { state: "possibly_sent", firstDispatchAt: longAgo } as Partial<EmailDelivery>);
    await tick();
    assert.equal(sent.length, 0);
    await assertSkipped(id, "expired possibly-sent");
    const record = await deliveryOf(id);
    assert.equal(record?.state, "possibly_sent");
    assert.equal(record?.firstDispatchAt, longAgo, "its delivery history is unchanged");
  });

  it("precedence: with the provider disabled by a 401, a suspended recipient's job is skipped rather than retried", async () => {
    const other = await makeUser({ suspended: false });
    const tripper = await enqueue(other, "fact_of_the_day");
    answer = () => ({ data: null, error: { name: "restricted_api_key", message: "API key is invalid", statusCode: 401 } });
    await tick();
    assert.notEqual((await getJob(tripper)).status, "done", "the 401 turned delivery off for this process");

    const to = await makeUser({ suspended: true });
    const id = await enqueue(to, "share_invite");
    await tick();
    await assertSkipped(id, "provider disabled");
    assert.equal(sent.length, 1, "only the job that tripped the shut-off reached the provider");
  });

  it("the overlap (Q24): a suspension waits on the lock that authorises a send, and one committed first is seen", async () => {
    const to = await makeUser({ suspended: false });
    const userId = userIds.at(-1)!;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let lockTaken!: () => void;
    const taken = new Promise<void>((r) => { lockTaken = r; });
    const authorising = db.transaction(async (tx) => {
      assert.equal(await recipientSuspended(tx, to, true), false);
      lockTaken();
      await held;
    });
    await taken;
    let suspendedAt = 0;
    const suspension = suspendAccount(userId, { by: null, reason: "overlap" }).then((r) => { suspendedAt = Date.now(); return r; });
    let releasedAt = 0;
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(suspendedAt, 0, "the suspension waits while the send is being authorised");
    } finally {
      releasedAt = Date.now();
      release(); // never leave the lock held, or a failure would hang the run
    }
    await authorising;
    assert.equal((await suspension).outcome, "suspended");
    assert.ok(suspendedAt >= releasedAt, "it commits only after the authorisation");
    assert.equal(await recipientSuspended(db, to, true), true, "a later decision sees the committed suspension");
  });

  it("the access-revoked producer writes its permitted kind onto the job", async () => {
    const to = await makeUser({ suspended: true });
    const userId = userIds.at(-1)!;
    // A non-test key for this one call, so the producer's own enqueue writes its row (the stub keeps it offline).
    const prior = process.env["RESEND_API_KEY_DEV"];
    process.env["RESEND_API_KEY_DEV"] = "re_producer_check";
    try {
      await notifyUserAccessRevoked(userId, "refund");
    } finally {
      if (prior === undefined) delete process.env["RESEND_API_KEY_DEV"]; else process.env["RESEND_API_KEY_DEV"] = prior;
    }
    const rows = await db.select().from(asyncJobsTable).where(sql`${asyncJobsTable.queue} = 'email' AND ${asyncJobsTable.payload}->>'to' = ${to}`);
    try {
      assert.equal(rows.length, 1);
      assert.equal((rows[0]!.payload as EmailJobPayload).kind, "access_revoked");
    } finally {
      await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, rows.map((r) => r.id)));
    }
  });

  it("the billing producers write their permitted kinds at each send (Stripe events are not driven here)", () => {
    const src = readFileSync(new URL("../lib/webhookHandlers.ts", import.meta.url), "utf8");
    const sends = src.match(/sendEmail\(\{[^}]*\}/g) ?? [];
    assert.equal(sends.length, 3, "the webhook handler sends three billing emails");
    for (const kind of ["billing_payment_action", "billing_renewal_reminder", "billing_card_updated"]) {
      assert.equal(sends.filter((s) => s.includes(`kind: "${kind}"`)).length, 1, `one send carries ${kind}`);
    }
  });

  it("the cutover step labels an older billing job without touching its sending record, and leaves unknown jobs ordinary", async () => {
    const legacy = async (subject: string, status: "pending" | "failed" | "done" = "pending") => {
      const delivery = { state: "possibly_sent", nonce: randomUUID(), firstDispatchAt: new Date().toISOString() };
      const [row] = await db.insert(asyncJobsTable).values({
        queue: "email", status,
        payload: { to: `legacy_${randomUUID().slice(0, 6)}@example.test`, subject, text: "b", html: null, kind: null, delivery },
      }).returning();
      return row!.id;
    };
    const ids = {
      action: await legacy("Action required: confirm your renewal — Overhype.me"),
      renewal: await legacy("Your Overhype.me renewal — 3 days to go", "failed"),
      card: await legacy("Your card on file was updated — Overhype.me"),
      revoked: await legacy("Your Overhype.me Legendary access is paused"),
      unknown: await legacy("Today's fact about you"),
      finished: await legacy("Your card on file was updated — Overhype.me", "done"),
    };
    try {
      const before = await getJob(ids.action);
      const counts = await classifyLegacyEmailKinds(db);
      assert.ok((counts["billing_payment_action"] ?? 0) >= 1);
      const kindOf = async (id: number) => ((await getJob(id)).payload as EmailJobPayload).kind ?? null;
      assert.equal(await kindOf(ids.action), "billing_payment_action");
      assert.equal(await kindOf(ids.renewal), "billing_renewal_reminder");
      assert.equal(await kindOf(ids.card), "billing_card_updated");
      assert.equal(await kindOf(ids.revoked), "access_revoked");
      assert.equal(await kindOf(ids.unknown), null, "an unrecognised job stays ordinary");
      assert.equal(await kindOf(ids.finished), null, "a finished job is left alone");
      const after = await getJob(ids.action);
      assert.deepEqual((after.payload as EmailJobPayload).delivery, (before.payload as EmailJobPayload).delivery, "the sending record is kept");
      assert.equal(after.status, before.status);
      const again = await classifyLegacyEmailKinds(db);
      assert.equal(await kindOf(ids.action), "billing_payment_action");
      assert.ok(Object.values(again).every((n) => n === 0), "a second run finds nothing left to label");
    } finally {
      await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, Object.values(ids)));
    }
  });
});
