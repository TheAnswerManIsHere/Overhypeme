/**
 * Integration tests for DELETE /admin/email-queue (Task #259).
 *
 * Verifies that the endpoint:
 *  - deletes only rows with the requested status (delivered or abandoned)
 *  - leaves rows with other statuses untouched
 *  - rejects missing or invalid status query params with 400
 *  - returns 401 for unauthenticated requests
 *  - returns 403 for authenticated non-admin requests
 *
 * Each test manages its own DB rows (prefixed "t259_test") and cleans up
 * after itself. A shared HTTP test server (started once per sub-suite) is used
 * for all request assertions.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { emailOutboxTable, usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import adminRouter from "../routes/admin.js";

const TEST_TAG = "t259_test";

// ── DB helpers ────────────────────────────────────────────────────────────────

async function insertOutboxRow(status: string) {
  const [row] = await db.insert(emailOutboxTable).values({
    to:            "test@example.com",
    subject:       "Test subject",
    text:          "Test body",
    html:          "<p>Test</p>",
    kind:          TEST_TAG,
    status,
    attempts:      1,
    maxAttempts:   5,
    nextAttemptAt: new Date(),
  }).returning();
  return row!;
}

async function getTestRows() {
  return db.select().from(emailOutboxTable).where(eq(emailOutboxTable.kind, TEST_TAG));
}

async function cleanupTestOutboxRows() {
  await db.delete(emailOutboxTable).where(eq(emailOutboxTable.kind, TEST_TAG));
}

async function truncateEntireOutbox() {
  await db.delete(emailOutboxTable);
}

async function createTestUser(opts: { isAdmin: boolean }) {
  const id = `t259_${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    membershipTier: "registered",
    isAdmin: opts.isAdmin,
  });
  return id;
}

async function deleteTestUser(id: string) {
  await db.delete(usersTable).where(eq(usersTable.id, id));
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

type FakeAuth =
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; userId: string };

/**
 * Build a minimal Express app that mounts the real admin router.
 * A stub middleware installed before the router injects req.user (and
 * req.isAuthenticated) so the requireAdmin middleware can make real decisions
 * against the database without needing real session cookies.
 */
function buildTestApp(auth: FakeAuth): express.Express {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (auth.kind === "authenticated") {
      req.user = { id: auth.userId };
    }
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });

  app.use("/api", adminRouter);
  return app;
}

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function deleteRequest(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "DELETE",
        headers: { Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe("DELETE /admin/email-queue", () => {
  let adminUserId: string;
  let nonAdminUserId: string;

  before(async () => {
    adminUserId    = await createTestUser({ isAdmin: true });
    nonAdminUserId = await createTestUser({ isAdmin: false });
  });

  after(async () => {
    await cleanupTestOutboxRows();
    await deleteTestUser(adminUserId);
    await deleteTestUser(nonAdminUserId);
  });

  beforeEach(async () => {
    await cleanupTestOutboxRows();
  });

  // ── Authorisation ──────────────────────────────────────────────────────────

  describe("auth enforcement", () => {
    it("returns 401 for unauthenticated requests", async () => {
      const app    = buildTestApp({ kind: "unauthenticated" });
      const server = await startServer(app);
      try {
        const { status } = await deleteRequest(
          server,
          "/api/admin/email-queue?status=delivered",
        );
        assert.equal(status, 401, "unauthenticated request should receive 401");
      } finally {
        await closeServer(server);
      }
    });

    it("returns 403 for authenticated non-admin requests", async () => {
      const app    = buildTestApp({ kind: "authenticated", userId: nonAdminUserId });
      const server = await startServer(app);
      try {
        const { status } = await deleteRequest(
          server,
          "/api/admin/email-queue?status=delivered",
        );
        assert.equal(status, 403, "non-admin request should receive 403");
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe("status param validation", () => {
    let server: http.Server;

    before(async () => {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId });
      server    = await startServer(app);
    });

    after(async () => {
      await closeServer(server);
    });

    it("returns 400 when status param is missing", async () => {
      const { status, body } = await deleteRequest(server, "/api/admin/email-queue");
      assert.equal(status, 400, "missing status should return 400");
      assert.ok(
        typeof body["error"] === "string" && body["error"].length > 0,
        "response body should include an error message",
      );
    });

    it("returns 400 when status param is invalid", async () => {
      const { status, body } = await deleteRequest(
        server,
        "/api/admin/email-queue?status=unknown",
      );
      assert.equal(status, 400, "invalid status should return 400");
      assert.ok(
        typeof body["error"] === "string" && body["error"].length > 0,
        "response body should include an error message",
      );
    });

    it("returns 400 when status is pending (non-terminal status)", async () => {
      const { status } = await deleteRequest(
        server,
        "/api/admin/email-queue?status=pending",
      );
      assert.equal(status, 400, "pending is not a clearable status");
    });
  });

  // ── Deletion isolation ─────────────────────────────────────────────────────

  describe("deletion isolation", () => {
    let server: http.Server;

    before(async () => {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId });
      server    = await startServer(app);
    });

    after(async () => {
      await closeServer(server);
    });

    it("deleting delivered removes only delivered rows", async () => {
      const d1 = await insertOutboxRow("delivered");
      const d2 = await insertOutboxRow("delivered");
      const ab = await insertOutboxRow("abandoned");
      const pe = await insertOutboxRow("pending");

      const { status, body } = await deleteRequest(
        server,
        "/api/admin/email-queue?status=delivered",
      );

      assert.equal(status, 200, "should succeed with 200");
      assert.equal(body["success"], true, "body.success should be true");
      assert.ok(
        typeof body["deleted"] === "number" && (body["deleted"] as number) >= 2,
        `deleted count should be at least 2, got ${body["deleted"]}`,
      );

      const remaining = await getTestRows();
      const remainingIds = new Set(remaining.map((r) => r.id));

      assert.ok(!remainingIds.has(d1.id), "first delivered row must be removed");
      assert.ok(!remainingIds.has(d2.id), "second delivered row must be removed");
      assert.ok(remainingIds.has(ab.id),  "abandoned row must remain");
      assert.ok(remainingIds.has(pe.id),  "pending row must remain");
    });

    it("deleting abandoned removes only abandoned rows", async () => {
      const a1 = await insertOutboxRow("abandoned");
      const a2 = await insertOutboxRow("abandoned");
      const dl = await insertOutboxRow("delivered");
      const pe = await insertOutboxRow("pending");

      const { status, body } = await deleteRequest(
        server,
        "/api/admin/email-queue?status=abandoned",
      );

      assert.equal(status, 200, "should succeed with 200");
      assert.equal(body["success"], true, "body.success should be true");
      assert.ok(
        typeof body["deleted"] === "number" && (body["deleted"] as number) >= 2,
        `deleted count should be at least 2, got ${body["deleted"]}`,
      );

      const remaining = await getTestRows();
      const remainingIds = new Set(remaining.map((r) => r.id));

      assert.ok(!remainingIds.has(a1.id), "first abandoned row must be removed");
      assert.ok(!remainingIds.has(a2.id), "second abandoned row must be removed");
      assert.ok(remainingIds.has(dl.id),  "delivered row must remain");
      assert.ok(remainingIds.has(pe.id),  "pending row must remain");
    });

    it("reports deleted=0 and leaves non-matching rows intact when the table has no target-status rows", async () => {
      await truncateEntireOutbox();
      const pe = await insertOutboxRow("pending");

      const { status, body } = await deleteRequest(
        server,
        "/api/admin/email-queue?status=delivered",
      );

      assert.equal(status, 200, "should succeed with 200 even when nothing is deleted");
      assert.equal(body["success"], true);
      assert.equal(body["deleted"], 0, "should report 0 when no delivered rows exist");

      const remaining = await getTestRows();
      const remainingIds = new Set(remaining.map((r) => r.id));
      assert.ok(remainingIds.has(pe.id), "pending row must still exist");
    });
  });
});
