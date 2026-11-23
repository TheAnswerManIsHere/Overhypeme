// Issue #454: a provider-backed entitlement source records the Stripe mode of
// the object it was verified from, and a source recorded under the other mode
// grants nothing, so a test-mode membership cannot keep granting Legendary
// after the site switches to live payments.
//
// The test reads the stored mode rather than writing it: `stripe_live_mode` is
// one shared row, and other test files toggle it.
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { membershipEntitlementsTable, usersTable } from "@workspace/db/schema";
import { like, sql } from "drizzle-orm";

import { loadSourceSnapshots } from "../lib/membershipSources.js";
import { isLiveMode } from "../lib/stripeClient.js";

const PREFIX = "tlivemode-";

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

async function token(): Promise<number> {
  const r = await db.execute<{ t: string }>(sql`SELECT nextval('membership_source_state_seq') AS t`);
  return Number(r.rows[0]!.t);
}

async function source(userId: string, ref: string, livemode: boolean | null): Promise<void> {
  await db.insert(membershipEntitlementsTable).values({
    userId,
    sourceType: "stripe_lifetime_payment",
    providerRef: `pi_${PREFIX}${ref}`,
    isMembershipProduct: true,
    lifecycleStatus: "active",
    amount: 9900,
    currency: "usd",
    livemode,
    sourceStateAsOf: await token(),
  });
}

beforeEach(cleanup);
after(cleanup);

describe("entitlement sources and the Stripe mode (#454)", () => {
  it("a source recorded under the other Stripe mode is not part of the user's source set", async () => {
    const userId = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({ id: userId, email: `${userId}@test.local` });
    const active = await isLiveMode();

    await source(userId, "same", active);
    await source(userId, "other", !active);
    await source(userId, "unmarked", null);

    const refs = (await loadSourceSnapshots(db, userId)).map((s) => s.providerRef).sort();
    assert.deepEqual(refs, [`pi_${PREFIX}same`, `pi_${PREFIX}unmarked`]);
  });
});
