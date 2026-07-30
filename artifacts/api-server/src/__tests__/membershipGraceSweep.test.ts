/**
 * The grace convergence sweep, and the denominator the downgrade guard uses.
 *
 * The sweep's job is convergence, NOT enforcement — `membershipReadPath.test.ts`
 * proves access is already revoked on the deadline with no sweep running at all.
 * What is asserted here is that a healthy sweep makes the stored value agree.
 *
 * Talks to the real dev database. Users are tagged "mrc-" and cleaned up.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { membershipEntitlementsTable, membershipHistoryTable, usersTable } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import { sweepExpiredGrace } from "../lib/membershipGraceSweep.js";
import { qualifyingPopulation } from "../lib/membershipState.js";

import { recomputeMembership } from "../lib/membershipSources.js";

const PREFIX = "mrc-";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

async function cleanup() {
  // membership_history.user_id is a plain NO ACTION FK, so it has to go first.
  // (Entitlements cascade; history deliberately does not — it is outside the
  // entitlement model, and its deletion behaviour is the separate
  // account-deletion work's problem, not this model's.)
  await db.delete(membershipHistoryTable).where(like(membershipHistoryTable.userId, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

async function makeUser(
  suffix: string,
  over: { tier?: "registered" | "legendary"; validUntil?: Date | null } = {},
) {
  const id = `${PREFIX}${suffix}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@example.test`,
    membershipTier: over.tier ?? "legendary",
    membershipValidUntil: over.validUntil ?? null,
  });
  return id;
}

/** A past-due subscription source whose grace window ended at `deadline`. */
async function makePastDueSource(userId: string, deadline: Date, providerRef: string) {
  const [token] = (
    await db.execute<{ t: string }>(sql`SELECT nextval('membership_source_state_seq') AS t`)
  ).rows;
  await db.insert(membershipEntitlementsTable).values({
    userId,
    sourceType: "stripe_subscription",
    providerRef,
    isMembershipProduct: true,
    lifecycleStatus: "past_due",
    graceStartedAt: new Date(deadline.getTime() - 14 * DAY),
    graceExpiresAt: deadline,
    sourceStateAsOf: Number(token.t),
  });
}

beforeEach(cleanup);
after(cleanup);

describe("sweepExpiredGrace — convergence, not enforcement", () => {
  it("converges a lapsed user's stored tier and clears the horizon", async () => {
    const id = await makeUser("lapsed", { validUntil: at(-DAY) });
    await makePastDueSource(id, at(-DAY), `sub_${PREFIX}lapsed`);

    const result = await sweepExpiredGrace({ asOf: NOW });
    assert.ok(result.examined >= 1);

    const [row] = await db
      .select({
        tier: usersTable.membershipTier,
        validUntil: usersTable.membershipValidUntil,
      })
      .from(usersTable)
      .where(eq(usersTable.id, id));

    assert.equal(row.tier, "registered", "the stored tier now agrees with the read path");
    assert.equal(row.validUntil, null, "and the horizon is cleared, since nothing qualifies");
  });

  it("leaves a user inside their window alone", async () => {
    const id = await makeUser("live", { validUntil: at(DAY) });
    await makePastDueSource(id, at(DAY), `sub_${PREFIX}live`);

    await sweepExpiredGrace({ asOf: NOW });

    const [row] = await db
      .select({ tier: usersTable.membershipTier })
      .from(usersTable)
      .where(eq(usersTable.id, id));
    assert.equal(row.tier, "legendary");
  });

  it("is idempotent — a second pass converges nothing further", async () => {
    const id = await makeUser("twice", { validUntil: at(-DAY) });
    await makePastDueSource(id, at(-DAY), `sub_${PREFIX}twice`);

    const first = await sweepExpiredGrace({ asOf: NOW });
    const second = await sweepExpiredGrace({ asOf: NOW });

    assert.ok(first.converged >= 1);
    assert.equal(second.converged, 0, "the row no longer matches the lapsed predicate");
    assert.equal(second.examined, 0);
  });

  it("does not resurrect a user whose lifetime source still qualifies", async () => {
    // The coexistence case: a stale horizon on a user who also holds an
    // indefinitely-valid source. Recomputing must produce a null horizon and
    // KEEP the tier, not demote on the stale timestamp.
    const id = await makeUser("coexist", { validUntil: at(-DAY) });
    const [token] = (
      await db.execute<{ t: string }>(sql`SELECT nextval('membership_source_state_seq') AS t`)
    ).rows;
    await db.insert(membershipEntitlementsTable).values({
      userId: id,
      sourceType: "stripe_lifetime_payment",
      providerRef: `pi_${PREFIX}coexist`,
      isMembershipProduct: true,
      lifecycleStatus: "active",
      amount: 9900,
      currency: "usd",
      sourceStateAsOf: Number(token.t),
    });

    await sweepExpiredGrace({ asOf: NOW });

    const [row] = await db
      .select({
        tier: usersTable.membershipTier,
        validUntil: usersTable.membershipValidUntil,
      })
      .from(usersTable)
      .where(eq(usersTable.id, id));

    assert.equal(row.tier, "legendary", "an indefinitely-valid source keeps the tier");
    assert.equal(row.validUntil, null, "and the stale horizon is cleared");
  });
});

describe("recomputeMembership", () => {
  it("never promotes an unregistered user — that is an auth state", async () => {
    const id = `${PREFIX}unreg`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@example.test`,
      membershipTier: "unregistered",
    });
    const [token] = (
      await db.execute<{ t: string }>(sql`SELECT nextval('membership_source_state_seq') AS t`)
    ).rows;
    await db.insert(membershipEntitlementsTable).values({
      userId: id,
      sourceType: "stripe_lifetime_payment",
      providerRef: `pi_${PREFIX}unreg`,
      isMembershipProduct: true,
      lifecycleStatus: "active",
      sourceStateAsOf: Number(token.t),
    });

    await db.transaction((tx) => recomputeMembership(tx, id));

    const [row] = await db
      .select({ tier: usersTable.membershipTier })
      .from(usersTable)
      .where(eq(usersTable.id, id));
    assert.equal(row.tier, "unregistered");
  });

  it("writes nothing on a replay, so an idempotent event emits no history", async () => {
    const id = await makeUser("replay", { tier: "registered" });
    const first = await db.transaction((tx) => recomputeMembership(tx, id));
    const second = await db.transaction((tx) => recomputeMembership(tx, id));

    assert.equal(first?.changed, false);
    assert.equal(second?.changed, false);
  });
});

describe("qualifyingPopulation — the denominator", () => {
  it("counts effective Legendary users, not raw column values", async () => {
    await makeUser("cohort-live", { validUntil: null });
    await makeUser("cohort-lapsed", { validUntil: at(-DAY) });
    await makeUser("cohort-registered", { tier: "registered" });

    const before = await qualifyingPopulation(at(-2 * DAY));
    const after = await qualifyingPopulation(NOW);

    assert.ok(after < before, "the lapsed user leaves the cohort as the clock passes their horizon");
  });
});
