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
 * The hero endpoint also excludes facts whose submitter ID starts with `t`
 * (test user marker) so that test runs never pollute the live dev feed.
 * All tests here work against real DB facts rather than injecting synthetic
 * facts into the live hero pool.
 *
 * These tests cover:
 *   - Returns one of the top-N wilson-ranked real facts (sanity check ranking).
 *   - Honors `?exclude=id1,id2` and never returns excluded IDs.
 *   - For authenticated users, writes `last_seen_as_hero_at` into
 *     `user_fact_preferences` after the response (best-effort upsert).
 *   - For unauthenticated users, does NOT write to the table.
 *   - Falls back gracefully when the candidate pool is exhausted by the
 *     caller's exclude list.
 *
 * Test isolation: auth tests create a test user via the `t_routes_hero_`
 * prefix.  The before/after hooks delete those users; user_fact_preferences
 * cascades on user delete.
 *
 * Hero-pool seeding: this suite seeds a small set of its OWN active root facts
 * (submitter NULL, so they pass the route's test-user filter and count as
 * "real") in the outer `before`, and deletes them in the outer `after`. The
 * pool the hero endpoint draws from must be non-empty for these assertions, and
 * under the sharded runner (`--test-isolation=none`, schema-only DB clones) a
 * shard has no real facts unless a sibling test happens to leave some — which is
 * a fragile cross-file dependency that breaks whenever the test-file count
 * shifts the shard distribution. Seeding our own facts makes the suite
 * self-contained; any real facts that also exist simply add to the pool.
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
import { and, desc, eq, inArray, isNull, like, not, or, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import factsRouter from "../routes/facts.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "t_routes_hero_";

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local` });
  return id;
}

/**
 * Condition that mirrors the hero endpoint's test-user exclusion filter.
 * Facts with `submitted_by_id LIKE 't%'` (test users) are never served by
 * the hero endpoint, so test-side pool queries must use the same filter.
 */
const notTestUserFact = or(
  isNull(factsTable.submittedById),
  not(like(factsTable.submittedById, "t%")),
);

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
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

// Self-seeded hero-pool facts (submitter NULL ⇒ "real" by the route's filter).
// Five facts with distinct wilson scores: enough that the exclude test (which
// excludes the top 2) still has a remainder to return, and that the suite never
// depends on facts left behind by a sibling test in the same shard.
const seededFactIds: number[] = [];

async function seedHeroFacts() {
  const rows = await db
    .insert(factsTable)
    .values(
      [0.95, 0.94, 0.93, 0.92, 0.91].map((wilsonScore, i) => ({
        text: `Hero pool seed fact ${i + 1} — {NAME} does something legendary.`,
        submittedById: null,
        isActive: true,
        enrichment: buildPlaceholderFactEnrichment(),
        wilsonScore,
      })),
    )
    .returning({ id: factsTable.id });
  seededFactIds.push(...rows.map((r) => r.id));
}

async function unseedHeroFacts() {
  if (seededFactIds.length === 0) return;
  await db.delete(factsTable).where(inArray(factsTable.id, seededFactIds));
  seededFactIds.length = 0;
}

// Wrap every describe in this file in a single outer suite so the cleanup
// hooks scope correctly under `--test-isolation=none`. Top-level `before`/
// `after` register on the implicit root, which means when multiple files
// share a process all root befores fire first, then all tests, then all
// root afters — so this file's cleanup wouldn't run until AFTER another
// file's tests had already executed against our leftover hero facts. Hooks
// inside a describe run scoped to that suite, between files. See
// routes.facts.test.ts for the regression that prompted this.
describe("routes.facts.hero", () => {
  before(async () => {
    await cleanup();
    await seedHeroFacts();
  });
  after(async () => {
    await unseedHeroFacts();
    await cleanup();
  });

describe("GET /facts/hero — ranking sanity", () => {
  it("returns a fact drawn from the top-50 wilson-ranked pool", async () => {
    // Mirror the route's pool filters exactly: active root non-test-user facts.
    const top50 = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.isActive, true), isNull(factsTable.parentId), notTestUserFact))
      .orderBy(desc(factsTable.wilsonScore))
      .limit(50);
    const top50Ids = new Set(top50.map((r) => r.id));
    assert.ok(top50Ids.size > 0, "DB must have at least one real active fact");

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
    // Use the two highest-ranked real facts as exclusion targets.
    const top2 = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.isActive, true), isNull(factsTable.parentId), notTestUserFact))
      .orderBy(desc(factsTable.wilsonScore))
      .limit(2);
    assert.ok(top2.length >= 2, "DB must have at least 2 real active facts to test exclusion");

    const [a, b] = top2.map((r) => r.id);
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

    void userId; // used via USER_PREFIX count scope above
  });
});

describe("GET /facts/hero — fallback / epsilon floor", () => {
  it("still returns a fact when the candidate pool is exhausted by the exclude list", async () => {
    // Build an exclude list of the top-100 active root facts (the server
    // slices `?exclude` at 100 ids regardless).  When the DB holds ≤100
    // active root facts in total, the route's first SELECT returns zero rows
    // and the fallback re-query without exclusions takes over; when there
    // are >100, the route still returns a fact from positions 101+.  Either
    // way the contract is the same: the endpoint must respond 200 with a
    // populated `fact`, never a 4xx/5xx.
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
    assert.ok(res.body.fact, "expected a fact even when the pool is heavily excluded");
    assert.ok(res.body.poolSize >= 1, "poolSize must be positive");
  });
});

}); // routes.facts.hero outer suite
