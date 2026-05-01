/**
 * Tests for the meme rejection reason flow (Task #327).
 *
 * Covers three requirements:
 *  1. The reject endpoint persists the rejectionReason to pending_reviews.reason.
 *  2. buildReviewRejectedEmail includes the human-readable reason label in both
 *     the text and HTML bodies when a reason is provided.
 *  3. The endpoint returns 400 when an unknown reason value is supplied.
 *
 * DB-backed tests use the shared buildTestApp helper (auth stub pattern from
 * task #324) and clean up their own rows after each test.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { pendingReviewsTable, usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import reviewsRouter from "../routes/reviews.js";
import { buildReviewRejectedEmail } from "../lib/email.js";
import { buildTestApp } from "./helpers/buildTestApp.js";


// ── DB helpers ────────────────────────────────────────────────────────────────

async function createTestUser(opts: { isAdmin: boolean }) {
  const id = `t327_${randomUUID()}`;
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

async function insertPendingReview() {
  const [row] = await db
    .insert(pendingReviewsTable)
    .values({ submittedText: "t327 test fact submission" })
    .returning();
  return row!;
}

async function getReview(id: number) {
  const [row] = await db
    .select()
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, id));
  return row ?? null;
}

async function cleanupTestReviews() {
  await db
    .delete(pendingReviewsTable)
    .where(eq(pendingReviewsTable.submittedText, "t327 test fact submission"));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function startServer(app: ReturnType<typeof buildTestApp>): Promise<http.Server> {
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

function postJson(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json",
        },
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
    req.write(payload);
    req.end();
  });
}

// ── Unit tests: buildReviewRejectedEmail ──────────────────────────────────────

describe("buildReviewRejectedEmail – reason label", () => {
  const REASONS = [
    {
      reason: "duplicate",
      expectedLabel: "Duplicate — this fact is too similar to one already in the database.",
    },
    {
      reason: "spam",
      expectedLabel: "Spam — this submission doesn't meet our community guidelines.",
    },
    {
      reason: "offensive",
      expectedLabel: "Offensive — this fact contains content that violates our standards.",
    },
  ] as const;

  for (const { reason, expectedLabel } of REASONS) {
    it(`includes the "${reason}" label in the plain-text body`, () => {
      const { text } = buildReviewRejectedEmail({
        username: "TestUser",
        submittedText: "Some submitted fact",
        rejectionReason: reason,
      });
      assert.ok(
        text.includes(expectedLabel),
        `text body for reason "${reason}" should contain: ${expectedLabel}\n\nActual:\n${text}`,
      );
    });

    it(`includes the "${reason}" label in the HTML body`, () => {
      const { html } = buildReviewRejectedEmail({
        username: "TestUser",
        submittedText: "Some submitted fact",
        rejectionReason: reason,
      });
      assert.ok(html != null, "html should be defined");
      assert.ok(
        html.includes(expectedLabel),
        `HTML body for reason "${reason}" should contain: ${expectedLabel}`,
      );
    });
  }

  it("omits the reason section when no reason is provided", () => {
    const { text } = buildReviewRejectedEmail({
      username: "TestUser",
      submittedText: "Some submitted fact",
    });
    assert.ok(
      !text.includes("Reason:"),
      `text body should not contain a 'Reason:' line when no reason is given:\n${text}`,
    );
  });

  it("omits the reason section in HTML when no reason is provided", () => {
    const { html } = buildReviewRejectedEmail({
      username: "TestUser",
      submittedText: "Some submitted fact",
    });
    assert.ok(html != null, "html should be defined");
    assert.ok(
      !html.includes("<strong style=\"color:#ffffff;\">Reason:</strong>"),
      "HTML body should not include a reason block when no reason is given",
    );
  });
});

// ── Integration tests: POST /admin/reviews/:id/reject ─────────────────────────

describe("POST /admin/reviews/:id/reject – reason persistence", () => {
  let adminUserId: string;
  let server: http.Server;

  before(async () => {
    adminUserId = await createTestUser({ isAdmin: true });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, reviewsRouter);
    server = await startServer(app);
  });

  after(async () => {
    await closeServer(server);
    await cleanupTestReviews();
    await deleteTestUser(adminUserId);
  });

  beforeEach(async () => {
    await cleanupTestReviews();
  });

  it("persists 'duplicate' as the reason in pending_reviews.reason", async () => {
    const review = await insertPendingReview();

    const { status, body } = await postJson(
      server,
      `/api/admin/reviews/${review.id}/reject`,
      { rejectionReason: "duplicate" },
    );

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body["success"], true, "body.success should be true");

    const updated = await getReview(review.id);
    assert.ok(updated, "review row should still exist after rejection");
    assert.equal(updated.status, "rejected", "status should be updated to rejected");
    assert.equal(updated.reason, "duplicate", "reason should be persisted as 'duplicate'");
  });

  it("persists 'spam' as the reason in pending_reviews.reason", async () => {
    const review = await insertPendingReview();

    const { status } = await postJson(
      server,
      `/api/admin/reviews/${review.id}/reject`,
      { rejectionReason: "spam" },
    );

    assert.equal(status, 200, `expected 200 for spam rejection`);

    const updated = await getReview(review.id);
    assert.equal(updated?.reason, "spam", "reason should be persisted as 'spam'");
  });

  it("persists 'offensive' as the reason in pending_reviews.reason", async () => {
    const review = await insertPendingReview();

    const { status } = await postJson(
      server,
      `/api/admin/reviews/${review.id}/reject`,
      { rejectionReason: "offensive" },
    );

    assert.equal(status, 200, `expected 200 for offensive rejection`);

    const updated = await getReview(review.id);
    assert.equal(updated?.reason, "offensive", "reason should be persisted as 'offensive'");
  });

  it("returns 400 when rejectionReason is omitted (now required)", async () => {
    const review = await insertPendingReview();

    const { status } = await postJson(
      server,
      `/api/admin/reviews/${review.id}/reject`,
      {},
    );

    assert.equal(status, 400, "expected 400 when rejectionReason is missing");

    const notUpdated = await getReview(review.id);
    assert.equal(notUpdated?.status, "pending", "review should remain pending when request is invalid");
  });
});

// ── Integration tests: validation ─────────────────────────────────────────────

describe("POST /admin/reviews/:id/reject – input validation", () => {
  let adminUserId: string;
  let server: http.Server;

  before(async () => {
    adminUserId = await createTestUser({ isAdmin: true });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, reviewsRouter);
    server = await startServer(app);
  });

  after(async () => {
    await closeServer(server);
    await cleanupTestReviews();
    await deleteTestUser(adminUserId);
  });

  beforeEach(async () => {
    await cleanupTestReviews();
  });

  it("returns 400 when rejectionReason is an unknown value", async () => {
    const review = await insertPendingReview();

    const { status, body } = await postJson(
      server,
      `/api/admin/reviews/${review.id}/reject`,
      { rejectionReason: "not_a_valid_reason" },
    );

    assert.equal(status, 400, `expected 400 for unknown reason, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      typeof body["error"] === "string" && body["error"].length > 0,
      "response body should include an error message",
    );

    const notUpdated = await getReview(review.id);
    assert.equal(
      notUpdated?.status,
      "pending",
      "review status must remain 'pending' when request is rejected with 400",
    );
  });
});
