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
  __setOperationsFetchForTest,
  classifyIssue,
  readRecentIncidents,
} from "../routes/adminOperations.js";
import { __setAlertCaptureForTest, alertTitle, reportOperationalAlert } from "../lib/operationalAlerts.js";
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
];

describe("/admin/operations", () => {
  let adminId: string;
  let memberId: string;
  const captured: Array<{ message: string; context: unknown }> = [];

  before(async () => {
    adminId = await createUser(true);
    memberId = await createUser(false);
    __setAlertCaptureForTest((message, context) => { captured.push({ message, context }); });
  });

  afterEach(() => {
    captured.length = 0;
    __setOperationsFetchForTest(null);
  });

  after(async () => {
    __setAlertCaptureForTest(null);
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

  it("sends a test alert tagged with its source", async () => {
    const res = await request(buildTestApp({ kind: "authenticated", userId: adminId }, adminOperationsRouter))
      .post("/api/admin/operations/test-alert");
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.message, alertTitle("test"));
    const ctx = captured[0]!.context as { tags: Record<string, string>; fingerprint: string[] };
    assert.equal(ctx.tags["alert_source"], "test");
    assert.deepEqual(ctx.fingerprint, ["operational-alert", "test"]);
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

  it("maps Sentry issues to sources", async () => {
    __setOperationsFetchForTest(async () => new Response(JSON.stringify([
      { title: alertTitle("unrecorded_spend"), lastSeen: "2026-11-17T23:00:00Z", count: "2", permalink: "https://s/1" },
      { title: "Downtime detected for https://overhype.me/", issueCategory: "uptime", lastSeen: "2026-11-17T22:00:00Z", count: "1", permalink: "https://s/2" },
      { title: "TypeError: x is undefined", issueCategory: "error", lastSeen: "2026-11-17T21:00:00Z", count: "7", permalink: "https://s/3" },
    ]), { status: 200 }));
    const list = await readRecentIncidents("token");
    assert.equal(list.status, "ok");
    if (list.status !== "ok") return;
    assert.deepEqual(list.incidents.map((i) => i.source), ["unrecorded_spend", "site_down", "error"]);
    assert.equal(list.incidents[0]!.count, 2);
  });

  it("reports unavailable, never an empty list, when Sentry refuses or cannot be reached", async () => {
    __setOperationsFetchForTest(async () => new Response("no", { status: 401 }));
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "unreachable" });
    __setOperationsFetchForTest(async () => { throw new Error("network down"); });
    assert.deepEqual(await readRecentIncidents("token"), { status: "unavailable", reason: "unreachable" });
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
