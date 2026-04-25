/**
 * Integration tests for stripeStorage.getAccessRevocationNotice (Task #227).
 *
 * Verifies that the user-facing membership revocation notice is shown only
 * when the user has been involuntarily downgraded by a recent refund or
 * dispute, and that no sensitive Stripe data leaks through the payload.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, membershipHistoryTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import {
  stripeStorage,
  REVOCATION_NOTICE_WINDOW_DAYS,
} from "../lib/stripeStorage.js";

function uid() {
  return `t227_${randomUUID()}`;
}

async function createUser(tier: "registered" | "legendary" | "unregistered") {
  const id = uid();
  await db.insert(usersTable).values({ id, membershipTier: tier });
  return id;
}

async function insertHistory(
  userId: string,
  event: string,
  opts: { createdAt?: Date; stripePaymentIntentId?: string; amount?: number } = {},
) {
  await db.insert(membershipHistoryTable).values({
    userId,
    event,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.stripePaymentIntentId ? { stripePaymentIntentId: opts.stripePaymentIntentId } : {}),
    ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
  });
}

async function cleanup(userId: string) {
  await db.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

describe("stripeStorage.getAccessRevocationNotice", () => {
  const created: string[] = [];

  after(async () => {
    for (const id of created) await cleanup(id);
  });

  it("returns null when the user has no membership history", async () => {
    const id = await createUser("registered");
    created.push(id);
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });

  it("returns null when the user is on legendary tier (still has access)", async () => {
    const id = await createUser("legendary");
    created.push(id);
    await insertHistory(id, "refund");
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });

  it("returns null when the user is unregistered (never paid)", async () => {
    const id = await createUser("unregistered");
    created.push(id);
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });

  it("returns a refund notice for a registered user with a recent refund event", async () => {
    const id = await createUser("registered");
    created.push(id);
    await insertHistory(id, "refund");
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.ok(notice);
    assert.equal(notice!.kind, "refund");
    assert.equal(typeof notice!.occurredAt, "string");
  });

  it("returns a dispute_opened notice for a registered user with a recent dispute_opened event", async () => {
    const id = await createUser("registered");
    created.push(id);
    await insertHistory(id, "dispute_opened", { stripePaymentIntentId: "pi_secret_123", amount: 19900 });
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.ok(notice);
    assert.equal(notice!.kind, "dispute_opened");
    // Sensitive Stripe identifiers and amounts must NOT appear in the payload.
    const json = JSON.stringify(notice);
    assert.equal(json.includes("pi_secret_123"), false);
    assert.equal(json.includes("stripePaymentIntentId"), false);
    assert.equal(json.includes("19900"), false);
    assert.equal(json.includes("amount"), false);
  });

  it("returns a dispute_lost notice for a registered user with a recent dispute_lost event", async () => {
    const id = await createUser("registered");
    created.push(id);
    await insertHistory(id, "dispute_lost");
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.ok(notice);
    assert.equal(notice!.kind, "dispute_lost");
  });

  it("returns null when the most recent event is a non-revocation event (e.g. subscription_cancelled)", async () => {
    const id = await createUser("registered");
    created.push(id);
    // Older refund (would otherwise qualify) followed by a benign cancel.
    await insertHistory(id, "refund", { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
    await insertHistory(id, "subscription_cancelled");
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });

  it("returns null when the qualifying event is older than the notice window", async () => {
    const id = await createUser("registered");
    created.push(id);
    const stale = new Date(Date.now() - (REVOCATION_NOTICE_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000);
    await insertHistory(id, "refund", { createdAt: stale });
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });

  it("returns null after a dispute_won event supersedes a dispute_opened event", async () => {
    const id = await createUser("registered");
    created.push(id);
    await insertHistory(id, "dispute_opened", { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    await insertHistory(id, "dispute_won");
    const notice = await stripeStorage.getAccessRevocationNotice(id);
    assert.equal(notice, null);
  });
});
