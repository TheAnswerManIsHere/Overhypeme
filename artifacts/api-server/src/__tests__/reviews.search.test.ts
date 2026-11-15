/**
 * GET /admin/reviews?q= — the moderation screen's search box.
 *
 * The search covers every page (it runs in the query, not on the loaded page),
 * matches the fact wording case-insensitively, matches a review number, treats
 * LIKE wildcards literally, and combines with the status filter.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { pendingReviewsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

import reviewsRouter from "../routes/reviews.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const TAG = `rsearch_${randomUUID().slice(0, 8)}`;

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

function getJson(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: { reviews: { id: number; submittedText: string }[]; total: number } }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    http
      .get(
        { hostname: "127.0.0.1", port: addr.port, path, headers: { Accept: "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
        },
      )
      .on("error", reject);
  });
}

describe("GET /admin/reviews – search (q)", () => {
  let server: http.Server;
  let adminId: string;
  const ids: Record<string, number> = {};

  before(async () => {
    adminId = `${TAG}_admin`;
    await db.insert(usersTable).values({ id: adminId, membershipTier: "registered", isAdmin: true });
    const rows = await db
      .insert(pendingReviewsTable)
      .values([
        { submittedText: `${TAG} Chuck pushes the Earth down` },
        { submittedText: `${TAG} granite chin` },
        { submittedText: `${TAG} 100% effort_level`, status: "approved" },
      ])
      .returning();
    ids["earth"] = rows[0]!.id;
    ids["granite"] = rows[1]!.id;
    ids["percent"] = rows[2]!.id;
    server = await startServer(buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter));
  });

  after(async () => {
    await closeServer(server);
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.id, Object.values(ids)));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  const search = async (q: string, status = "all") => {
    const r = await getJson(server, `/api/admin/reviews?status=${status}&limit=100&q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    return r.body;
  };

  it("matches the wording case-insensitively", async () => {
    const body = await search(`${TAG} CHUCK PUSHES`);
    assert.deepEqual(body.reviews.map((r) => r.id), [ids["earth"]]);
    assert.equal(body.total, 1);
  });

  it("matches a review number, with or without #", async () => {
    for (const q of [String(ids["granite"]), `#${ids["granite"]}`]) {
      const body = await search(q);
      assert.ok(body.reviews.some((r) => r.id === ids["granite"]), `q=${q} should find the review`);
    }
  });

  it("treats LIKE wildcards literally", async () => {
    // Literal % and _ still match themselves...
    assert.deepEqual((await search(`${TAG} 100%`)).reviews.map((r) => r.id), [ids["percent"]]);
    assert.deepEqual((await search(`100% effort_level`)).reviews.map((r) => r.id), [ids["percent"]]);
    // ...and never act as wildcards: "1%0" and "100_ " would match the "100% " row if they did.
    assert.equal((await search(`${TAG} 1%0`)).reviews.length, 0, "% must not match any run of characters");
    assert.equal((await search(`${TAG} 100_ effort`)).reviews.length, 0, "_ must not match one character");
  });

  it("combines with the status filter", async () => {
    assert.equal((await search(TAG, "pending")).total, 2);
    assert.equal((await search(TAG, "approved")).total, 1);
  });

  it("an empty query changes nothing", async () => {
    assert.ok((await search("")).total >= 3);
  });
});
