/**
 * The fake Stripe account's catalog (#566, plan decision 11).
 *
 * Small and fixed: one membership-tagged product with the three price shapes the
 * pricing page classifies — monthly and annual (each price's own `recurring`
 * field) and lifetime (a one-time price). It is the fake account's truth, never
 * production's, and nothing here is written anywhere but a fake-owned database.
 *
 * Typed as Stripe's own `Product` and `Price`, so the fixture cannot drift from
 * the shape the sync library persists and the app reads.
 */
import type Stripe from "stripe";
import { MEMBERSHIP_PRODUCT_METADATA_KEY } from "./membershipPricing.js";

export const FAKE_ACCOUNT_ID = "acct_fake_double";

/** 2026-01-01T00:00:00Z — fixed, so a re-run produces identical rows. */
const CREATED = 1767225600;

const product: Stripe.Product = {
  id: "prod_fake_legendary",
  object: "product",
  active: true,
  created: CREATED,
  default_price: "price_fake_legendary_monthly",
  description: "Fake Legendary membership — fixture data from the fake Stripe driver.",
  images: [],
  livemode: false,
  marketing_features: [],
  metadata: { [MEMBERSHIP_PRODUCT_METADATA_KEY]: "true" },
  name: "Legendary (fake)",
  package_dimensions: null,
  shippable: null,
  tax_code: null,
  type: "service",
  updated: CREATED,
  url: null,
};

function price(
  id: string,
  unitAmount: number,
  recurring: { interval: Stripe.Price.Recurring.Interval } | null,
): Stripe.Price {
  return {
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: CREATED,
    currency: "usd",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: product.id,
    recurring: recurring
      ? { interval: recurring.interval, interval_count: 1, meter: null, trial_period_days: null, usage_type: "licensed" }
      : null,
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: recurring ? "recurring" : "one_time",
    unit_amount: unitAmount,
    unit_amount_decimal: String(unitAmount),
  };
}

export const FAKE_PRODUCTS: readonly Stripe.Product[] = [product];

export const FAKE_PRICES: readonly Stripe.Price[] = [
  price("price_fake_legendary_monthly", 499, { interval: "month" }),
  price("price_fake_legendary_annual", 4900, { interval: "year" }),
  price("price_fake_legendary_lifetime", 9900, null),
];
