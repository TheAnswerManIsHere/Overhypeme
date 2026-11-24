/**
 * The Operations page through the real request path when the database can be
 * read but not written (launch Phase 16, increment 2; carried from the build
 * report for PR #1037 — the earlier test replaced the page's rate-limit
 * counter and ran against a stand-in for sign-in, so anything else that saves
 * on every request was untested).
 *
 * The whole app (`createApp()`) serves the requests, with a real admin session
 * cookie: the parser, CSRF, the session lookup and its refresh, the admin gate
 * and the shared limiter all run. The fault is injected at the database driver:
 * every statement that would write is refused with the error Postgres itself
 * gives a read-only transaction (SQLSTATE 25006), and reads go through
 * untouched. A driver-level fault, rather than switching the test database to
 * read-only, keeps it confined to this test's own process and requests.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { db } from "@workspace/db";
import { usersTable, sessionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, SESSION_COOKIE, type SessionData } from "../lib/auth.js";
import { __setAlertCaptureForTest, __setAlertReadinessForTest } from "../lib/operationalAlerts.js";
import { __setOperationalHealthDepsForTest } from "../lib/operationalHealth.js";
import { __resetIncidentCacheForTest } from "../routes/adminOperations.js";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";

const WRITE = /^\s*(?:with\b[\s\S]*?\)\s*)?(insert|update|delete|merge|create|alter|drop|truncate)\b/i;
let refused: string[] = [];
const realQuery = pg.Client.prototype.query;

function refuseWrites(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Client.prototype as any).query = function (this: pg.Client, config: unknown, ...rest: unknown[]) {
    const text = typeof config === "string" ? config : (config as { text?: string } | null)?.text ?? "";
    const m = WRITE.exec(text);
    if (m) {
      refused.push(m[1]!.toUpperCase());
      const err = Object.assign(new Error(`cannot execute ${m[1]!.toUpperCase()} in a read-only transaction`), { code: "25006", severity: "ERROR" });
      const cb = rest.find((r) => typeof r === "function") as ((e: Error) => void) | undefined;
      if (cb) { process.nextTick(() => cb(err)); return undefined; }
      return Promise.reject(err);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realQuery as any).call(this, config, ...rest);
  };
}
function restoreWrites(): void {
  pg.Client.prototype.query = realQuery;
}

describe("Operations page, database readable but not writable, real request path", () => {
  const userId = `ops-ro-${randomUUID()}`;
  let sid = "";
  const app = createApp();

  before(async () => {
    await db.insert(usersTable).values({
      id: userId, email: `${userId}@test.local`, isAdmin: true, membershipTier: "registered",
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
    });
    await acceptCurrentLegal(userId);
    const data: SessionData = {
      user: { id: userId, email: `${userId}@test.local`, isAdmin: true } as unknown as SessionData["user"],
      access_token: "test-token",
      isAdmin: true,
    };
    sid = await createSession(data, userId);
    __setAlertReadinessForTest(() => true);
    __setAlertCaptureForTest(() => {});
    __resetIncidentCacheForTest();
    __setOperationalHealthDepsForTest({
      payments: async () => ({ status: "ok", expected: 0, unprocessed: 0, oldestUnprocessedAt: null }),
    });
  });

  after(async () => {
    restoreWrites();
    __setAlertReadinessForTest(null);
    __setAlertCaptureForTest(null);
    __setOperationalHealthDepsForTest(null);
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  const cookie = () => `${SESSION_COOKIE}=${sid}; csrf_token=ro-test`;

  it("the page loads and reads every part, while writes are refused", async () => {
    refused = [];
    refuseWrites();
    try {
      const res = await request(app).get("/api/admin/operations").set("Cookie", cookie());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.lanes.status, "ok");
      assert.equal(res.body.alerts.status, "ok");
      assert.equal(res.body.alerts.health.tasks.status, "ok");
      assert.equal(res.body.alerts.health.jobs.status, "ok");
    } finally {
      restoreWrites();
    }
    assert.ok(refused.length > 0, "the request path did attempt a write, so the fault was exercised");
  });

  it("the test alert still sends", async () => {
    refused = [];
    refuseWrites();
    try {
      const res = await request(app)
        .post("/api/admin/operations/test-alert")
        .set("Cookie", cookie())
        .set("x-csrf-token", "ro-test");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.sent, true);
    } finally {
      restoreWrites();
    }
  });

  it("the combined alert address still judges, unauthenticated", async () => {
    refuseWrites();
    try {
      const res = await request(app).get("/api/health/alerts");
      assert.ok(res.status === 200 || res.status === 503);
      assert.notEqual(res.body.tasks?.state, undefined, JSON.stringify(res.body));
      assert.notEqual(res.body.tasks.state, "unjudgeable", "a read-only database does not stop the task check from reading");
    } finally {
      restoreWrites();
    }
  });
});
