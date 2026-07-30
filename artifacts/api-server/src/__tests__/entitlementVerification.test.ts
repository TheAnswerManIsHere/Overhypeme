/**
 * The trust boundary.
 *
 * These are not "does the happy path work" tests. The boundary exists because a
 * validator that takes caller-supplied Stripe-shaped objects proves only that
 * its arguments agree with each other — so what is asserted here is that a
 * *valid* provider object cannot be applied to the *wrong user*, that a negative
 * conclusion is never drawn from an incomplete list, and that every value
 * written comes from the retrieved object rather than the request.
 *
 * Pure: the retriever is a fake, so no live Stripe. Note what a fake does and
 * does not prove — it substitutes the provider, never the caller's ability to
 * hand in a fabricated object, which is precisely the property the signature
 * (id in, not object in) is what guarantees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import {
  UnauthorizedGrantError,
  authorizeAdminGrant,
  authorizeAdminRevocation,
  verifyMembershipSubscription,
  verifyOneTimeMembershipPurchase,
  type EntitlementRetriever,
  type UserBinding,
  type VerificationDeps,
} from "../lib/entitlementVerification.js";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

const MEMBERSHIP_PRODUCT = {
  id: "prod_member",
  deleted: false,
  metadata: { overhype_membership: "true" },
} as unknown as Stripe.Product;

const MERCH_PRODUCT = {
  id: "prod_merch",
  deleted: false,
  metadata: {},
} as unknown as Stripe.Product;

const price = (id: string, productId: string, interval?: "month" | "year") =>
  ({ id, product: productId, recurring: interval ? { interval } : null }) as unknown as Stripe.Price;

const list = <T>(data: T[], hasMore = false) =>
  ({ object: "list", data, has_more: hasMore, url: "" }) as unknown as Stripe.ApiList<T>;

interface FakeWorld {
  sessions: Record<string, Partial<Stripe.Checkout.Session>>;
  lineItems: Record<string, Stripe.LineItem[]>;
  paymentIntents: Record<string, Partial<Stripe.PaymentIntent>>;
  subscriptions: Record<string, Partial<Stripe.Subscription>>;
  subscriptionItems: Record<string, Stripe.SubscriptionItem[]>;
  products: Record<string, Stripe.Product>;
  /** customer id -> user id */
  customers: Record<string, string>;
  /** Forced failures, keyed by a marker the call site checks. */
  failures?: Partial<Record<"lineItems" | "subscriptionItems" | "product", string>>;
  /** Force has_more true on the first page without a next page, to model truncation. */
  truncate?: "lineItems" | "subscriptionItems";
}

function makeDeps(world: FakeWorld): VerificationDeps & { linked: Array<[string, string]> } {
  const linked: Array<[string, string]> = [];

  const retriever: EntitlementRetriever = {
    async retrieveProduct(id) {
      if (world.failures?.product) throw new Error(world.failures.product);
      const product = world.products[id];
      if (!product) throw new Error(`no such product ${id}`);
      return product;
    },
    async retrieveCheckoutSession(id) {
      const session = world.sessions[id];
      if (!session) throw new Error(`no such session ${id}`);
      return { id, ...session } as Stripe.Checkout.Session;
    },
    async listCheckoutLineItems(sessionId, params) {
      if (world.failures?.lineItems) throw new Error(world.failures.lineItems);
      const items = world.lineItems[sessionId] ?? [];
      if (world.truncate === "lineItems" && !params.starting_after) return list(items, true);
      return list(params.starting_after ? [] : items, world.truncate === "lineItems");
    },
    async retrievePaymentIntent(id) {
      const pi = world.paymentIntents[id];
      if (!pi) throw new Error(`no such payment intent ${id}`);
      return { id, ...pi } as Stripe.PaymentIntent;
    },
    async retrieveSubscription(id) {
      const sub = world.subscriptions[id];
      if (!sub) throw new Error(`no such subscription ${id}`);
      return { id, ...sub } as Stripe.Subscription;
    },
    async listSubscriptionItems(subscriptionId, params) {
      if (world.failures?.subscriptionItems) throw new Error(world.failures.subscriptionItems);
      const items = world.subscriptionItems[subscriptionId] ?? [];
      if (world.truncate === "subscriptionItems" && !params.starting_after) return list(items, true);
      return list(params.starting_after ? [] : items, world.truncate === "subscriptionItems");
    },
  };

  const binding: UserBinding = {
    async findUserIdByCustomerId(customerId) {
      return world.customers[customerId] ?? null;
    },
    async linkCustomerToUser(userId, customerId) {
      if (Object.values(world.customers).includes(userId)) return false;
      world.customers[customerId] = userId;
      linked.push([userId, customerId]);
      return true;
    },
  };

  return { retriever, binding, linked };
}

function membershipWorld(): FakeWorld {
  return {
    sessions: {
      cs_ok: {
        mode: "payment",
        customer: "cus_1",
        payment_status: "paid",
        payment_intent: "pi_1",
      },
    },
    lineItems: {
      cs_ok: [{ id: "li_1", price: price("price_life", "prod_member") } as unknown as Stripe.LineItem],
    },
    paymentIntents: { pi_1: { status: "succeeded", amount: 9900, currency: "usd" } },
    subscriptions: {
      sub_ok: {
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1_800_000_000,
      } as Partial<Stripe.Subscription>,
    },
    subscriptionItems: {
      sub_ok: [{ id: "si_1", price: price("price_sub", "prod_member", "month") } as unknown as Stripe.SubscriptionItem],
    },
    products: { prod_member: MEMBERSHIP_PRODUCT, prod_merch: MERCH_PRODUCT },
    customers: { cus_1: "user-1" },
  };
}

// ---------------------------------------------------------------------------

describe("verifyOneTimeMembershipPurchase", () => {
  it("verifies a paid membership purchase and takes amount from the PaymentIntent", async () => {
    const world = membershipWorld();
    const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.userId, "user-1");
    assert.equal(result.providerRef, "pi_1", "the source's identity is the PaymentIntent");
    assert.equal(result.isMembershipProduct, true);
    assert.equal(result.amount, 9900);
    assert.equal(result.currency, "usd");
  });

  it("refuses a session belonging to a DIFFERENT user than the one requested", async () => {
    const world = membershipWorld();
    const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world), {
      expectedUserId: "user-2",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "user_mismatch");
  });

  it("refuses a subscription-mode session — this verifier cannot create that source type", async () => {
    const world = membershipWorld();
    world.sessions.cs_ok.mode = "subscription";
    const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "wrong_mode");
  });

  it("refuses an unpaid session even when the PaymentIntent says succeeded", async () => {
    const world = membershipWorld();
    world.sessions.cs_ok.payment_status = "unpaid";
    const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "payment_not_complete");
  });

  it("refuses a paid session whose PaymentIntent has NOT succeeded", async () => {
    // The two states describe different objects and a delayed-notification
    // method can leave them disagreeing, so both are required.
    for (const status of ["processing", "requires_action", "canceled", "requires_payment_method"]) {
      const world = membershipWorld();
      world.paymentIntents.pi_1.status = status as Stripe.PaymentIntent.Status;
      const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world));
      assert.equal(result.ok, false, status);
      if (result.ok) return;
      assert.equal(result.code, "payment_not_complete");
    }
  });

  it("classifies a non-membership purchase as such rather than failing", async () => {
    const world = membershipWorld();
    world.lineItems.cs_ok = [
      { id: "li_1", price: price("price_mug", "prod_merch") } as unknown as Stripe.LineItem,
    ];
    const result = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(world));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.isMembershipProduct, false);
  });

  it("refuses to conclude ANYTHING from a line-item list it could not fully read", async () => {
    // "Not a membership product" is a negative conclusion over a list, so a
    // truncated list must not produce `false` — that silently denies a paying
    // customer.
    const truncated = membershipWorld();
    truncated.truncate = "lineItems";
    const a = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(truncated));
    assert.equal(a.ok, false);
    if (a.ok) return;
    assert.equal(a.code, "incomplete_enumeration");

    const failing = membershipWorld();
    failing.failures = { lineItems: "stripe is down" };
    const b = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(failing));
    assert.equal(b.ok, false);
    if (b.ok) return;
    assert.equal(b.code, "incomplete_enumeration");
  });

  it("refuses a session with no customer, and one whose customer maps to nobody", async () => {
    const noCustomer = membershipWorld();
    noCustomer.sessions.cs_ok.customer = null;
    const a = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(noCustomer));
    assert.equal(a.ok, false);
    if (a.ok) return;
    assert.equal(a.code, "no_customer");

    const unknown = membershipWorld();
    unknown.customers = {};
    const b = await verifyOneTimeMembershipPurchase("cs_ok", makeDeps(unknown));
    assert.equal(b.ok, false);
    if (b.ok) return;
    assert.equal(b.code, "user_unresolvable");
  });

  it("links a first-purchase customer via the metadata hint, but only to an UNBOUND user", async () => {
    const first = membershipWorld();
    first.customers = {};
    first.sessions.cs_ok.metadata = { userId: "user-1" };
    const deps = makeDeps(first);
    const result = await verifyOneTimeMembershipPurchase("cs_ok", deps);
    assert.equal(result.ok, true);
    assert.deepEqual(deps.linked, [["user-1", "cus_1"]]);

    // A hint naming a user who is ALREADY bound to another customer must not
    // re-point anything — otherwise a hint could reassign someone's entitlement.
    const taken = membershipWorld();
    taken.customers = { cus_other: "user-1" };
    taken.sessions.cs_ok.metadata = { userId: "user-1" };
    const deps2 = makeDeps(taken);
    const blocked = await verifyOneTimeMembershipPurchase("cs_ok", deps2);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.code, "user_unresolvable");
    assert.deepEqual(deps2.linked, []);
  });
});

describe("verifyMembershipSubscription", () => {
  it("verifies a subscription and takes every value from the retrieved object", async () => {
    const result = await verifyMembershipSubscription("sub_ok", makeDeps(membershipWorld()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.userId, "user-1");
    assert.equal(result.providerRef, "sub_ok");
    assert.equal(result.isMembershipProduct, true);
    assert.equal(result.lifecycleStatus, "active");
    assert.equal(result.plan, "monthly");
    assert.equal(result.cancelAtPeriodEnd, false);
    assert.deepEqual(result.currentPeriodEnd, new Date(1_800_000_000 * 1000));
  });

  it("derives plan from the item that actually grants membership, not items[0]", async () => {
    const world = membershipWorld();
    world.subscriptionItems.sub_ok = [
      // A non-membership add-on listed FIRST, on a monthly price with no
      // recognized product tag.
      { id: "si_addon", price: price("price_addon", "prod_merch", "month") } as unknown as Stripe.SubscriptionItem,
      // The actual membership item, billed annually, listed second.
      { id: "si_member", price: price("price_sub", "prod_member", "year") } as unknown as Stripe.SubscriptionItem,
    ];
    const result = await verifyMembershipSubscription("sub_ok", makeDeps(world));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.isMembershipProduct, true);
    // Must reflect the MEMBERSHIP item's interval (annual), not the add-on's
    // (monthly) just because it was listed first.
    assert.equal(result.plan, "annual");
  });

  it("refuses a subscription belonging to another customer than the requested user", async () => {
    const result = await verifyMembershipSubscription("sub_ok", makeDeps(membershipWorld()), {
      expectedUserId: "user-2",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "user_mismatch");
  });

  it("creates NO qualifying source for a non-allowlisted product", async () => {
    const world = membershipWorld();
    world.subscriptionItems.sub_ok = [
      { id: "si_1", price: price("price_addon", "prod_merch") } as unknown as Stripe.SubscriptionItem,
    ];
    const result = await verifyMembershipSubscription("sub_ok", makeDeps(world));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The source still exists and is recorded — it is the QUALIFICATION that is
    // withheld, which is what lets a later plan-switch back flip it on again.
    assert.equal(result.isMembershipProduct, false);
  });

  it("re-evaluates the allowlist on refresh, so a plan switch drops access", async () => {
    const world = membershipWorld();
    const before = await verifyMembershipSubscription("sub_ok", makeDeps(world));
    assert.equal(before.ok && before.isMembershipProduct, true);

    // The portal switches the price to a non-membership one.
    world.subscriptionItems.sub_ok = [
      { id: "si_1", price: price("price_addon", "prod_merch") } as unknown as Stripe.SubscriptionItem,
    ];
    const after = await verifyMembershipSubscription("sub_ok", makeDeps(world));
    assert.equal(after.ok && after.isMembershipProduct, false);
  });

  it("reports every lifecycle status faithfully rather than collapsing to active/canceled", async () => {
    for (const status of [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "paused",
    ] as Stripe.Subscription.Status[]) {
      const world = membershipWorld();
      world.subscriptions.sub_ok.status = status;
      const result = await verifyMembershipSubscription("sub_ok", makeDeps(world));
      assert.equal(result.ok, true, status);
      if (!result.ok) return;
      assert.equal(result.lifecycleStatus, status);
    }
  });

  it("refuses to conclude anything from an item list it could not fully read", async () => {
    const truncated = membershipWorld();
    truncated.truncate = "subscriptionItems";
    const a = await verifyMembershipSubscription("sub_ok", makeDeps(truncated));
    assert.equal(a.ok, false);
    if (a.ok) return;
    assert.equal(a.code, "incomplete_enumeration");

    // An unresolvable PRODUCT is the same class of failure — it cannot support
    // "this is not a membership subscription" either.
    const badProduct = membershipWorld();
    badProduct.failures = { product: "product lookup failed" };
    const b = await verifyMembershipSubscription("sub_ok", makeDeps(badProduct));
    assert.equal(b.ok, false);
    if (b.ok) return;
    assert.equal(b.code, "incomplete_enumeration");
  });

  it("surfaces a retrieval failure instead of inventing a source", async () => {
    const result = await verifyMembershipSubscription("sub_missing", makeDeps(membershipWorld()));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "retrieval_failed");
  });
});

describe("W1b — admin grant authorization", () => {
  it("produces a grant that carries actor, label and reason", () => {
    const grant = authorizeAdminGrant({
      userId: "user-1",
      grantedByAdminId: "admin-1",
      grantedByAdminLabel: "admin@example.test",
      grantReason: "support comp",
    });
    assert.equal(grant.sourceType, "admin_grant");
    assert.equal(grant.lifecycleStatus, "active");
    assert.equal(grant.grantReason, "support comp");
    // It never masquerades as a payment: no provider ref, no amount, no currency.
    assert.equal("providerRef" in grant, false);
    assert.equal("amount" in grant, false);
  });

  it("refuses a grant missing any part of its provenance", () => {
    const base = {
      userId: "user-1",
      grantedByAdminId: "admin-1",
      grantedByAdminLabel: "admin@example.test",
      grantReason: "support comp",
    };
    for (const field of ["userId", "grantedByAdminId", "grantedByAdminLabel", "grantReason"] as const) {
      assert.throws(
        () => authorizeAdminGrant({ ...base, [field]: "" }),
        UnauthorizedGrantError,
        `blank ${field}`,
      );
      assert.throws(
        () => authorizeAdminGrant({ ...base, [field]: "   " }),
        UnauthorizedGrantError,
        `whitespace-only ${field}`,
      );
    }
  });

  it("refuses a revocation missing its own provenance — the grant clause does not cover this", () => {
    const base = {
      revokedByAdminId: "admin-1",
      revokedByAdminLabel: "admin@example.test",
      revokedReason: "chargeback",
    };
    assert.equal(authorizeAdminRevocation(base).lifecycleStatus, "revoked");
    for (const field of ["revokedByAdminId", "revokedByAdminLabel", "revokedReason"] as const) {
      assert.throws(() => authorizeAdminRevocation({ ...base, [field]: "" }), UnauthorizedGrantError);
    }
  });
});
