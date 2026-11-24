/**
 * The admin Operations API (launch Phase 16, Issue #1029):
 *  - both routes are admin-only;
 *  - the test alert goes out through the operational-alert reporter;
 *  - recent incidents come from Sentry, and a Sentry that cannot be read is
 *    reported as "unavailable", never as an empty list;
 *  - the reporter never throws, even when Sentry's capture does.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import adminOperationsRouter, {
  CRASH_DRILL_MESSAGE,
  __setCrashSchedulerForTest,
  __resetIncidentCacheForTest,
  __setOperationsLimiterForTest,
  __setOperationsFetchForTest,
  classifyIssue,
  readRecentIncidents,
  readRecentIncidentsCached,
} from "../routes/adminOperations.js";
import { __setAlertCaptureForTest, __setAlertReadinessForTest, alertTitle, reportOperationalAlert } from "../lib/operationalAlerts.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "tops-";

async function createUser(isAdmin: boolean): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@example.test`, profileImageUrl: null, isAdmin });
  return id;
}

const ROUTES: Array<{ method: "get" | "post"; path: string }> = [
  { method: "get", path: "/admin/operations" },
  { method: "post", path: "/admin/operations/test-alert" },
  { method: "post", path: "/admin/operations/crash-drill" },
];

describe("/admin/operations", () => {
  let adminId: string;
  let memberId: string;
  const captured: Array<{ message: string; context: unknown }> = [];
  const crashes: Error[] = [];

  before(async () => {
    adminId = await createUser(true);
    memberId = await createUser(false);
    __setAlertCaptureForTest((message, context) => { captured.push({ message, context }); });
    __setAlertReadinessForTest(() => true);
    __setCrashSchedulerForTest((err) => { crashes.push(err); });
  });

  afterEach(() => {
    captured.length = 0;
    crashes.length = 0;
    __setOperationsFetchForTest(null);
    __resetIncidentCacheForTest();
    __setOperationsLimiterForTest(null);
    __setAlertReadinessForTest(() => true);
  });

  after(async () => {
    __setCrashSchedulerForTest(null);
    __setAlertCaptureForTest(null);
    __setAlertReadinessForTest(null);
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} refuses a visitor and a member`, async () => {
      const anon = await request(buildTestApp({ kind: "unauthenticated" }, adminOperationsRouter))[route.method](`/api${route.path}`);
      assert.equal(anon.status, 401);
      const member = await request(buildTestApp({ kind: "authenticated", userId: memberId }, adminOperationsRouter))[route.method](`/api${route.path}`);
      assert.equal(member.status, 403);
    });
  }

  it("the crash drill ends the process only when an admin confirms it, and answers first", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter);
    const unconfirmed = await request(app).post("/api/admin/operations/crash-drill").send({});
    assert.equal(unconfirmed.status, 400);
    const wrong = await request(app).post("/api/admin/operations/crash-drill").send({ confirm: "yes" });
    assert.equal(wrong.status, 400);
    assert.equal(crashes.length, 0, "nothing is scheduled without the exact confirmation");

    const res = await request(app).post("/api/admin/operations/crash-drill").send({ confirm: "crash" });
    assert.equal(res.status, 200);
    assert.equal(res.body.crashing, true);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]!.message, CRASH_DRILL_MESSAGE);
  });

  it("a member's confirmed crash drill schedules nothing", async () => {
    const res = await request(buildTestApp({ kind: "authenticated", userId: memberId }, adminOperationsRouter))
      .post("/api/admin/operations/crash-drill").send({ confirm: "crash" });
    assert.equal(res.status, 403);
    assert.equal(crashes.length, 0);
  });

  it("sends a test alert tagged with its source", async () => {
    const res = await request(buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter))
      .post("/api/admin/operations/test-alert");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.rings, "boolean");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.message, alertTitle("test"));
    const ctx = captured[0]!.context as { tags: Record<string, string>; fingerprint: string[] };
    assert.equal(ctx.tags["alert_source"], "test");
    assert.deepEqual(ctx.fingerprint, ["operational-alert", "test"]);
  });

  it("says a test alert was not sent when the server is not connected to Sentry", async () => {
    __setAlertReadinessForTest(() => false);
    const res = await request(buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter))
      .post("/api/admin/operations/test-alert");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sent: false, reason: "not_connected" });
    assert.equal(captured.length, 0);
  });

  it("keeps working when the rate-limit counter cannot be saved", async () => {
    __setOperationsLimiterForTest(async () => { throw new Error("cannot execute INSERT in a read-only transaction"); });
    const saved = process.env["SENTRY_API_TOKEN"];
    process.env["SENTRY_API_TOKEN"] = "token";
    __setOperationsFetchForTest(async () => new Response(JSON.stringify([
      { title: "TypeError: x", status: "resolved", lastSeen: "2026-11-17T21:00:00Z", count: "1", permalink: "https://s/9" },
    ]), { status: 200 }));
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter);
      const read = await request(app).get("/api/admin/operations");
      assert.equal(read.status, 200);
      assert.equal(read.body.lanes.status, "ok");
      assert.equal(read.body.incidents.status, "ok");
      const alert = await request(app).post("/api/admin/operations/test-alert");
      assert.equal(alert.status, 200);
      assert.equal(alert.body.sent, true);
      assert.equal(captured.length, 1);
    } finally {
      if (saved === undefined) delete process.env["SENTRY_API_TOKEN"]; else process.env["SENTRY_API_TOKEN"] = saved;
    }
  });

  it("still refuses past the limit when the counter works", async () => {
    __setOperationsLimiterForTest(async () => ({ allowed: false }) as Awaited<ReturnType<typeof import("../lib/sharedRateLimiter.js").checkSharedRateLimit>>);
    const res = await request(buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter)).get("/api/admin/operations");
    assert.equal(res.status, 429);
  });

  it("shows the live lane state and says incidents are unavailable when no Sentry token is set", async () => {
    const saved = process.env["SENTRY_API_TOKEN"];
    delete process.env["SENTRY_API_TOKEN"];
    try {
      const res = await request(buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter))
        .get("/api/admin/operations");
      assert.equal(res.status, 200);
      assert.equal(res.body.lanes.status, "ok");
      assert.ok(Array.isArray(res.body.lanes.lanes));
      assert.deepEqual(res.body.incidents, { status: "unavailable", reason: "not_configured" });
    } finally {
      if (saved !== undefined) process.env["SENTRY_API_TOKEN"] = saved;
    }
  });
});

describe("readRecentIncidents", () => {
  afterEach(() => __setOperationsFetchForTest(null));

  it("asks Sentry for resolved and open incidents, and maps them to sources", async () => {
    let requested = "";
    __setOperationsFetchForTest(async (input) => {
      requested = String(input);
      return new Response(JSON.stringify([
        { title: alertTitle("unrecorded_spend"), status: "unresolved", lastSeen: "2026-11-17T23:00:00Z", count: "2", permalink: "https://s/1" },
        // The real shape of a recovered uptime incident (SENTRY_PROJECT_BACKEND-16).
        { title: "Downtime detected for https://overhype.me/", issueCategory: "outage", status: "resolved", lastSeen: "2026-11-17T22:00:00Z", count: "1", permalink: "https://s/2" },
        { title: "TypeError: x is undefined", issueCategory: "error", status: "resolved", lastSeen: "2026-11-17T21:00:00Z", count: "7", permalink: "https://s/3" },
      ]), { status: 200 });
    });
    const list = await readRecentIncidents("token");
    const url = new URL(requested);
    assert.equal(url.searchParams.get("query"), "", "an explicit empty query; Sentry defaults to is:unresolved");
    assert.equal(url.searchParams.get("environment"), "production");
    assert.equal(list.status, "ok");
    if (list.status !== "ok") return;
    assert.deepEqual(list.incidents.map((i) => i.source), ["unrecorded_spend", "site_down", "error"]);
    assert.deepEqual(list.incidents.map((i) => i.label), ["Spend not recorded", "Site down", "Error"]);
    assert.equal(list.incidents[0]!.count, 2);
    assert.deepEqual(list.incidents.map((i) => i.ongoing), [true, false, false]);
  });

  it("reports unavailable, never an empty list, when Sentry refuses or cannot be reached", async () => {
    // #1055: production's key was rejected ({"detail":"Invalid token"}, 401) and
    // the page said Sentry "could not be reached". A rejected key is its own reason.
    __setOperationsFetchForTest(async () => new Response(JSON.stringify({ detail: "Invalid token" }), { status: 401 }));
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "refused" });
    __setOperationsFetchForTest(async () => new Response("no", { status: 403 }));
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "refused" });
    __setOperationsFetchForTest(async () => new Response("no", { status: 503 }));
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "unreachable" });
    __setOperationsFetchForTest(async () => { throw new Error("network down"); });
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "unreachable" });
  });

  it("asks Sentry once for concurrent and repeated reads, and does not cache an unavailable answer", async () => {
    const saved = process.env["SENTRY_API_TOKEN"];
    process.env["SENTRY_API_TOKEN"] = "token";
    let calls = 0;
    try {
      __resetIncidentCacheForTest();
      __setOperationsFetchForTest(async () => { calls++; return new Response("no", { status: 503 }); });
      await readRecentIncidentsCached();
      await readRecentIncidentsCached();
      assert.equal(calls, 2, "an unavailable answer is asked again");
      calls = 0;
      __setOperationsFetchForTest(async () => { calls++; return new Response("[]", { status: 200 }); });
      await Promise.all([readRecentIncidentsCached(), readRecentIncidentsCached()]);
      await readRecentIncidentsCached();
      assert.equal(calls, 1);
    } finally {
      __resetIncidentCacheForTest();
      if (saved === undefined) delete process.env["SENTRY_API_TOKEN"]; else process.env["SENTRY_API_TOKEN"] = saved;
    }
  });

  it("classifies by title before category", () => {
    assert.equal(classifyIssue({ title: alertTitle("job_failed"), issueCategory: "error" }), "job_failed");
    assert.equal(classifyIssue({ title: "anything", issueType: "uptime_domain_failure" }), "site_down");
  });
});

describe("reportOperationalAlert", () => {
  after(() => __setAlertCaptureForTest(null));

  it("never throws when Sentry's capture throws", () => {
    __setAlertCaptureForTest(() => { throw new Error("sentry down"); });
    assert.doesNotThrow(() => reportOperationalAlert("payment_webhook_failed", { eventType: "invoice.paid" }));
  });
});
