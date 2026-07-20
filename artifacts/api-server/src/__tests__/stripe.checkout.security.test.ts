/**
 * Security regression for C6 — Stripe membership price allowlist.
 *
 * "Legendary" must be granted ONLY for purchases of a product explicitly tagged
 * `overhype_membership=true`. Any other active price (render credits, merch,
 * tips, a cheaper SKU, a $0 price) is a normal payment and must never mint
 * Legendary — closing the price/tier-tampering hole where checkout accepted any
 * active price.
 *
 * The decision is single-sourced in lib/membershipPricing.ts and enforced at
 * every grant surface (checkout early-reject, the confirm endpoint, the
 * webhook). These tests cover the decision predicates exhaustively — including
 * every fail-closed edge — so no surface can drift. The confirm-endpoint
 * enforcement is proven end-to-end in checkoutConfirm.test.ts; the webhook
 * enforcement in webhookHandlers.integration.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import {
  productGrantsMembership,
  paymentIntentIsMembershipTagged,
  priceGrantsMembership,
  subscriptionGrantsMembership,
  MEMBERSHIP_PRODUCT_METADATA_KEY,
} from "../lib/membershipPricing.js";

// ── Builders ─────────────────────────────────────────────────────────────────
const membershipProduct = (id = "prod_m") =>
  ({ id, metadata: { [MEMBERSHIP_PRODUCT_METADATA_KEY]: "true" } }) as unknown as Stripe.Product;
const plainProduct = (id = "prod_p", metadata: Record<string, string> = {}) =>
  ({ id, metadata }) as unknown as Stripe.Product;
const deletedProduct = (id = "prod_d") =>
  ({ id, deleted: true }) as unknown as Stripe.DeletedProduct;

const priceWith = (product: unknown, id = "price_x") =>
  ({ id, product }) as unknown as Stripe.Price;
const subWithItems = (prices: unknown[]) =>
  ({
    id: "sub_x",
    items: { object: "list", data: prices.map((price) => ({ price })), has_more: false, url: "" },
  }) as unknown as Stripe.Subscription;

// A resolver that maps a fixed id→product; throws on any unexpected id so a
// test can't silently pass by resolving something it didn't intend.
function resolverFor(map: Record<string, Stripe.Product | Stripe.DeletedProduct>) {
  return {
    retrieveProduct: async (id: string) => {
      const p = map[id];
      if (!p) throw new Error(`unexpected retrieveProduct(${id})`);
      return p;
    },
  };
}

describe("productGrantsMembership (pure, fail-closed)", () => {
  it("tagged product → true", () => {
    assert.equal(productGrantsMembership(membershipProduct()), true);
  });
  it("untagged product → false", () => {
    assert.equal(productGrantsMembership(plainProduct()), false);
  });
  it("product tagged with a non-'true' value → false", () => {
    assert.equal(productGrantsMembership(plainProduct("p", { overhype_membership: "false" })), false);
    assert.equal(productGrantsMembership(plainProduct("p", { overhype_membership: "1" })), false);
    assert.equal(productGrantsMembership(plainProduct("p", { overhype_membership: "TRUE" })), false);
  });
  it("deleted product → false (can't read metadata)", () => {
    assert.equal(productGrantsMembership(deletedProduct()), false);
  });
  it("unexpanded product id (string) → false", () => {
    assert.equal(productGrantsMembership("prod_m"), false);
  });
  it("null / undefined → false", () => {
    assert.equal(productGrantsMembership(null), false);
    assert.equal(productGrantsMembership(undefined), false);
  });
});

describe("paymentIntentIsMembershipTagged (one-time verified stamp)", () => {
  it("membership:'true' → true", () => {
    assert.equal(paymentIntentIsMembershipTagged({ membership: "true" }), true);
  });
  it("plan:'lifetime' → true", () => {
    assert.equal(paymentIntentIsMembershipTagged({ plan: "lifetime" }), true);
  });
  it("untagged / unrelated metadata → false", () => {
    assert.equal(paymentIntentIsMembershipTagged({ userId: "u1" }), false);
    assert.equal(paymentIntentIsMembershipTagged({ membership: "false" }), false);
    assert.equal(paymentIntentIsMembershipTagged({}), false);
    assert.equal(paymentIntentIsMembershipTagged(null), false);
    assert.equal(paymentIntentIsMembershipTagged(undefined), false);
  });
});

describe("priceGrantsMembership (resolves product when needed)", () => {
  it("inline expanded membership product → true, no resolver call", async () => {
    const emptyResolver = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    assert.equal(await priceGrantsMembership(priceWith(membershipProduct()), emptyResolver), true);
  });
  it("inline expanded non-membership product → false", async () => {
    const emptyResolver = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    assert.equal(await priceGrantsMembership(priceWith(plainProduct()), emptyResolver), false);
  });
  it("product as bare id → resolved, tagged → true", async () => {
    const r = resolverFor({ prod_m: membershipProduct("prod_m") });
    assert.equal(await priceGrantsMembership(priceWith("prod_m"), r), true);
  });
  it("product as bare id → resolved, untagged → false", async () => {
    const r = resolverFor({ prod_p: plainProduct("prod_p") });
    assert.equal(await priceGrantsMembership(priceWith("prod_p"), r), false);
  });
});

describe("subscriptionGrantsMembership", () => {
  it("single membership item → true", async () => {
    const r = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    assert.equal(await subscriptionGrantsMembership(subWithItems([priceWith(membershipProduct())]), r), true);
  });
  it("single non-membership item → false", async () => {
    const r = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    assert.equal(await subscriptionGrantsMembership(subWithItems([priceWith(plainProduct())]), r), false);
  });
  it("mixed items (one membership) → true", async () => {
    const r = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    const sub = subWithItems([priceWith(plainProduct("p1")), priceWith(membershipProduct("m1"))]);
    assert.equal(await subscriptionGrantsMembership(sub, r), true);
  });
  it("no items → false (fail closed)", async () => {
    const r = { retrieveProduct: async () => { throw new Error("should not resolve"); } };
    assert.equal(await subscriptionGrantsMembership(subWithItems([]), r), false);
  });
  it("bare-id products are resolved, untagged → false", async () => {
    const r = resolverFor({ prod_p: plainProduct("prod_p") });
    assert.equal(await subscriptionGrantsMembership(subWithItems([priceWith("prod_p")]), r), false);
  });
});
