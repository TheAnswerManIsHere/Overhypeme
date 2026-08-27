/**
 * Test 15 — during a degraded boot, the payment routes name the unverified
 * state instead of telling the customer to try again.
 *
 * Exercised THROUGH the routes, not against the responder in isolation, so the
 * mapping is proven reachable rather than merely present. Every call site here
 * passes a fixed `clientMessage` ("Unable to start checkout. Please try again."
 * and variants) and the thrown error's own message is logged and discarded — so
 * without the mapping in the shared responder these endpoints would hand a
 * customer retry advice for a condition retrying does not fix.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import stripeRouter from "../routes/stripe.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";
import {
  __resetVerificationStateForTests,
  __setAccountRetrieverForTests,
} from "../lib/stripeAccountGuard.js";
import { STRIPE_UNVERIFIED_CODE } from "../lib/stripeVerificationErrors.js";
import { invalidateStripeSync } from "../lib/stripeClient.js";

const USER_PREFIX = "tstriperefusal-";
const restores: Array<() => void> = [];
let sid: string;
let customerUserSid: string;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(stripeRouter);
  return app;
}

// Every hook below is scoped INSIDE this describe deliberately.
// `node --test` runs this suite with `--test-isolation=none`, so a hook
// declared at a file's top level attaches to the ROOT suite — which spans
// every test file in the process. A root-level `beforeEach` here that deletes
// STRIPE_* env vars would therefore run before other files' tests too, and
// break them somewhere far from this file.
describe("payment routes during a degraded boot", () => {
before(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));

  const plainId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: plainId, email: `${plainId}@test.local` });
  sid = await createSession(
    { user: { id: plainId } as unknown as SessionData["user"], access_token: "t", isAdmin: false },
    plainId,
  );

  // The portal route returns 400 before reaching Stripe unless a customer id
  // exists, so it needs a user that has one.
  const customerId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: customerId,
    email: `${customerId}@test.local`,
    stripeCustomerId: "cus_test_refusal",
  });
  customerUserSid = await createSession(
    { user: { id: customerId } as unknown as SessionData["user"], access_token: "t", isAdmin: false },
    customerId,
  );
});

after(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});

beforeEach(() => {
  __resetVerificationStateForTests();
  invalidateStripeSync();
  // Credentials present and declared, but Stripe cannot be reached — the
  // degraded boot this guard's availability posture creates.
  process.env.STRIPE_SECRET_KEY_TEST = "sk_test_correct";
  process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
  process.env.STRIPE_ACCOUNT_ID_TEST = "acct_test_expected";
  restores.push(__setAccountRetrieverForTests(async () => { throw new Error("ECONNREFUSED stripe.com"); }));
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  __resetVerificationStateForTests();
  invalidateStripeSync();
});

const CASES: Array<{ name: string; send: (app: Express) => request.Test; asCustomer?: boolean }> = [
  {
    name: "POST /stripe/checkout",
    send: (app) => request(app).post("/stripe/checkout").send({ priceId: "price_test_x" }),
  },
  {
    name: "POST /stripe/portal",
    asCustomer: true,
    send: (app) => request(app).post("/stripe/portal").send({}),
  },
  {
    name: "POST /stripe/subscription/cancel",
    send: (app) => request(app).post("/stripe/subscription/cancel").send({}),
  },
];

describe("test 15 — payment routes name the unverified state", () => {
  for (const c of CASES) {
    it(`${c.name} returns a typed 503 and no account identifier`, async () => {
      const res = await c
        .send(makeApp())
        .set("authorization", `Bearer ${c.asCustomer ? customerUserSid : sid}`);

      assert.equal(res.status, 503, `${c.name}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, STRIPE_UNVERIFIED_CODE);
      assert.doesNotMatch(String(res.body.error), /acct_/, "no account id may reach an end user");
      assert.doesNotMatch(String(res.body.error), /sk_/, "no credential may reach an end user");
      assert.match(String(res.body.error), /temporarily unavailable/i);
    });
  }
});

describe("no refusal message asserts something false about the customer's money", () => {
  it("the receipt lookup never claims no charge was made", async () => {
    // Round 6's escalation, and David's call. This route's entire purpose is
    // retrieving evidence of a charge that ALREADY happened, so the shared
    // default — "No charge was made" — is a false statement about someone's
    // money, sent to them by a working system in a degraded window.
    //
    // Note what is asserted: not that a particular replacement string is
    // present, but that the CLAIM is absent. A future edit that rewords the
    // receipt message still passes; one that lets the default back through
    // does not.
    const res = await request(makeApp())
      .get("/stripe/invoice/in_test_receipt/receipt")
      .set("authorization", `Bearer ${sid}`);

    assert.equal(res.status, 503, `${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, STRIPE_UNVERIFIED_CODE);
    assert.doesNotMatch(
      String(res.body.error),
      /no charge|not been charged|charge was made/i,
      "a receipt lookup must not tell a paying customer that no charge was made",
    );
    assert.doesNotMatch(String(res.body.error), /acct_/, "no account id may reach an end user");
    assert.match(String(res.body.error), /receipt/i, "it should say what actually failed");
  });

  it("the pre-charge routes keep the reassurance, which is true on them", async () => {
    // The other half of the same property: neutralising the claim everywhere
    // would have cost the six pre-charge paths the reassurance that stops a
    // worried customer paying twice. Fixing one path must not silently change
    // the others.
    const res = await request(makeApp())
      .post("/stripe/checkout")
      .send({ priceId: "price_test_x" })
      .set("authorization", `Bearer ${sid}`);

    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /No charge was made/i);
  });
});
});
