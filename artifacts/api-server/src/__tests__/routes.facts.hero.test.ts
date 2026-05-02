/**
 * Integration tests for GET /facts/hero in routes/facts.ts.
 *
 * The hero endpoint surfaces the home-page billboard via a weighted-random
 * pick from the top-50 wilson-ranked active root facts.  It honors a
 * client-supplied `?exclude=id1,id2` query param for short-list de-dup,
 * additionally excludes anything already shown when called by an
 * authenticated user, and persists `last_seen_as_hero_at` into
 * `user_fact_preferences` after each pick (auth users only, best-effort).
 *
 * These tests cover:
 *   - Returns one of the top-N wilson-ranked facts (sanity check ranking).
 *   - Honors `?exclude=id1,id2` and never returns excluded IDs.
 *   - For authenticated users, writes `last_seen_as_hero_at` into
 *     `user_fact_preferences` after the response (best-effort upsert).
 *   - For unauthenticated users, does NOT write to the table.
 *   - Falls back gracefully when the candidate pool is small or every
 *     candidate has wilsonScore=0 (epsilon floor in the weighting).
 *
 * Test isolation: each test creates its own user via a dedicated prefix and
 * inserts test-owned facts.  The before/after hooks delete every fact whose
 * submitter matches the prefix and then the users themselves; the cascade on
 * `user_fact_preferences.user_id` cleans the preference rows on user delete.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  userFactPreferencesTable,
} from "@workspace/db/schema";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";

import factsRouter from "../routes/facts.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "t_routes_hero_";

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local` });
  return id;
}

async function insertHeroFact(opts: {
  text: string;
  wilsonScore?: number;
  submittedById?: string;
}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({
      text: opts.text,
      submittedById: opts.submittedById,
      isActive: true,
      canonicalText: opts.text,
      wilsonScore: opts.wilsonScore ?? 0,
    })
    .returning();
  return row.id;
}

/**
 * The route persists `last_seen_as_hero_at` via a fire-and-forget `void
 * db.insert(...)` after the response is sent, so a naïve query right after
 * the supertest call may race the write.  Poll with a short timeout.
 */
async function waitForHeroPref(
  userId: string,
  factId: number,
  timeoutMs = 2000,
): Promise<Date | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await db
      .select()
      .from(userFactPreferencesTable)
      .where(
        and(
          eq(userFactPreferencesTable.userId, userId),
          eq(userFactPreferencesTable.factId, factId),
        ),
      );
    if (row?.lastSeenAsHeroAt) return row.lastSeenAsHeroAt;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    // user_fact_preferences cascades on user delete; deleting our facts also
    // cascades to any preference rows other users wrote against them.
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("GET /facts/hero — ranking sanity", () => {
  it("returns a fact drawn from the top-50 wilson-ranked pool", async () => {
    const userId = await createTestUser();
    // Make sure at least one of our facts is provably in the top-50 by
    // assigning it a wilsonScore at the ceiling (1.0).  We assert against
    // the dynamic top-50 set rather than a fixed identity because the
    // existing DB may already host other facts at the ceiling.
    await insertHeroFact({ text: "hero-rank-1", wilsonScore: 1.0, submittedById: userId });
    await insertHeroFact({ text: "hero-rank-2", wilsonScore: 1.0, submittedById: userId });
    await insertHeroFact({ text: "hero-rank-3", wilsonScore: 1.0, submittedById: userId });

    // Mirror the route's pool filters exactly: active root facts only
    // (variants, parentId IS NOT NULL, are excluded by the route).
    const top50 = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.isActive, true), isNull(factsTable.parentId)))
      .orderBy(desc(factsTable.wilsonScore))
      .limit(50);
    const top50Ids = new Set(top50.map((r) => r.id));

    const res = await request(
      buildTestApp({ kind: "unauthenticated" }, factsRouter),
    ).get("/api/facts/hero");

    assert.equal(res.status, 200);
    assert.ok(res.body.fact, "response should contain a fact");
    assert.ok(
      top50Ids.has(res.body.fact.id),
      `picked id ${res.body.fact.id} should be one of the top-50 wilson-ranked facts`,
    );
    assert.equal(typeof res.body.poolSize, "number");
    assert.ok(res.body.poolSize > 0, "poolSize should be positive");
  });
});

describe("GET /facts/hero — exclude param", () => {
  it("never returns an excluded id across repeated samples", async () => {
    const userId = await createTestUser();
    const a = await insertHeroFact({ text: "hero-ex-a", wilsonScore: 1.0, submittedById: userId });
    const b = await insertHeroFact({ text: "hero-ex-b", wilsonScore: 1.0, submittedById: userId });

    const exclude = `${a},${b}`;
    // The pick is stochastic, but the SQL `NOT IN` filter is absolute —
    // excluded ids should never appear regardless of how many samples we
    // draw.  Ten samples is enough to guard against an accidental regression
    // that only sometimes filters.
    for (let i = 0; i < 10; i++) {
      const res = await request(
        buildTestApp({ kind: "unauthenticated" }, factsRouter),
      )
        .get("/api/facts/hero")
        .query({ exclude });
      assert.equal(res.status, 200);
      assert.notEqual(res.body.fact.id, a, "excluded id A came back");
      assert.notEqual(res.body.fact.id, b, "excluded id B came back");
    }
  });

  it("ignores garbage tokens in the exclude list and still returns a fact", async () => {
    const userId = await createTestUser();
    await insertHeroFact({ text: "hero-ex-garbage", wilsonScore: 1.0, submittedById: userId });

    const res = await request(
      buildTestApp({ kind: "unauthenticated" }, factsRouter),
    )
      .get("/api/facts/hero")
      .query({ exclude: "abc,,-1,0,not-a-number" });

    assert.equal(res.status, 200);
    assert.ok(res.body.fact);
  });
});

describe("GET /facts/hero — auth-side persistence", () => {
  it("writes last_seen_as_hero_at to user_fact_preferences for authenticated users", async () => {
    const userId = await createTestUser();
    await insertHeroFact({ text: "hero-auth-1", wilsonScore: 1.0, submittedById: userId });

    const res = await request(
      buildTestApp({ kind: "authenticated", userId }, factsRouter),
    ).get("/api/facts/hero");

    assert.equal(res.status, 200);
    const pickedId = res.body.fact.id as number;

    const seenAt = await waitForHeroPref(userId, pickedId);
    assert.ok(
      seenAt instanceof Date,
      "expected last_seen_as_hero_at to be persisted for the authed user",
    );
  });

  it("does NOT write user_fact_preferences for unauthenticated callers", async () => {
    const userId = await createTestUser();
    await insertHeroFact({ text: "hero-unauth", wilsonScore: 1.0, submittedById: userId });

    // Snapshot the preference-row count for every test-prefix user before
    // the request.  Since unauth has no userId of its own, the strongest
    // assertion is "no new row was written on behalf of any logged-in
    // user".  Scoping the count to our prefix keeps the test independent
    // of whatever other suites are inserting concurrently.
    async function countPrefRowsForPrefix(): Promise<number> {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userFactPreferencesTable)
        .innerJoin(usersTable, eq(usersTable.id, userFactPreferencesTable.userId))
        .where(like(usersTable.id, `${USER_PREFIX}%`));
      return count;
    }

    const before = await countPrefRowsForPrefix();

    const res = await request(
      buildTestApp({ kind: "unauthenticated" }, factsRouter),
    ).get("/api/facts/hero");
    assert.equal(res.status, 200);

    // Wait at least the same window the auth-write test polls for, so a
    // racing background insert would have settled by the time we check.
    await new Promise((r) => setTimeout(r, 250));

    const after = await countPrefRowsForPrefix();
    assert.equal(
      after,
      before,
      "unauthenticated /facts/hero must not insert into user_fact_preferences",
    );
  });
});

describe("GET /facts/hero — fallback / epsilon floor", () => {
  it("still returns a fact when the candidate pool is dominated by wilsonScore=0", async () => {
    const userId = await createTestUser();
    // Insert several zero-score facts and then exclude the top of the DB
    // so the remaining pool is dominated by zero-score candidates.  The
    // route's epsilon floor in the weighting math (`weight = max(score, 0) +
    // epsilon`) ensures `total > 0` even when every candidate weights to
    // zero, so a pick is always reachable.
    const z1 = await insertHeroFact({ text: "hero-zero-1", wilsonScore: 0, submittedById: userId });
    const z2 = await insertHeroFact({ text: "hero-zero-2", wilsonScore: 0, submittedById: userId });
    const z3 = await insertHeroFact({ text: "hero-zero-3", wilsonScore: 0, submittedById: userId });

    // Server caps the parsed exclude list at 100 ids; mirror that here.
    // Match the route's pool filters (active + root) so we exclude exactly
    // what would otherwise dominate the pool ahead of our z* facts.
    const exclusions = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.isActive, true), isNull(factsTable.parentId)))
      .orderBy(desc(factsTable.wilsonScore))
      .limit(100);
    const excludeIds = exclusions
      .map((r) => r.id)
      .filter((id) => id !== z1 && id !== z2 && id !== z3);

    const res = await request(
      buildTestApp({ kind: "unauthenticated" }, factsRouter),
    )
      .get("/api/facts/hero")
      .query({ exclude: excludeIds.join(",") });

    assert.equal(res.status, 200);
    assert.ok(res.body.fact, "expected a fact even when the pool is zero-scored");
    assert.ok(res.body.poolSize >= 1, "poolSize must be positive");
  });

  it("survives a maximally-large exclude list without 4xx/5xx", async () => {
    const userId = await createTestUser();
    await insertHeroFact({ text: "hero-fallback", wilsonScore: 1.0, submittedById: userId });

    // Build an exclude list of the top-100 active root facts (the server
    // slices `?exclude` at 100 ids regardless).  When the DB happens to
    // hold ≤ 100 active root facts in total, the route's first SELECT
    // returns zero rows and the fallback re-query without exclusions
    // takes over; when there are >100, the route still returns a fact
    // from positions 101+.  Either way the contract is the same: the
    // endpoint must respond 200 with a populated `fact`, never a 4xx /
    // 5xx, when given a saturated exclude list.
    const top = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.isActive, true), isNull(factsTable.parentId)))
      .orderBy(desc(factsTable.wilsonScore))
      .limit(100);
    const exclude = top.map((r) => r.id).join(",");

    const res = await request(
      buildTestApp({ kind: "unauthenticated" }, factsRouter),
    )
      .get("/api/facts/hero")
      .query({ exclude });

    assert.equal(res.status, 200);
    assert.ok(res.body.fact);
  });
});
