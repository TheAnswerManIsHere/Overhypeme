import { describe, it, expect } from "vitest";
import { selectPlanPrices, type StripePlan, type StripePlanPrice } from "./pricingPlans";

function price(overrides: Partial<StripePlanPrice> & { id: string; unit_amount: number }): StripePlanPrice {
  return { currency: "usd", recurring: null, ...overrides };
}

// Defaults to a membership-tagged product, since most fixtures in this file
// represent genuine Legendary plans; the non-membership regression test
// overrides metadata explicitly.
function plan(overrides: Partial<StripePlan> & { id: string; name: string; prices: StripePlanPrice[] }): StripePlan {
  return { description: null, metadata: { overhype_membership: "true" }, ...overrides };
}

describe("selectPlanPrices", () => {
  it("finds monthly/annual/lifetime prices when each is its own Stripe product", () => {
    const plans = [
      plan({ id: "prod_month", name: "Legendary Monthly", prices: [price({ id: "price_month", unit_amount: 399, recurring: { interval: "month", interval_count: 1 } })] }),
      plan({ id: "prod_year", name: "Legendary Annual", prices: [price({ id: "price_year", unit_amount: 3999, recurring: { interval: "year", interval_count: 1 } })] }),
      plan({ id: "prod_life", name: "Legendary for Life", prices: [price({ id: "price_life", unit_amount: 9900 })] }),
    ];

    const result = selectPlanPrices(plans);

    expect(result.monthlyPrice?.id).toBe("price_month");
    expect(result.annualPrice?.id).toBe("price_year");
    expect(result.lifetimePrice?.id).toBe("price_life");
  });

  // Regression: David saw only the "Forever" one-time option on the pricing
  // page even though monthly and annual prices existed in Stripe. Root cause
  // was classifying by the parent PRODUCT's name/first-price rather than by
  // each PRICE's own `recurring` field — so a single Stripe product carrying
  // all three price points (the natural "one product, several price options"
  // dashboard setup) collapsed onto a single plan slot and silently dropped
  // its siblings.
  it("finds all three prices when one Stripe product carries all of them", () => {
    const plans = [
      plan({
        id: "prod_legendary",
        name: "Legendary",
        prices: [
          price({ id: "price_month", unit_amount: 399, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_year", unit_amount: 3999, recurring: { interval: "year", interval_count: 1 } }),
          price({ id: "price_life", unit_amount: 9900 }),
        ],
      }),
    ];

    const result = selectPlanPrices(plans);

    expect(result.monthlyPrice?.id).toBe("price_month");
    expect(result.annualPrice?.id).toBe("price_year");
    expect(result.lifetimePrice?.id).toBe("price_life");
  });

  it("does not let a product name containing 'forever' swallow its own recurring prices", () => {
    const plans = [
      plan({
        id: "prod_legendary",
        name: "Legendary Forever",
        prices: [
          price({ id: "price_month", unit_amount: 399, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_year", unit_amount: 3999, recurring: { interval: "year", interval_count: 1 } }),
          price({ id: "price_life", unit_amount: 9900 }),
        ],
      }),
    ];

    const result = selectPlanPrices(plans);

    expect(result.monthlyPrice?.id).toBe("price_month");
    expect(result.annualPrice?.id).toBe("price_year");
    expect(result.lifetimePrice?.id).toBe("price_life");
  });

  // Regression (Codex review, PR #255): /api/stripe/plans returns every
  // active Stripe product, not just membership ones — checkout enforces the
  // `overhype_membership` metadata allowlist (see membershipPricing.ts) but
  // this page didn't, so a non-membership product (render credits, merch,
  // tips) with a recurring or one-time price could get advertised here as a
  // Legendary plan and then get rejected at checkout with "Invalid price:
  // not a membership plan".
  it("ignores prices from products not tagged as membership products", () => {
    const plans = [
      plan({
        id: "prod_legendary",
        name: "Legendary",
        metadata: { overhype_membership: "true" },
        prices: [price({ id: "price_life", unit_amount: 9900 })],
      }),
      plan({
        id: "prod_render_credits",
        name: "Render Credits",
        metadata: {},
        prices: [
          price({ id: "price_credits_month", unit_amount: 199, recurring: { interval: "month", interval_count: 1 } }),
          price({ id: "price_credits_year", unit_amount: 1999, recurring: { interval: "year", interval_count: 1 } }),
        ],
      }),
    ];

    const result = selectPlanPrices(plans);

    expect(result.lifetimePrice?.id).toBe("price_life");
    expect(result.monthlyPrice).toBeUndefined();
    expect(result.annualPrice).toBeUndefined();
  });
});
