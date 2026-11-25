/**
 * What counts as "this webhook event was already processed".
 *
 * The idempotency claim and the domain writes share one transaction, and the
 * catch around that transaction spans preparation, the writes, auditing and
 * post-commit work. So the test for "already claimed" has to be narrow enough to
 * convict only the claim's own constraint: a broad `code === "23505"` (or worse,
 * a substring match on "unique") calls somebody else's unique violation a
 * duplicate, answers Stripe 200, and drops a real event that would otherwise
 * have been redelivered.
 *
 * The concrete case that motivated this: two first-purchase events racing in
 * `linkCustomerToUser`, where the loser violates the unique Stripe-customer
 * constraint during PREPARE — before any claim exists at all.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { stripeProcessedEventsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { isConstraintViolation } from "../lib/webhookHandlers.js";

const PROCESSED_EVENTS_PK = "stripe_processed_events_pkey";

/** A `pg` error as the driver actually surfaces it. */
function pgError(over: { code?: string; constraint?: string; message?: string }): Error {
  const err = new Error(over.message ?? "duplicate key value violates unique constraint");
  Object.assign(err, {
    ...(over.code === undefined ? {} : { code: over.code }),
    ...(over.constraint === undefined ? {} : { constraint: over.constraint }),
  });
  return err;
}

describe("isConstraintViolation — only the claim's own constraint is a duplicate", () => {
  it("accepts a unique violation on the named constraint", () => {
    const err = pgError({ code: "23505", constraint: PROCESSED_EVENTS_PK });
    assert.equal(isConstraintViolation(err, PROCESSED_EVENTS_PK), true);
  });

  it("rejects a unique violation on a DIFFERENT constraint", () => {
    // The linkCustomerToUser race: a real 23505, from the wrong table. Treating
    // this as a duplicate acks an event whose work never committed.
    const err = pgError({ code: "23505", constraint: "users_stripe_customer_id_unique" });
    assert.equal(isConstraintViolation(err, PROCESSED_EVENTS_PK), false);
  });

  it("rejects a 23505 that carries no constraint name", () => {
    assert.equal(isConstraintViolation(pgError({ code: "23505" }), PROCESSED_EVENTS_PK), false);
  });

  it("rejects a non-23505 error even on the right constraint", () => {
    const err = pgError({ code: "23503", constraint: PROCESSED_EVENTS_PK });
    assert.equal(isConstraintViolation(err, PROCESSED_EVENTS_PK), false);
  });

  it("rejects an error that merely says 'unique' in its message", () => {
    // The substring test this replaced. "unique" shows up in plenty of errors
    // that are not constraint violations at all.
    const err = new Error("could not build a unique filename for the receipt");
    assert.equal(isConstraintViolation(err, PROCESSED_EVENTS_PK), false);
  });

  it("rejects non-Error throws", () => {
    assert.equal(isConstraintViolation("23505", PROCESSED_EVENTS_PK), false);
    assert.equal(isConstraintViolation(null, PROCESSED_EVENTS_PK), false);
  });
});

/**
 * The error the claim insert REALLY throws, from drizzle against the test
 * database: a `DrizzleQueryError` whose SQLSTATE and constraint sit on `.cause`
 * (Issue #1261). The raw-shape cases above never saw the wrapper, which is how a
 * redelivered event came to be treated as a failure.
 */
describe("isConstraintViolation — the error drizzle actually throws", () => {
  const id = `evt_dupclaim_${randomUUID()}`;
  after(async () => {
    await db.delete(stripeProcessedEventsTable).where(eq(stripeProcessedEventsTable.eventId, id));
  });

  it("recognises a second claim of one event inside a transaction as the claim's own duplicate", async () => {
    await db.insert(stripeProcessedEventsTable).values({ eventId: id });
    let thrown: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(stripeProcessedEventsTable).values({ eventId: id });
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "the second claim must fail");
    assert.equal((thrown as { code?: unknown }).code, undefined, "drizzle does not copy the SQLSTATE up (the premise of this test)");
    assert.equal(isConstraintViolation(thrown, PROCESSED_EVENTS_PK), true);
    assert.equal(isConstraintViolation(thrown, "some_other_unique_idx"), false);
  });
});
