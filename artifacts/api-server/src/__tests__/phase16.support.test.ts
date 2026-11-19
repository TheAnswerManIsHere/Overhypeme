/**
 * Support (launch Phase 16, increment 5; plan PLAN_PHASE16_ANALYTICS_OPERATIONS.md, design E, amendment 3, Acceptance).
 *
 * @purpose Proves, through the real app stack, that a contact request from a signed-out visitor, from a member in each restricted account state, and during read-only mode is queued to the support inbox with the sender as reply-to, acknowledged to the sender, and kept as a row in support_requests; and that the honeypot, the field checks and the per-address limit refuse what they should.
 * @subsystem operations
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, supportRequestsTable, asyncJobsTable, rateLimitCountersTable } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { SUPPORT_ADDRESS } from "../lib/email.js";
import { __acceptForTests, __resetReadOnlyForTests } from "../lib/readOnlyMode.js";

const PREFIX = "t-p16sup-";
const app = createApp();

function body(email: string, extra: Record<string, unknown> = {}) {
  return {
    email,
    category: "account",
    message: "I can't get back into my account after the pause.",
    captchaToken: "test-token",
    formStartedAt: Date.now() - 10_000,
    ...extra,
  };
}

async function member(state: "eligible" | "unverified" | "unonboarded" | "suspended"): Promise<{ id: string; token: string }> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    emailVerifiedAt: state === "unverified" ? null : new Date(),
    onboardingCompletedAt: state === "eligible" || state === "suspended" ? new Date() : null,
    suspendedAt: state === "suspended" ? new Date() : null,
  });
  const data: SessionData = { user: { id } as unknown as SessionData["user"], access_token: "t" };
  return { id, token: await createSession(data, id) };
}

async function rowsFor(email: string) {
  return db.select().from(supportRequestsTable).where(eq(supportRequestsTable.email, email));
}

async function inboxJobsFor(email: string) {
  const jobs = await db.select({ payload: asyncJobsTable.payload }).from(asyncJobsTable).where(eq(asyncJobsTable.queue, "email"));
  return jobs
    .map((j) => j.payload as { to: string; replyTo?: string; kind?: string })
    .filter((p) => (p.to === SUPPORT_ADDRESS && p.replyTo === email) || p.to === email);
}

async function cleanup(): Promise<void> {
  await db.delete(supportRequestsTable).where(like(supportRequestsTable.email, `${PREFIX}%`));
  await db.delete(asyncJobsTable).where(and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}::text like ${"%" + PREFIX + "%"}`));
  await db.delete(rateLimitCountersTable).where(like(rateLimitCountersTable.keyRaw, "%support.contact%"));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(cleanup);
beforeEach(async () => {
  await db.delete(rateLimitCountersTable).where(like(rateLimitCountersTable.keyRaw, "%support.contact%"));
  __resetReadOnlyForTests();
});
after(async () => {
  await cleanup();
  __resetReadOnlyForTests();
});

describe("a contact request", () => {
  it("from a signed-out visitor: queued to the inbox with the sender as reply-to, acknowledged, and kept", async () => {
    const email = `${PREFIX}${randomUUID()}@example.com`;
    const res = await request(app).post("/api/support/contact").send(body(email));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, acknowledged: true });

    const [row] = await rowsFor(email);
    assert.ok(row, "a row is kept");
    assert.equal(row.category, "account");
    assert.equal(row.userId, null);
    assert.equal(row.accountState, null);
    assert.equal(row.inboxDelivery, "queued");

    const jobs = await inboxJobsFor(email);
    assert.ok(jobs.some((p) => p.to === SUPPORT_ADDRESS && p.replyTo === email && p.kind === "support_request"), "the inbox copy answers the sender");
    assert.ok(jobs.some((p) => p.to === email && p.kind === "support_ack"), "the sender is acknowledged");
  });

  for (const state of ["suspended", "unverified", "unonboarded"] as const) {
    it(`from a signed-in ${state} member: accepted, with the account and its state on the row`, async () => {
      const { id, token } = await member(state);
      const email = `${PREFIX}${randomUUID()}@example.com`;
      const res = await request(app).post("/api/support/contact").set("Authorization", `Bearer ${token}`).send(body(email));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [row] = await rowsFor(email);
      assert.equal(row?.userId, id);
      assert.equal(row?.accountState, state);
    });
  }

  it("while read-only mode is on: accepted (Q7: 1)", async () => {
    __acceptForTests({ on: true, updatedAt: Date.now(), confirmedAt: Date.now() });
    const email = `${PREFIX}${randomUUID()}@example.com`;
    const res = await request(app).post("/api/support/contact").send(body(email));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await rowsFor(email)).length, 1);
  });

  it("refuses a filled honeypot, an unknown category, a too-short message and a malformed address, keeping nothing", async () => {
    const email = `${PREFIX}${randomUUID()}@example.com`;
    for (const bad of [
      body(email, { hpField: "bot" }),
      body(email, { category: "spam" }),
      body(email, { message: "hi" }),
      body("not-an-address"),
    ]) {
      const res = await request(app).post("/api/support/contact").send(bad);
      assert.equal(res.status, 400, JSON.stringify(res.body));
    }
    assert.equal((await rowsFor(email)).length, 0);
  });

  it("limits one address to three requests an hour", async () => {
    const email = `${PREFIX}${randomUUID()}@example.com`;
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(app).post("/api/support/contact").send(body(email))).status, 200);
    }
    const res = await request(app).post("/api/support/contact").send(body(email));
    assert.equal(res.status, 429);
    assert.equal((await rowsFor(email)).length, 3);
  });

  it("judges an address's shape in linear time, and as before", async () => {
    const { isEmailShape } = await import("../routes/support.js");
    for (const ok of ["a@b.co", "first.last@sub.example.com"]) assert.equal(isEmailShape(ok), true, ok);
    for (const bad of ["", "a", "@b.co", "a@b", "a@.co", "a@b.", "a b@c.co", "a@b@c.co"]) assert.equal(isEmailShape(bad), false, bad);
    const hostile = "!@!." + "!.".repeat(100_000);
    const started = Date.now();
    isEmailShape(hostile);
    assert.ok(Date.now() - started < 50, "the CodeQL attack string is answered at once");
  });

  it("escapes the visitor's text in the inbox copy's HTML", async () => {
    const { buildSupportRequestEmail } = await import("../lib/email.js");
    const out = buildSupportRequestEmail({ email: "a@b.co", category: "bug", message: "<script>x</script>\nmore", userId: null, accountState: null });
    assert.ok(!out.html!.includes("<script>"));
    assert.ok(out.html!.includes("&lt;script&gt;"));
    assert.ok(!/[\r\n]/.test(out.subject));
  });
});
