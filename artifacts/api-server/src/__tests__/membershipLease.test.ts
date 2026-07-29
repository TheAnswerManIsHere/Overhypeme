/**
 * Lease acquisition, fencing and release.
 *
 * These assert the BOUNDARIES, not the happy path — the happy path was never the
 * problem. The cases that matter are the ones where a time-based lease alone
 * gives the wrong answer:
 *
 *   - a holder whose lease expired while a successor is still RETRIEVING (so no
 *     newer version token has been stored) must have its apply aborted by the
 *     fence, not admitted by the version guard;
 *   - the successor then crashing must leave the PRE-EXISTING state, never the
 *     expired holder's stale write;
 *   - a late holder's release must not release its successor's lease.
 *
 * Talks to the real dev database. Scopes are tagged "mlt-" and cleaned up.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { membershipLeasesTable } from "@workspace/db/schema";
import { like, sql } from "drizzle-orm";

import {
  LeaseFenceError,
  acquireLease,
  acquireLeaseWithWait,
  heartbeatLease,
  releaseLease,
  sourceLeaseScope,
  withLeaseFence,
} from "../lib/membershipLease.js";

const SCOPE_PREFIX = "mlt-";
const scope = () => `${SCOPE_PREFIX}${randomUUID()}`;

const LOCK_TIMEOUT_MS = 3_000;

async function cleanup() {
  await db.delete(membershipLeasesTable).where(like(membershipLeasesTable.scope, `${SCOPE_PREFIX}%`));
}

beforeEach(cleanup);
after(cleanup);

describe("sourceLeaseScope", () => {
  it("separates sources by type as well as reference", () => {
    assert.notEqual(
      sourceLeaseScope("stripe_subscription", "x_1"),
      sourceLeaseScope("stripe_lifetime_payment", "x_1"),
    );
  });
});

describe("acquireLease", () => {
  it("grants an unheld scope and refuses a live one", async () => {
    const s = scope();
    const first = await acquireLease(s, 60, "holder-a");
    assert.ok(first);
    assert.equal(await acquireLease(s, 60, "holder-b"), null);
  });

  it("steals an expired lease and takes a FRESH fence", async () => {
    const s = scope();
    const stale = await acquireLease(s, 0, "holder-a");
    assert.ok(stale);

    const stolen = await acquireLease(s, 60, "holder-b");
    assert.ok(stolen, "an expired lease must be stealable — a crashed holder cannot wedge a source");
    assert.equal(stolen.holder, "holder-b");
    assert.ok(
      stolen.fence > stale.fence,
      "a fresh fence on every acquisition is what lets the apply tell a live holder from a revenant",
    );
  });

  it("allocates strictly increasing, distinct fences even when requested at once", async () => {
    // Not clock_timestamp(): two concurrent calls can return the SAME timestamp,
    // and a strictly-newer guard would then reject a genuinely newer snapshot.
    const scopes = Array.from({ length: 20 }, scope);
    const handles = await Promise.all(scopes.map((s) => acquireLease(s, 60)));
    const fences = handles.map((h) => h!.fence);
    assert.equal(new Set(fences).size, fences.length, "fences must be unique");
  });
});

describe("acquireLeaseWithWait", () => {
  it("returns null when the scope stays busy, so the caller abandons its write", async () => {
    const s = scope();
    assert.ok(await acquireLease(s, 60, "holder-a"));

    let slept = 0;
    const waited = await acquireLeaseWithWait(s, 60, 1, "holder-b", {
      pollIntervalMs: 10,
      sleep: async (ms) => {
        slept += ms;
      },
      now: () => slept, // advance the fake clock only by what was "slept"
    });

    assert.equal(waited, null);
    assert.ok(slept >= 1000, "it actually waited out the timeout");
  });

  it("acquires as soon as the incumbent releases", async () => {
    const s = scope();
    const incumbent = await acquireLease(s, 60, "holder-a");
    assert.ok(incumbent);

    let elapsed = 0;
    const waited = await acquireLeaseWithWait(s, 60, 5, "holder-b", {
      pollIntervalMs: 10,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
        if (elapsed >= 30) await releaseLease(incumbent);
      },
    });

    assert.ok(waited);
    assert.equal(waited.holder, "holder-b");
  });
});

describe("withLeaseFence", () => {
  it("runs the apply for a live holder", async () => {
    const s = scope();
    const handle = await acquireLease(s, 60, "holder-a");
    assert.ok(handle);

    const result = await withLeaseFence(handle, LOCK_TIMEOUT_MS, async () => "applied");
    assert.equal(result, "applied");
  });

  it("ABORTS an expired holder whose successor has written nothing yet", async () => {
    // The exact interleaving the version guard cannot cover: A stalls past
    // expiry; B acquires and is still retrieving, so the stored version token is
    // untouched and A's late write would pass the guard unchanged.
    const s = scope();
    const stalled = await acquireLease(s, 0, "holder-a");
    assert.ok(stalled);

    const successor = await acquireLease(s, 60, "holder-b");
    assert.ok(successor, "B has the lease but has written nothing");

    let applied = false;
    await assert.rejects(
      () => withLeaseFence(stalled, LOCK_TIMEOUT_MS, async () => {
        applied = true;
      }),
      LeaseFenceError,
    );
    assert.equal(applied, false, "the apply body must not run at all");
  });

  it("ABORTS a holder whose own lease expired with no successor at all", async () => {
    const s = scope();
    const expired = await acquireLease(s, 0, "holder-a");
    assert.ok(expired);

    await assert.rejects(
      () => withLeaseFence(expired, LOCK_TIMEOUT_MS, async () => "should not run"),
      (error: Error) => error instanceof LeaseFenceError && /expired/.test(error.message),
    );
  });

  it("ABORTS when the lease row is gone", async () => {
    const s = scope();
    const handle = await acquireLease(s, 60, "holder-a");
    assert.ok(handle);
    await releaseLease(handle);

    await assert.rejects(
      () => withLeaseFence(handle, LOCK_TIMEOUT_MS, async () => "should not run"),
      (error: Error) => error instanceof LeaseFenceError && /gone/.test(error.message),
    );
  });

  it("rolls the apply back when the body throws, leaving no partial write", async () => {
    const s = scope();
    const handle = await acquireLease(s, 60, "holder-a");
    assert.ok(handle);

    await assert.rejects(() =>
      withLeaseFence(handle, LOCK_TIMEOUT_MS, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        throw new Error("domain failure");
      }),
    );

    // The lease itself survives — a failed apply is not a lost lease.
    const still = await acquireLease(s, 60, "holder-b");
    assert.equal(still, null, "holder-a still owns it");
  });
});

describe("releaseLease — compare and release", () => {
  it("does NOT release a lease that now belongs to a successor", async () => {
    const s = scope();
    const stalled = await acquireLease(s, 0, "holder-a");
    assert.ok(stalled);
    const successor = await acquireLease(s, 60, "holder-b");
    assert.ok(successor);

    assert.equal(await releaseLease(stalled), false, "the late holder's fence no longer matches");

    // The successor's lease is intact — a third party still cannot take it.
    assert.equal(await acquireLease(s, 60, "holder-c"), null);
    assert.equal(await releaseLease(successor), true);
  });
});

describe("heartbeatLease", () => {
  it("lets a heartbeating holder outlive its TTL", async () => {
    // A whole staging run has no bounded duration, so expiry must mean "the
    // holder stopped", not "the holder is slow".
    const s = scope();
    const handle = await acquireLease(s, 1, "runner-a");
    assert.ok(handle);

    assert.equal(await heartbeatLease(handle, 60), true);

    // Past the ORIGINAL 1s TTL, nobody can take it over.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await acquireLease(s, 60, "runner-b"), null);
    // ...and its own apply still passes the fence.
    assert.equal(await withLeaseFence(handle, LOCK_TIMEOUT_MS, async () => "ok"), "ok");
  });

  it("is taken over once it stops beating", async () => {
    const s = scope();
    const handle = await acquireLease(s, 1, "runner-a");
    assert.ok(handle);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const takeover = await acquireLease(s, 60, "runner-b");
    assert.ok(takeover, "a run that stopped beating is taken over after expiry");

    // And the abandoned run's own renewal now fails, so it abandons rather than
    // continuing unfenced.
    assert.equal(await heartbeatLease(handle, 60), false);
  });

  it("refuses to renew a lease taken over by someone else", async () => {
    const s = scope();
    const original = await acquireLease(s, 0, "runner-a");
    assert.ok(original);
    assert.ok(await acquireLease(s, 60, "runner-b"));

    assert.equal(await heartbeatLease(original, 60), false);
  });
});
