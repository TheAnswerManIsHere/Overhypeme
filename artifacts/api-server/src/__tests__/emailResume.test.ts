/**
 * Email is never sent twice (plan docs/plans/PLAN_JOB_RESUME.md §E, Issue #1000
 * increment 3; David's Q14: 2). Each test names the case it covers.
 *
 * The real Resend client is driven through `Resend.prototype.post`, so every
 * assertion about a send is about what would leave this process: the message
 * body and the `Idempotency-Key` the SDK would put on the request.
 *
 * The email handler runs here under a private queue name, so a tick claims only
 * this file's rows; the handler does not read its queue name.
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import { Resend } from "resend";
import { db } from "@workspace/db";
import { adminConfigTable, asyncJobsTable, usersTable } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import {
  __resetHandlersForTest,
  asyncJobsTick,
  recoverStuckProcessing,
  registerJobHandler,
  type JobHandler,
} from "../lib/asyncJobs.js";
import {
  EMAIL_IDEMPOTENCY_WINDOW_MS,
  EMAIL_RECOVERY_PROTOCOL,
  _resetResendAuthDisabledForTests,
  emailIdempotencyKey,
  emailJobHandler,
  isEnabled,
  sendEmail,
  type EmailDelivery,
  type EmailJobPayload,
} from "../lib/email.js";
import { bustConfigCache } from "../lib/adminConfig.js";
import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const QUEUE_PREFIX = "test_email_resume_";
const FROM_KEY = "email_from_address";

interface Sent { to: string; from: string; subject: string; key: string | undefined }

/** Each call Resend would receive, and what the stub answers. */
let sent: Sent[] = [];
let answer: () => { data: { id: string } | null; error: { name: string; message: string; statusCode: number } | null } =
  () => ({ data: { id: `re_${randomUUID().slice(0, 8)}` }, error: null });

function stubResend(): void {
  mock.method(Resend.prototype, "post", async (_path: string, entity: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
    sent.push({ to: String(entity["to"]), from: String(entity["from"]), subject: String(entity["subject"]), key: options.idempotencyKey });
    return { ...answer(), headers: null };
  });
}

let queue = "";
function useEmailHandler(handler: JobHandler = emailJobHandler, declare = true): void {
  registerJobHandler(queue, handler, declare
    ? { executionLimitMs: 5 * 60_000, recoveryProtocol: EMAIL_RECOVERY_PROTOCOL, fastReclaim: true, recoverAfterLimit: true }
    : {});
}

async function getJob(id: number) {
  const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id)).limit(1);
  assert.ok(row, `expected job ${id}`);
  return row;
}
const deliveryOf = async (id: number) => ((await getJob(id)).payload as EmailJobPayload).delivery;

/** A row as this release enqueues it: through `sendEmail`, moved to this file's queue. */
async function enqueueEmail(to = "resume@example.test"): Promise<number> {
  await sendEmail({ to, subject: `subject ${randomUUID().slice(0, 6)}`, text: "body" }, db);
  const [row] = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
    .where(sql`${asyncJobsTable.queue} = 'email' AND ${asyncJobsTable.payload}->>'to' = ${to}`)
    .orderBy(sql`${asyncJobsTable.id} DESC`).limit(1);
  await db.update(asyncJobsTable).set({ queue }).where(eq(asyncJobsTable.id, row!.id));
  return row!.id;
}

/** A row an earlier release enqueued: no sending record. */
async function insertLegacyEmail(extra: Partial<typeof asyncJobsTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(asyncJobsTable).values({
    queue, payload: { to: "legacy@example.test", subject: "legacy", text: "body", html: null, kind: null }, ...extra,
  }).returning();
  return row!.id;
}

async function setDelivery(id: number, patch: Partial<EmailDelivery>): Promise<void> {
  await db.update(asyncJobsTable)
    .set({ payload: sql`jsonb_set(${asyncJobsTable.payload}, '{delivery}', (${asyncJobsTable.payload}->'delivery') || ${JSON.stringify(patch)}::jsonb)` })
    .where(eq(asyncJobsTable.id, id));
}

/** A holder claimed the row and stopped: processing, its lease lapsed. */
async function stopHolder(id: number, claimProtocol: number | null, token = randomUUID()): Promise<string> {
  await db.execute(sql`
    UPDATE async_jobs SET status = 'processing', lease_token = ${token}, claim_owner = 'gone',
           claim_recovery_protocol = ${claimProtocol}, lease_expires_at = now() - interval '1 second',
           claimed_at = now() - interval '1 minute'
     WHERE id = ${id}`);
  return token;
}

const tick = () => asyncJobsTick(db, new Date(), { queues: [queue] });

describe("email is never sent twice (plan §E)", () => {
  before(() => assert.equal(isEnabled(), true, "a Resend client must exist (RESEND_API_KEY is set above)"));

  beforeEach(() => {
    queue = `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;
    sent = [];
    answer = () => ({ data: { id: `re_${randomUUID().slice(0, 8)}` }, error: null });
    _resetResendAuthDisabledForTests();
    stubResend();
    mock.method(console, "error", () => { /* the 401 path writes here by design */ });
  });

  afterEach(async () => {
    mock.restoreAll();
    _resetResendAuthDisabledForTests();
    __resetHandlersForTest();
    await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, FROM_KEY));
    bustConfigCache();
  });

  it("not yet submitted: sends once, with the message frozen at enqueue and the job's key, and records the receipt", async () => {
    const id = await enqueueEmail();
    const frozen = await deliveryOf(id);
    assert.equal(frozen?.state, "unsent");
    assert.ok(frozen?.message?.from, "the resolved message is stored before any send");
    useEmailHandler();
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.key, emailIdempotencyKey(id, frozen!.nonce));
    const job = await getJob(id);
    assert.equal(job.status, "done");
    const after = await deliveryOf(id);
    assert.equal(after?.state, "sent");
    assert.ok(after?.providerId?.startsWith("re_"));
  });

  it("the stored message and key are reused across a configuration change between attempts", async () => {
    const id = await enqueueEmail();
    const firstFrom = (await deliveryOf(id))!.message!.from;
    useEmailHandler();
    answer = () => ({ data: null, error: { name: "internal_server_error", message: "upstream", statusCode: 500 } });
    await tick();
    const failed = await getJob(id);
    assert.equal(failed.status, "recovering", "a send that may have reached Resend is retried only by a worker that resends with the key");
    assert.equal(failed.recoveryProtocol, EMAIL_RECOVERY_PROTOCOL);
    assert.equal((await deliveryOf(id))?.state, "possibly_sent");

    await db.insert(adminConfigTable).values({ key: FROM_KEY, value: "changed@example.test", dataType: "string", label: "from" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: "changed@example.test" } });
    bustConfigCache();
    answer = () => ({ data: { id: "re_second" }, error: null });
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
    await tick();

    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.from, firstFrom, "the retry sends the frozen sender, not the changed setting");
    assert.equal(sent[1]!.key, sent[0]!.key, "the same no-duplicate key");
    assert.equal((await getJob(id)).status, "done");
  });

  it("possibly submitted within 24 h (a stop mid-send): resent once with the same key", async () => {
    const id = await enqueueEmail();
    const { nonce } = (await deliveryOf(id))!;
    useEmailHandler();
    const token = await stopHolder(id, EMAIL_RECOVERY_PROTOCOL);
    await setDelivery(id, { state: "possibly_sent", firstDispatchAt: new Date(Date.now() - 60_000).toISOString(), accountedToken: token });
    await recoverStuckProcessing(db);
    assert.equal((await getJob(id)).status, "recovering");
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.key, emailIdempotencyKey(id, nonce));
    assert.equal((await getJob(id)).status, "done");
  });

  it("sent: a resumed job finishes without sending", async () => {
    const id = await enqueueEmail();
    useEmailHandler();
    const token = await stopHolder(id, EMAIL_RECOVERY_PROTOCOL);
    await setDelivery(id, { state: "sent", providerId: "re_earlier", firstDispatchAt: new Date().toISOString(), accountedToken: token });
    await recoverStuckProcessing(db);
    await tick();
    assert.equal(sent.length, 0);
    assert.equal((await getJob(id)).status, "done");
  });

  it("possibly submitted more than 24 h ago: marked failed with the reason, nothing sent (Q14: 2)", async () => {
    const id = await enqueueEmail();
    useEmailHandler();
    const token = await stopHolder(id, EMAIL_RECOVERY_PROTOCOL);
    await setDelivery(id, {
      state: "possibly_sent",
      firstDispatchAt: new Date(Date.now() - EMAIL_IDEMPOTENCY_WINDOW_MS - 60_000).toISOString(),
      accountedToken: token,
    });
    await recoverStuckProcessing(db);
    await tick();
    assert.equal(sent.length, 0);
    const job = await getJob(id);
    assert.equal(job.status, "failed");
    assert.match(job.lastError ?? "", /more than 24 hours/);
  });

  it("interrupted while an earlier release held it (no key, no record): marked failed, nothing sent (Q14: 2)", async () => {
    const id = await insertLegacyEmail();
    useEmailHandler();
    await stopHolder(id, null); // the earlier release stamps no protocol
    await recoverStuckProcessing(db);
    assert.equal((await getJob(id)).status, "recovering");
    await tick();
    assert.equal(sent.length, 0);
    const job = await getJob(id);
    assert.equal(job.status, "failed");
    assert.match(job.lastError ?? "", /earlier version of the server may already have sent/);
  });

  it("interrupted before leases existed (an unleased row taken back at 30 minutes): marked failed, nothing sent", async () => {
    const id = await insertLegacyEmail({ status: "processing" });
    useEmailHandler();
    await db.execute(sql`UPDATE async_jobs SET updated_at = now() - interval '31 minutes' WHERE id = ${id}`);
    await recoverStuckProcessing(db);
    const reclaimed = await getJob(id);
    assert.equal(reclaimed.status, "recovering", "the legacy sweep puts a declaring queue's row in recovery too");
    await tick();
    assert.equal(sent.length, 0);
    assert.equal((await getJob(id)).status, "failed");
  });

  it("a row this release enqueued but an earlier release attempted (attempts it did not record): marked failed", async () => {
    const id = await enqueueEmail();
    useEmailHandler();
    await db.update(asyncJobsTable).set({ attempts: 1, leaseToken: randomUUID() }).where(eq(asyncJobsTable.id, id));
    await tick();
    assert.equal(sent.length, 0);
    assert.equal((await getJob(id)).status, "failed");
  });

  it("a row an earlier release enqueued and nobody touched: sent normally, once, under a new record", async () => {
    const id = await insertLegacyEmail();
    useEmailHandler();
    await tick();
    assert.equal(sent.length, 1);
    const record = await deliveryOf(id);
    assert.equal(record?.state, "sent");
    assert.equal(sent[0]!.key, emailIdempotencyKey(id, record!.nonce));
  });

  it("a failure before any send (Resend key disabled) leaves the record trusted: the next run sends", async () => {
    const id = await enqueueEmail();
    useEmailHandler();
    answer = () => ({ data: null, error: { name: "restricted_api_key", message: "API key is invalid", statusCode: 401 } });
    // Trip the process-wide shut-off on another job first, as a 401 would.
    const tripper = await enqueueEmail("tripper@example.test");
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 60_000) }).where(eq(asyncJobsTable.id, tripper));
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() + 3_600_000) }).where(eq(asyncJobsTable.id, id));
    await tick();
    assert.equal(sent.length, 1, "only the tripper reached Resend");

    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
    await tick();
    const refused = await getJob(id);
    assert.equal(refused.status, "pending", "no send was attempted, so an ordinary retry");
    assert.equal(refused.attempts, 1);
    assert.equal((await deliveryOf(id))?.state, "unsent");

    _resetResendAuthDisabledForTests();
    answer = () => ({ data: { id: "re_after_rotation" }, error: null });
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
    await tick();
    assert.equal(sent.length, 2, "the email is sent once the key is fixed");
    assert.equal((await getJob(id)).status, "done");
  });

  it("release pair 2 → 3: a retry that may have reached Resend is never claimed by a worker without email's recovery", async () => {
    const id = await enqueueEmail();
    useEmailHandler();
    answer = () => ({ data: null, error: { name: "internal_server_error", message: "upstream", statusCode: 500 } });
    await tick();
    assert.equal((await getJob(id)).status, "recovering");

    let earlierReleaseRuns = 0;
    useEmailHandler({ async run() { earlierReleaseRuns++; return { ok: true }; } }, false); // increment 2: declares nothing
    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, id));
    await tick();
    assert.equal(earlierReleaseRuns, 0, "the earlier release never sends it again without the key");

    answer = () => ({ data: { id: "re_ok" }, error: null });
    useEmailHandler();
    await tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.key, sent[0]!.key);
    assert.equal((await getJob(id)).status, "done");
  });

  it("a run ended at its time limit goes back recovering with its claim's protocol, so no earlier release resends it", async () => {
    const id = await enqueueEmail();
    let release!: () => void;
    const wedged = new Promise<void>((r) => { release = r; });
    registerJobHandler(queue, {
      async run(payload, row) {
        await wedged; // a send that never answers
        return emailJobHandler.run(payload, row);
      },
    }, { executionLimitMs: 100, recoveryProtocol: EMAIL_RECOVERY_PROTOCOL, recoverAfterLimit: true });
    await tick();
    const after = await getJob(id);
    assert.equal(after.status, "recovering");
    assert.equal(after.recoveryProtocol, EMAIL_RECOVERY_PROTOCOL);
    assert.match(after.lastError ?? "", /execution limit/);
    release();
  });

  it("a person's Retry on the email queue sends a held-back email once, under a fresh key", async () => {
    // Held back because an earlier release may have sent it (Q14: 2).
    const id = await insertLegacyEmail({ attempts: 1 });
    useEmailHandler();
    await tick();
    assert.equal((await getJob(id)).status, "failed");
    const oldToken = (await getJob(id)).leaseToken;

    const adminId = `email_resume_${randomUUID()}`;
    await db.insert(usersTable).values({ id: adminId, membershipTier: "registered", isAdmin: true });
    const server = http.createServer(buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      await db.update(asyncJobsTable).set({ queue: "email" }).where(eq(asyncJobsTable.id, id));
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1", port: (server.address() as { port: number }).port,
          path: `/api/admin/email-queue/${id}/retry`, method: "POST", headers: { Accept: "application/json" },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
        req.on("error", reject);
        req.end();
      });
      await db.update(asyncJobsTable).set({ queue }).where(eq(asyncJobsTable.id, id));
      assert.equal(status, 200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.delete(usersTable).where(eq(usersTable.id, adminId));
    }

    const reset = await getJob(id);
    assert.equal(reset.status, "pending");
    assert.equal(reset.recoveryProtocol, null);
    const record = (reset.payload as EmailJobPayload).delivery;
    assert.equal(record?.state, "unsent");
    assert.equal(record?.accountedToken, oldToken, "the person's retry accounts for every claim so far");

    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.key, emailIdempotencyKey(id, record!.nonce));
    assert.equal((await getJob(id)).status, "done");
  });
});
