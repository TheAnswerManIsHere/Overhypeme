/**
 * `PATCH /admin/config/:key` for the membership settings — the RELATIONAL half.
 *
 * `membershipTiming.test.ts` already proves the validator itself. What it cannot
 * prove is that the route reaches it, or that the check and the write it
 * authorises share a transaction: the check now runs inside the write
 * transaction against a `FOR UPDATE`-locked config set, and a rejection travels
 * out as a thrown error rather than a mid-transaction response. Both of those
 * are route-shaped, so they need a route-shaped test — an admissible write that
 * commits, and an inadmissible one that 400s AND leaves the stored value alone.
 *
 * The stored-value assertion is the load-bearing one. A rejection that responds
 * 400 while the update has already committed is indistinguishable from a correct
 * rejection at the HTTP boundary, and it is exactly the failure mode moving the
 * write into a transaction could introduce.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { adminConfigTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import adminRouter from "../routes/admin.js";
import { MEMBERSHIP_CONFIG_DEFAULTS } from "../lib/membershipTiming.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "tmcfg-";

let app: Express;

async function storedValue(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: adminConfigTable.value })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function setStored(key: string, value: number): Promise<void> {
  await db.update(adminConfigTable).set({ value: String(value) }).where(eq(adminConfigTable.key, key));
}

before(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "registered",
    isAdmin: true,
  });
  app = buildTestApp({ kind: "authenticated", userId: id }, adminRouter);

  // The sharded runner clones its databases structure-only, so migration DML —
  // including these seeds — is absent by design. Seed what this file edits.
  for (const [key, value] of Object.entries(MEMBERSHIP_CONFIG_DEFAULTS)) {
    await db
      .insert(adminConfigTable)
      .values({
        key,
        value: String(value),
        dataType: "integer",
        label: key,
        description: key,
        minValue: 1,
        maxValue: 604800,
        isPublic: false,
      })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: String(value) } });
  }
});

after(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const [key, value] of Object.entries(MEMBERSHIP_CONFIG_DEFAULTS)) {
    await setStored(key, value);
  }
});

describe("PATCH /admin/config/:key — membership relational invariants", () => {
  it("accepts a write that keeps the set coherent, and stores it", async () => {
    const res = await request(app).patch("/api/admin/config/lease_ttl_seconds").send({ value: "120" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await storedValue("lease_ttl_seconds"), "120");

    await setStored("lease_ttl_seconds", MEMBERSHIP_CONFIG_DEFAULTS.lease_ttl_seconds);
  });

  it("rejects a lease below the derived floor and leaves the stored value untouched", async () => {
    const before = await storedValue("lease_ttl_seconds");

    const res = await request(app).patch("/api/admin/config/lease_ttl_seconds").send({ value: "5" });

    assert.equal(res.status, 400);
    assert.match(String(res.body.error ?? ""), /lease_ttl_seconds must be at least/);
    assert.equal(
      await storedValue("lease_ttl_seconds"),
      before,
      "a rejected write must not have committed — the check and the update share one transaction",
    );
  });

  it("rejects a waiter that would outlive the lease it waits for", async () => {
    const before = await storedValue("lease_waiter_timeout_seconds");

    const res = await request(app)
      .patch("/api/admin/config/lease_waiter_timeout_seconds")
      .send({ value: String(MEMBERSHIP_CONFIG_DEFAULTS.lease_ttl_seconds) });

    assert.equal(res.status, 400);
    assert.match(String(res.body.error ?? ""), /lease_waiter_timeout_seconds/);
    assert.equal(await storedValue("lease_waiter_timeout_seconds"), before);
  });

  it("rejects an inadmissible DEBUG override too — debug mode is not a backdoor", async () => {
    const res = await request(app)
      .patch("/api/admin/config/lease_ttl_seconds")
      .send({ debugValue: "5" });

    assert.equal(res.status, 400);
    assert.match(String(res.body.error ?? ""), /^Debug value: /);
  });

  it("rejects the debug override that would make the DEBUG set incoherent, though each is fine alone", async () => {
    // The accumulation a currently-effective check cannot see, and the reason
    // both resolutions are validated. Debug mode is OFF throughout, so every
    // override here is inert and each one validates happily against the base
    // set — and `debug_mode_active` is not a membership key, so flipping it
    // later runs no relational check of its own. Without checking the
    // prospective DEBUG resolution, the invalid pair would activate in one
    // click.
    //
    // First override: a 20000s sweep interval. Against the base set its alert
    // threshold is still 21600, so this is admissible and must be accepted —
    // asserting that first is what makes the second assertion mean something.
    const first = await request(app)
      .patch("/api/admin/config/grace_sweep_interval_seconds")
      .send({ debugValue: "20000" });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Second override: a 10000s alert threshold. Against the BASE set its
    // interval is 3600, so 10000 clears it easily. Against the DEBUG set the
    // interval is now 20000 — the alert would fire before the sweep could have
    // run again, which is the pair neither write can see on its own.
    const before = await storedValue("grace_sweep_alert_after_seconds");
    const second = await request(app)
      .patch("/api/admin/config/grace_sweep_alert_after_seconds")
      .send({ debugValue: "10000" });

    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.match(String(second.body.error ?? ""), /under debug mode/);
    assert.equal(await storedValue("grace_sweep_alert_after_seconds"), before);

    await request(app)
      .patch("/api/admin/config/grace_sweep_interval_seconds")
      .send({ clearDebugValue: true });
  });

  it("validates against the CURRENT stored set, not the seeded defaults", async () => {
    // Raise the lease first; a waiter that was inadmissible a moment ago becomes
    // admissible, which is only true if the check reads live state.
    await setStored("lease_ttl_seconds", 300);

    const res = await request(app)
      .patch("/api/admin/config/lease_waiter_timeout_seconds")
      .send({ value: "200" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await storedValue("lease_waiter_timeout_seconds"), "200");

    await setStored("lease_ttl_seconds", MEMBERSHIP_CONFIG_DEFAULTS.lease_ttl_seconds);
    await setStored(
      "lease_waiter_timeout_seconds",
      MEMBERSHIP_CONFIG_DEFAULTS.lease_waiter_timeout_seconds,
    );
  });
});
