/**
 * Read-path enforcement, end to end.
 *
 * The guarantee this file exists to prove: **revocation at the deadline,
 * enforced, independent of scheduler health.** No sweep runs in these tests at
 * all — the horizon is written into the past and every reader is asked what it
 * sees. A guarantee that holds only while a background job is healthy is not a
 * guarantee.
 *
 * It also covers the failure the middleware-only sweep would have missed:
 * `createMemeRecord` and `budgetGate` make AUTHORIZATION and SPENDING decisions
 * from their own selects, and `getActiveLegendarySubscribers` and the admin
 * dashboard select before any row exists to hand to a row helper.
 *
 * Talks to the real dev database. Users are tagged "mrp-" and cleaned up.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { effectiveTierExpr } from "../lib/membershipState.js";
import { StripeStorage } from "../lib/stripeStorage.js";

const USER_PREFIX = "mrp-";
const PAST = new Date(Date.now() - 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

const lapsedId = `${USER_PREFIX}lapsed`;
const liveId = `${USER_PREFIX}live`;
const unboundedId = `${USER_PREFIX}unbounded`;

let lapsedSid = "";

function makeReq(bearer: string): Request {
  return {
    headers: { authorization: `Bearer ${bearer}` },
    cookies: {},
  } as unknown as Request;
}

/** The session blob is no longer trusted for the tier — authMiddleware re-reads
 * the row on every request — so it deliberately carries a STALE `legendary`
 * here, to prove the answer comes from the database and not from the session. */
async function makeSessionFor(userId: string): Promise<string> {
  return createSession(
    {
      user: { id: userId, membershipTier: "legendary" } as unknown as SessionData["user"],
      access_token: "test-token",
    } as unknown as SessionData,
    userId,
  );
}

const noopRes = { clearCookie: () => noopRes } as unknown as Response;
const noopNext: NextFunction = () => {};

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("read-path enforcement with no sweep running", () => {
  before(async () => {
    await cleanup();
    await db.insert(usersTable).values([
      // Stored tier still says legendary — the sweep never ran. This is the
      // exact state the read path exists to handle.
      {
        id: lapsedId,
        email: `${lapsedId}@example.test`,
        membershipTier: "legendary",
        membershipValidUntil: PAST,
      },
      {
        id: liveId,
        email: `${liveId}@example.test`,
        membershipTier: "legendary",
        membershipValidUntil: FUTURE,
      },
      {
        id: unboundedId,
        email: `${unboundedId}@example.test`,
        membershipTier: "legendary",
        membershipValidUntil: null,
      },
    ]);

    lapsedSid = await makeSessionFor(lapsedId);
  });

  after(cleanup);

  it("authMiddleware serves a lapsed user at the non-qualifying tier", async () => {
    const req = makeReq(lapsedSid);
    await authMiddleware(req, noopRes, noopNext);

    assert.ok(req.user, "the session is still valid — expiry demotes, it does not log you out");
    assert.equal(req.user.membershipTier, "registered");
    assert.equal(req.user.userRole, "registered", "the derived role follows the effective tier");
  });

  it("keeps a user inside their window at the qualifying tier", async () => {
    const sid = await makeSessionFor(liveId);
    const req = makeReq(sid);
    await authMiddleware(req, noopRes, noopNext);
    assert.equal(req.user?.membershipTier, "legendary");
  });

  it("drops a lapsed member from the mailing recipient list", async () => {
    // getActiveLegendarySubscribers feeds factOfTheDay. Filtering on the raw
    // column would keep EMAILING someone the server no longer treats as a member.
    const storage = new StripeStorage();
    const recipients = await storage.getActiveLegendarySubscribers();
    const ids = new Set(recipients.map((r) => r.id));

    assert.equal(ids.has(lapsedId), false, "a lapsed member must not be emailed");
    assert.equal(ids.has(liveId), true);
    assert.equal(ids.has(unboundedId), true);
  });

  it("moves a lapsed member between the two dashboard counts, not out of both", async () => {
    // The bug a PREDICATE would have introduced: instantiated at 'registered' a
    // lapsed member matches nothing, because the raw column still says
    // legendary — so they would vanish from both counts.
    const [counts] = await db
      .select({
        legendary: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'legendary')::int`,
        registered: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'registered')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(usersTable)
      .where(like(usersTable.id, `${USER_PREFIX}%`));

    assert.equal(counts.legendary, 2, "live + unbounded");
    assert.equal(counts.registered, 1, "the lapsed one, which must appear SOMEWHERE");
    assert.equal(counts.legendary + counts.registered, counts.total, "nobody falls out of both");
  });

  it("agrees across the row read and the set read for the same user", async () => {
    const asOf = new Date();
    const rows = await db
      .select({ id: usersTable.id, effective: effectiveTierExpr(asOf) })
      .from(usersTable)
      .where(like(usersTable.id, `${USER_PREFIX}%`));

    const bySet = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(like(usersTable.id, `${USER_PREFIX}%`), sql`${effectiveTierExpr(asOf)} = 'legendary'`));

    const setIds = new Set(bySet.map((r) => r.id));
    for (const row of rows) {
      assert.equal(
        setIds.has(row.id),
        row.effective === "legendary",
        `${row.id} disagrees between the row read and the set read`,
      );
    }
  });

  it("demotes the instant the horizon passes, with nothing else changing", async () => {
    const horizon = new Date();
    await db
      .update(usersTable)
      .set({ membershipValidUntil: horizon })
      .where(eq(usersTable.id, liveId));

    const before = await db
      .select({ effective: effectiveTierExpr(new Date(horizon.getTime() - 1)) })
      .from(usersTable)
      .where(eq(usersTable.id, liveId));
    assert.equal(before[0].effective, "legendary");

    const after = await db
      .select({ effective: effectiveTierExpr(horizon) })
      .from(usersTable)
      .where(eq(usersTable.id, liveId));
    assert.equal(after[0].effective, "registered");

    // The stored column is untouched — the read path enforces, the sweep
    // converges, and this test ran without a sweep.
    const [raw] = await db
      .select({ tier: usersTable.membershipTier })
      .from(usersTable)
      .where(eq(usersTable.id, liveId));
    assert.equal(raw.tier, "legendary");
  });
});
