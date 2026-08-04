/**
 * The SQL half of the read path.
 *
 * `effectiveTierExpr` and `effectiveTierForRow` are the same rule expressed
 * twice, so the tests that matter are the ones asserting they cannot disagree —
 * a set reader that filters in SQL and a request-path reader that holds a row
 * must give the same answer for the same user at the same instant.
 *
 * Talks to the real dev database. Users are tagged with the prefix "mss-" and
 * cleaned up in after(). Prefix uses `-` (not `_`) so SQL LIKE wildcards in the
 * cleanup cannot match another test file's rows during parallel runs.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { count, eq, like, sql } from "drizzle-orm";

import {
  effectiveTierExpr,
  effectiveTierForRow,
  getEffectiveMembership,
  type MembershipTier,
} from "../lib/membershipState.js";

const USER_PREFIX = "mss-";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

interface Fixture {
  id: string;
  tier: MembershipTier;
  validUntil: Date | null;
  /** What the effective tier must be at NOW. */
  expectedAtNow: MembershipTier;
}

const FIXTURES: Fixture[] = [
  { id: `${USER_PREFIX}legendary-no-horizon`, tier: "legendary", validUntil: null, expectedAtNow: "legendary" },
  { id: `${USER_PREFIX}legendary-future`, tier: "legendary", validUntil: at(DAY), expectedAtNow: "legendary" },
  { id: `${USER_PREFIX}legendary-lapsed`, tier: "legendary", validUntil: at(-DAY), expectedAtNow: "registered" },
  // Exactly at the horizon: the comparison is <=, so this one has lapsed.
  { id: `${USER_PREFIX}legendary-at-horizon`, tier: "legendary", validUntil: NOW, expectedAtNow: "registered" },
  { id: `${USER_PREFIX}registered-plain`, tier: "registered", validUntil: null, expectedAtNow: "registered" },
  // A stale horizon on a non-legendary row must not promote it.
  { id: `${USER_PREFIX}registered-stale-horizon`, tier: "registered", validUntil: at(-DAY), expectedAtNow: "registered" },
  { id: `${USER_PREFIX}unregistered-stale-horizon`, tier: "unregistered", validUntil: at(-DAY), expectedAtNow: "unregistered" },
];

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("effectiveTierExpr", () => {
  before(async () => {
    await cleanup();
    await db.insert(usersTable).values(
      FIXTURES.map((f) => ({
        id: f.id,
        email: `${f.id}@example.test`,
        membershipTier: f.tier,
        membershipValidUntil: f.validUntil,
      })),
    );
  });

  after(cleanup);

  it("agrees with the row helper for every fixture, at a bound asOf", async () => {
    const rows = await db
      .select({
        id: usersTable.id,
        effective: effectiveTierExpr(NOW),
        membershipTier: usersTable.membershipTier,
        membershipValidUntil: usersTable.membershipValidUntil,
      })
      .from(usersTable)
      .where(like(usersTable.id, `${USER_PREFIX}%`));

    assert.equal(rows.length, FIXTURES.length);

    for (const row of rows) {
      const expected = FIXTURES.find((f) => f.id === row.id)!.expectedAtNow;
      assert.equal(row.effective, expected, `SQL expression for ${row.id}`);
      assert.equal(
        effectiveTierForRow(row, NOW),
        expected,
        `row helper for ${row.id}`,
      );
    }
  });

  it("moves a lapsing user between buckets as the bound instant advances", async () => {
    const id = `${USER_PREFIX}legendary-future`;

    const before = await db
      .select({ effective: effectiveTierExpr(NOW) })
      .from(usersTable)
      .where(eq(usersTable.id, id));
    assert.equal(before[0].effective, "legendary");

    const after = await db
      .select({ effective: effectiveTierExpr(at(2 * DAY)) })
      .from(usersTable)
      .where(eq(usersTable.id, id));
    assert.equal(after[0].effective, "registered", "same row, later instant");
  });

  it("keeps the two counts summing to the same total across the horizon, in one statement", async () => {
    // Two counts run as separate statements get two transaction timestamps, so a
    // user crossing the horizon between them is counted twice or not at all.
    // Conditional aggregation in ONE statement is what makes the sum stable.
    const bucketsAt = async (asOf: Date) => {
      const [row] = await db
        .select({
          legendary: count(sql`CASE WHEN ${effectiveTierExpr(asOf)} = 'legendary' THEN 1 END`),
          registered: count(sql`CASE WHEN ${effectiveTierExpr(asOf)} = 'registered' THEN 1 END`),
          total: count(),
        })
        .from(usersTable)
        .where(like(usersTable.id, `${USER_PREFIX}%`));
      return row;
    };

    const before = await bucketsAt(at(-2 * DAY));
    const after = await bucketsAt(at(2 * DAY));

    // One fixture is `unregistered`, which expiry never touches — so the two
    // buckets do not cover the whole set, but their SUM must not move.
    assert.equal(
      before.legendary + before.registered,
      after.legendary + after.registered,
      "a user crossing the horizon leaves one bucket and enters the other",
    );
    assert.ok(after.legendary < before.legendary, "someone actually lapsed");
    assert.equal(after.registered, before.registered + (before.legendary - after.legendary));
  });

  it("getEffectiveMembership agrees with the expression, and returns null for an absent user", async () => {
    const lapsed = await getEffectiveMembership(`${USER_PREFIX}legendary-lapsed`, { asOf: NOW });
    assert.equal(lapsed?.tier, "registered");

    const live = await getEffectiveMembership(`${USER_PREFIX}legendary-no-horizon`, { asOf: NOW });
    assert.equal(live?.tier, "legendary");
    assert.equal(live?.validUntil, null);

    assert.equal(await getEffectiveMembership(`${USER_PREFIX}does-not-exist`), null);
  });
});
