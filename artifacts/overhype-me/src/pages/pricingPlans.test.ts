import { describe, it, expect } from "vitest";
import { selectPlanPrices, type StripePlan, type StripePlanPrice } from "./pricingPlans";

function price(overrides: Partial<StripePlanPrice> & { id: string; unit_amount: number }): StripePlanPrice {
  return { currency: "usd", recurring: null, ...overrides };
}

function plan(overrides: Partial<StripePlan> & { id: string; name: string; prices: StripePlanPrice[] }): StripePlan {
  return { description: null, metadata: {}, ...overrides };
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
});
