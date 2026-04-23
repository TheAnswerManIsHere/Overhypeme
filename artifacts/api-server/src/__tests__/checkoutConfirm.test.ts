/**
 * Tests for the checkout/confirm flow.
 *
 * Three test layers:
 *  1. HTTP integration tests — mount the real stripe router via Express and
 *     test the request-validation gate (auth, sessionId format). These fire
 *     BEFORE any Stripe API call, so no module mocking is required.
 *
 *  2. handleConfirmRequest unit tests — exercise the full session-retrieval →
 *     ownership-check → grant pipeline using a fake CheckoutSessionRetriever
 *     (injected Stripe client) and fake GrantDeps. No live network calls.
 *
 *  3. Grant-helper unit tests — grantLegendaryViaSubscription /
 *     grantLegendaryViaOneTimePayment in isolation via injected GrantDeps.
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";

// ── Modules under test ───────────────────────────────────────────────────────
import {
  grantLegendaryViaSubscription,
  grantLegendaryViaOneTimePayment,
  handleConfirmRequest,
  type GrantDeps,
  type CheckoutSessionRetriever,
  type CheckoutSession,
} from "../lib/membershipGrant.js";
import type Stripe from "stripe";

// ── Minimal Express integration server (for HTTP gate tests) ─────────────────
import stripeRouter from "../routes/stripe.js";

function startServer(opts: { authenticated: boolean; userId?: string }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as unknown as Record<string, unknown>;
      r["isAuthenticated"] = () => opts.authenticated;
      if (opts.authenticated) r["user"] = { id: opts.userId ?? "test-user-id" };
      const noop = () => {};
      r["log"] = { error: noop, warn: noop, info: noop, debug: noop, trace: noop, fatal: noop };
      next();
    });
    app.use(stripeRouter);
    const server = app.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function postConfirm(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/stripe/checkout/confirm`);
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bodyStr)) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> }); }
          catch { resolve({ status: res.statusCode ?? 0, body: { raw: data } }); }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Fake GrantDeps factory ────────────────────────────────────────────────────

type Calls = {
  upsert: unknown[][];
  getSubBySubId: string[];
  setTier: string[];
  history: unknown[][];
  lifetimeInsert: unknown[][];
  lifetimeLookup: string[];
};

function makeFakeDeps(opts: {
  existingLifetimeRow?: boolean;
  existingSubRow?: boolean;
} = {}): { deps: GrantDeps; calls: Calls } {
  const calls: Calls = {
    upsert: [],
    getSubBySubId: [],
    setTier: [],
    history: [],
    lifetimeInsert: [],
    lifetimeLookup: [],
  };
  const deps: GrantDeps = {
    async getSubscriptionBySubId(subId) {
      calls.getSubBySubId.push(subId);
      return opts.existingSubRow ? { id: 1 } : null;
    },
    async upsertSubscriptionRow(userId, customerId, subId, status, plan, periodEnd, cancelAtPeriodEnd) {
      calls.upsert.push([userId, customerId, subId, status, plan, periodEnd, cancelAtPeriodEnd]);
    },
    async getLifetimeByPaymentIntentId(piId) {
      calls.lifetimeLookup.push(piId);
      return opts.existingLifetimeRow ? { id: 1 } : null;
    },
    async insertLifetimeEntitlementRow(userId, customerId, piId, amount, currency) {
      calls.lifetimeInsert.push([userId, customerId, piId, amount, currency]);
    },
    async setMembershipTierToLegendary(userId) {
      calls.setTier.push(userId);
    },
    async recordMembershipHistory(userId, event, histOpts) {
      calls.history.push([userId, event, histOpts]);
    },
  };
  return { deps, calls };
}

// ── Fake CheckoutSessionRetriever factory ────────────────────────────────────

function makeSubscriptionSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: "cs_test_sub123",
    mode: "subscription",
    payment_status: "no_payment_required",
    metadata: { userId: "user-1" },
    customer: "cus_1",
    subscription: {
      id: "sub_test_1",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      items: {
        object: "list",
        data: [{ price: { id: "price_1", recurring: { interval: "month" } } } as Stripe.SubscriptionItem],
        has_more: false,
        url: "",
      },
    } as Stripe.Subscription & { current_period_end?: number },
    payment_intent: null,
    ...overrides,
  } as unknown as CheckoutSession;
}

function makePaymentSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: "cs_test_pay123",
    mode: "payment",
    payment_status: "paid",
    metadata: { userId: "user-1" },
    customer: "cus_1",
    subscription: null,
    payment_intent: {
      id: "pi_test_1",
      status: "succeeded",
      amount: 29900,
      currency: "usd",
    } as Stripe.PaymentIntent,
    ...overrides,
  } as unknown as CheckoutSession;
}

function fakeRetriever(session: CheckoutSession): CheckoutSessionRetriever {
  return {
    checkout: {
      sessions: {
        retrieve: async (_id: string) => session,
      },
    },
  };
}

const noopLink = async (_uid: string, _cid: string) => {};

// ── HTTP gate tests ───────────────────────────────────────────────────────────

test("POST /stripe/checkout/confirm → 401 when not authenticated", async () => {
  const server = await startServer({ authenticated: false });
  try {
    const res = await postConfirm(server.url, { sessionId: "cs_test_abc123" });
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.error, "string");
  } finally {
    await server.close();
  }
});

test("POST /stripe/checkout/confirm → 400 when sessionId is missing", async () => {
  const server = await startServer({ authenticated: true });
  try {
    const res = await postConfirm(server.url, {});
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, "string");
  } finally {
    await server.close();
  }
});

test("POST /stripe/checkout/confirm → 400 when sessionId does not start with cs_", async () => {
  const server = await startServer({ authenticated: true });
  try {
    const res = await postConfirm(server.url, { sessionId: "pi_not_a_checkout_session" });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

// ── handleConfirmRequest endpoint-logic unit tests ───────────────────────────

describe("handleConfirmRequest", () => {
  it("grants legendary for a subscription checkout session (matched by metadata.userId)", async () => {
    const { deps, calls } = makeFakeDeps();
    const session = makeSubscriptionSession({ metadata: { userId: "user-1" } });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_sub123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok(!("httpStatus" in result), `Expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.tier, "legendary");
    assert.equal(result.source, "confirm");
    assert.equal(result.result, "granted");
    assert.equal(calls.setTier.length, 1);
    assert.equal(calls.history.length, 1);
    assert.equal((calls.history[0] as unknown[])[1], "subscription_activated");
  });

  it("grants legendary for a subscription checkout matched by stripeCustomerId", async () => {
    const { deps } = makeFakeDeps();
    const session = makeSubscriptionSession({ metadata: {} }); // no userId in metadata

    const result = await handleConfirmRequest({
      userId: "user-99",
      userStripeCustomerId: "cus_1",   // matches session.customer
      sessionId: "cs_test_sub123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok(!("httpStatus" in result));
    assert.equal(result.tier, "legendary");
  });

  it("returns 403 when session does not belong to the user", async () => {
    const { deps } = makeFakeDeps();
    const session = makeSubscriptionSession({ metadata: { userId: "other-user" }, customer: "cus_other" });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: "cus_mine",
      sessionId: "cs_test_sub123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok("httpStatus" in result);
    assert.equal(result.httpStatus, 403);
  });

  it("returns 400 when subscription status is incomplete (not active/trialing)", async () => {
    const { deps } = makeFakeDeps();
    const session = makeSubscriptionSession({
      metadata: { userId: "user-1" },
      subscription: {
        id: "sub_incomplete",
        status: "incomplete",
        cancel_at_period_end: false,
        items: { object: "list", data: [], has_more: false, url: "" },
      } as unknown as Stripe.Subscription,
    });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_sub123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok("httpStatus" in result);
    assert.equal(result.httpStatus, 400);
  });

  it("grants legendary for a one-time payment session", async () => {
    const { deps, calls } = makeFakeDeps();
    const session = makePaymentSession({ metadata: { userId: "user-1" } });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_pay123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok(!("httpStatus" in result));
    assert.equal(result.tier, "legendary");
    assert.equal(result.result, "granted");
    assert.equal(calls.lifetimeInsert.length, 1);
    assert.equal((calls.lifetimeInsert[0] as unknown[])[2], "pi_test_1");
  });

  it("returns 400 when payment session is not paid", async () => {
    const { deps } = makeFakeDeps();
    const session = makePaymentSession({
      metadata: { userId: "user-1" },
      payment_status: "unpaid",
    });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_pay123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok("httpStatus" in result);
    assert.equal(result.httpStatus, 400);
  });

  it("returns already_recorded when confirm is called again for same subscription", async () => {
    const { deps, calls } = makeFakeDeps({ existingSubRow: true });
    const session = makeSubscriptionSession({ metadata: { userId: "user-1" } });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_sub123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok(!("httpStatus" in result));
    assert.equal(result.result, "already_recorded");
    assert.equal(calls.history.length, 0, "should NOT write duplicate history");
    assert.equal(calls.setTier.length, 1, "should still set tier");
  });

  it("returns already_recorded for repeat one-time payment confirm", async () => {
    const { deps, calls } = makeFakeDeps({ existingLifetimeRow: true });
    const session = makePaymentSession({ metadata: { userId: "user-1" } });

    const result = await handleConfirmRequest({
      userId: "user-1",
      userStripeCustomerId: null,
      sessionId: "cs_test_pay123",
      stripe: fakeRetriever(session),
      deps,
      linkCustomerId: noopLink,
    });

    assert.ok(!("httpStatus" in result));
    assert.equal(result.result, "already_recorded");
    assert.equal(calls.lifetimeInsert.length, 0, "should NOT insert duplicate lifetime row");
    assert.equal(calls.history.length, 0, "should NOT write duplicate history");
  });
});

// ── Unit tests for grantLegendaryViaSubscription ──────────────────────────────

describe("grantLegendaryViaSubscription", () => {
  function makeSub(overrides: Partial<Stripe.Subscription & { current_period_end?: number }> = {}): Stripe.Subscription & { current_period_end?: number } {
    return {
      id: "sub_test_1",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      items: {
        object: "list",
        data: [{
          price: { id: "price_1", recurring: { interval: "month" } },
        } as Stripe.SubscriptionItem],
        has_more: false,
        url: "",
      },
      ...overrides,
    } as Stripe.Subscription & { current_period_end?: number };
  }

  it("grants legendary for an active subscription (monthly)", async () => {
    const { deps, calls } = makeFakeDeps();
    const result = await grantLegendaryViaSubscription("user-1", "cus_1", makeSub(), deps);

    assert.equal(result, "granted");
    assert.equal(calls.upsert.length, 1, "should upsert subscription row");
    assert.equal((calls.upsert[0] as unknown[])[4], "monthly", "plan should be 'monthly'");
    assert.equal(calls.setTier.length, 1, "should set membership tier");
    assert.equal(calls.setTier[0], "user-1");
    assert.equal(calls.history.length, 1, "should record history");
    assert.equal((calls.history[0] as unknown[])[1], "subscription_activated");
  });

  it("grants legendary for an annual subscription", async () => {
    const { deps, calls } = makeFakeDeps();
    const sub = makeSub({
      items: {
        object: "list",
        data: [{ price: { id: "price_annual", recurring: { interval: "year" } } } as Stripe.SubscriptionItem],
        has_more: false,
        url: "",
      },
    });
    const result = await grantLegendaryViaSubscription("user-2", "cus_2", sub, deps);

    assert.equal(result, "granted");
    assert.equal((calls.upsert[0] as unknown[])[4], "annual", "plan should be 'annual'");
  });

  it("grants legendary for a trialing subscription", async () => {
    const { deps, calls } = makeFakeDeps();
    const result = await grantLegendaryViaSubscription("user-3", "cus_3", makeSub({ status: "trialing" }), deps);
    assert.equal(result, "granted");
    assert.equal(calls.setTier.length, 1);
  });

  it("throws (status 400) for an incomplete subscription", async () => {
    const { deps } = makeFakeDeps();
    await assert.rejects(
      () => grantLegendaryViaSubscription("user-4", "cus_4", makeSub({ status: "incomplete" }), deps),
      (err: Error & { httpStatus?: number }) => {
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  it("throws (status 400) for a cancelled subscription", async () => {
    const { deps } = makeFakeDeps();
    await assert.rejects(
      () => grantLegendaryViaSubscription("user-5", "cus_5", makeSub({ status: "canceled" }), deps),
      (err: Error & { httpStatus?: number }) => {
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  it("returns already_recorded (no history) when sub row already exists", async () => {
    const { deps, calls } = makeFakeDeps({ existingSubRow: true });
    const result = await grantLegendaryViaSubscription("user-6", "cus_6", makeSub({ id: "sub_idem" }), deps);

    assert.equal(result, "already_recorded");
    assert.equal(calls.upsert.length, 1, "upsert still runs (idempotent via onConflictDoUpdate)");
    assert.equal(calls.setTier.length, 1, "setTier still runs (idempotent UPDATE)");
    assert.equal(calls.history.length, 0, "history NOT written on re-call");
  });
});

// ── Unit tests for grantLegendaryViaOneTimePayment ────────────────────────────

describe("grantLegendaryViaOneTimePayment", () => {
  function makePi(overrides: Partial<Pick<Stripe.PaymentIntent, "id" | "status" | "amount" | "currency">> = {}): Pick<Stripe.PaymentIntent, "id" | "status" | "amount" | "currency"> {
    return { id: "pi_test_1", status: "succeeded", amount: 29900, currency: "usd", ...overrides };
  }

  it("grants legendary for a succeeded payment intent", async () => {
    const { deps, calls } = makeFakeDeps();
    const result = await grantLegendaryViaOneTimePayment("user-1", "cus_1", makePi(), deps);

    assert.equal(result, "granted");
    assert.equal(calls.lifetimeInsert.length, 1, "should insert lifetime entitlement row");
    assert.equal((calls.lifetimeInsert[0] as unknown[])[2], "pi_test_1");
    assert.equal((calls.lifetimeInsert[0] as unknown[])[3], 29900);
    assert.equal(calls.setTier.length, 1, "should set membership tier");
    assert.equal(calls.history.length, 1, "should record history");
    assert.equal((calls.history[0] as unknown[])[1], "lifetime_purchase");
  });

  it("returns already_recorded when the payment intent row exists (idempotent)", async () => {
    const { deps, calls } = makeFakeDeps({ existingLifetimeRow: true });
    const result = await grantLegendaryViaOneTimePayment("user-2", "cus_2", makePi(), deps);

    assert.equal(result, "already_recorded");
    assert.equal(calls.lifetimeInsert.length, 0, "should NOT insert a duplicate row");
    assert.equal(calls.setTier.length, 1, "should still set tier (in case downgrade happened since)");
    assert.equal(calls.history.length, 0, "should NOT record duplicate history");
  });

  it("throws (status 400) when payment intent status is not succeeded", async () => {
    const { deps } = makeFakeDeps();
    await assert.rejects(
      () => grantLegendaryViaOneTimePayment("user-3", "cus_3", makePi({ status: "requires_payment_method" }), deps),
      (err: Error & { httpStatus?: number }) => {
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  it("throws (status 400) when payment intent status is processing", async () => {
    const { deps } = makeFakeDeps();
    await assert.rejects(
      () => grantLegendaryViaOneTimePayment("user-4", "cus_4", makePi({ status: "processing" }), deps),
      (err: Error & { httpStatus?: number }) => {
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });
});
