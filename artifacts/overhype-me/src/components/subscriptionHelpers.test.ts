import { describe, it, expect } from "vitest";
import {
  findAnnualPriceId,
  getAnnualSavingsPercent,
  type SubscriptionPlanProduct,
  type SubscriptionPlanPrice,
} from "./subscriptionHelpers";

function price(overrides: Partial<SubscriptionPlanPrice> & { id: string; unit_amount: number }): SubscriptionPlanPrice {
  return { currency: "usd", recurring: null, ...overrides };
}

// Defaults to a membership-tagged product, since most fixtures here represent
// genuine Legendary plans; the non-membership regression tests override
// metadata explicitly.
function plan(overrides: Partial<SubscriptionPlanProduct> & { id: string; name: string; prices: SubscriptionPlanPrice[] }): SubscriptionPlanProduct {
  return { description: null, metadata: { overhype_membership: "true" }, ...overrides };
}

describe("findAnnualPriceId", () => {
  it("finds the annual price on the same product as the current price", () => {
    const plans = [
      plan({
        id: "prod_legendary",
        name: "Legendary",
        prices: [
          price({ id: "price_month", unit_amount: 399, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_year", unit_amount: 3999, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
    ];

    expect(findAnnualPriceId(plans, "price_month")).toBe("price_year");
  });

  // Regression (Codex review, PR #258): the fallback path — used when the
  // subscriber's current price isn't in the synced plans list (stale sync) —
  // scanned every product for the first annual-recurring price with no
  // overhype_membership check, so it could offer switching to a
  // non-membership product's annual price (which switch-preview/switch-plan
  // then reject at the grant layer, but the offer itself is a broken-UX bug).
  it("ignores non-membership products in the fallback (current price not found) path", () => {
    const plans = [
      plan({
        id: "prod_render_credits",
        name: "Render Credits",
        metadata: {},
        prices: [
          price({ id: "price_credits_year", unit_amount: 1999, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
      plan({
        id: "prod_legendary",
        name: "Legendary",
        prices: [
          price({ id: "price_year", unit_amount: 3999, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
    ];

    // currentPriceId not present in either product's prices -> fallback path
    expect(findAnnualPriceId(plans, "price_not_in_catalog")).toBe("price_year");
  });

  it("returns null when no membership product has an annual price", () => {
    const plans = [
      plan({
        id: "prod_render_credits",
        name: "Render Credits",
        metadata: {},
        prices: [price({ id: "price_credits_year", unit_amount: 1999, recurring: { interval: "year", interval_count: 1 } })],
      }),
    ];

    expect(findAnnualPriceId(plans, "price_not_in_catalog")).toBeNull();
  });
});

describe("getAnnualSavingsPercent", () => {
  it("computes savings from the same product as the current price", () => {
    const plans = [
      plan({
        id: "prod_legendary",
        name: "Legendary",
        prices: [
          price({ id: "price_month", unit_amount: 1000, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_year", unit_amount: 6000, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
    ];

    // $10/mo vs $60/yr ($5/mo equivalent) -> 50% savings
    expect(getAnnualSavingsPercent(plans, "price_month")).toBe(50);
  });

  // Regression (Codex review, PR #258): same fallback gap as findAnnualPriceId.
  it("ignores non-membership products in the fallback (current price not found) path", () => {
    const plans = [
      plan({
        id: "prod_render_credits",
        name: "Render Credits",
        metadata: {},
        prices: [
          price({ id: "price_credits_month", unit_amount: 100, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_credits_year", unit_amount: 600, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
      plan({
        id: "prod_legendary",
        name: "Legendary",
        prices: [
          price({ id: "price_month", unit_amount: 1000, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_year", unit_amount: 6000, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
    ];

    expect(getAnnualSavingsPercent(plans, "price_not_in_catalog")).toBe(50);
  });
});
