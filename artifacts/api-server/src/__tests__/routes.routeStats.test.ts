/**
 * Integration tests for routes/routeStats.ts.
 *
 * Two endpoints, both exercised against the real test DB.
 * - GET /route-stats:  top-N most-visited routes, capped at 10.
 * - POST /route-stats: increment-on-conflict counter + append-only event row.
 *
 * route_stats / route_stat_events aren't touched by any other test file in
 * the repo, so each test owns the tables and truncates them in beforeEach.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { routeStatsTable, routeStatEventsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import routeStatsRouter from "../routes/routeStats.js";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // pino-http normally attaches req.log; supply a stub so the catch branch in
  // the handler can call req.log.warn() without crashing under test.
  app.use((req, _res, next) => {
    (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
    next();
  });
  app.use(routeStatsRouter);
  return app;
}

async function cleanup(): Promise<void> {
  await db.delete(routeStatEventsTable);
  await db.delete(routeStatsTable);
}

describe("GET /route-stats", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns empty arrays when no rows exist", async () => {
    const res = await request(makeApp()).get("/route-stats");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { routes: [], stats: [] });
  });

  it("returns the top 3 by default, ordered by visitCount desc", async () => {
    await db.insert(routeStatsTable).values([
      { routeKey: "home",     visitCount: 100 },
      { routeKey: "search",   visitCount: 50 },
      { routeKey: "profile",  visitCount: 25 },
      { routeKey: "facts",    visitCount: 5 },
    ]);

    const res = await request(makeApp()).get("/route-stats");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.routes, ["home", "search", "profile"]);
    assert.equal(res.body.stats.length, 3);
    assert.deepEqual(res.body.stats[0], { routeKey: "home", visitCount: 100 });
  });

  it("respects ?n", async () => {
    await db.insert(routeStatsTable).values([
      { routeKey: "home",     visitCount: 100 },
      { routeKey: "search",   visitCount: 50 },
      { routeKey: "profile",  visitCount: 25 },
      { routeKey: "facts",    visitCount: 5 },
    ]);
    const res = await request(makeApp()).get("/route-stats").query({ n: "2" });
    assert.equal(res.body.routes.length, 2);
  });

  it("caps ?n at 10", async () => {
    const rows = ["home","search","facts","submit","profile","activity","meme","video","pricing"]
      .map((k, i) => ({ routeKey: k, visitCount: 10 - i }));
    await db.insert(routeStatsTable).values(rows);
    const res = await request(makeApp()).get("/route-stats").query({ n: "999" });
    assert.ok(res.body.routes.length <= 10);
  });

  it("falls back to n=3 when ?n is non-numeric", async () => {
    await db.insert(routeStatsTable).values([
      { routeKey: "home", visitCount: 5 },
      { routeKey: "search", visitCount: 4 },
      { routeKey: "facts", visitCount: 3 },
      { routeKey: "submit", visitCount: 2 },
    ]);
    const res = await request(makeApp()).get("/route-stats").query({ n: "garbage" });
    assert.equal(res.body.routes.length, 3);
  });
});

describe("POST /route-stats", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 400 with 'Invalid body' when the body is empty", async () => {
    const res = await request(makeApp()).post("/route-stats").send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid body" });
  });

  it("returns 400 with 'Invalid body' when route is the wrong type", async () => {
    const res = await request(makeApp()).post("/route-stats").send({ route: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid body" });
  });

  it("returns 400 with 'Unknown route key' for a string that's not in the allowlist", async () => {
    const res = await request(makeApp()).post("/route-stats").send({ route: "secret-admin-page" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Unknown route key" });
  });

  it("creates a new row with visitCount=1 on the first hit and returns 204", async () => {
    const res = await request(makeApp()).post("/route-stats").send({ route: "home" });
    assert.equal(res.status, 204);

    const [row] = await db
      .select()
      .from(routeStatsTable)
      .where(eq(routeStatsTable.routeKey, "home"));
    assert.ok(row);
    assert.equal(row.visitCount, 1);

    const events = await db
      .select()
      .from(routeStatEventsTable)
      .where(eq(routeStatEventsTable.routeKey, "home"));
    assert.equal(events.length, 1);
    assert.equal(events[0].delta, 1);
  });

  it("increments visitCount on subsequent hits to the same route key", async () => {
    await request(makeApp()).post("/route-stats").send({ route: "search" });
    await request(makeApp()).post("/route-stats").send({ route: "search" });
    await request(makeApp()).post("/route-stats").send({ route: "search" });

    const [row] = await db
      .select()
      .from(routeStatsTable)
      .where(eq(routeStatsTable.routeKey, "search"));
    assert.equal(row.visitCount, 3);

    const events = await db
      .select()
      .from(routeStatEventsTable)
      .where(eq(routeStatEventsTable.routeKey, "search"));
    assert.equal(events.length, 3);
  });

  it("accepts every route key in the documented allowlist", async () => {
    const keys = ["home","search","facts","submit","profile","activity","meme","video","pricing"];
    for (const k of keys) {
      const res = await request(makeApp()).post("/route-stats").send({ route: k });
      assert.equal(res.status, 204, `expected 204 for ${k}`);
    }
  });
});
