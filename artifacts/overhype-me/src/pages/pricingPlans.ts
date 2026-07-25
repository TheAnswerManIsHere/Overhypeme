export interface StripePlanPrice {
  id: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: string; interval_count: number } | null;
}

export interface StripePlan {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: StripePlanPrice[];
}

export interface SelectedPlanPrices {
  monthlyPrice?: StripePlanPrice;
  annualPrice?: StripePlanPrice;
  lifetimePrice?: StripePlanPrice;
}

/**
 * Product-metadata key that marks a product as conferring Legendary
 * membership. Mirrors MEMBERSHIP_PRODUCT_METADATA_KEY in
 * artifacts/api-server/src/lib/membershipPricing.ts — duplicated here
 * because the frontend can't import backend code. `/stripe/checkout`
 * enforces this same allowlist, so a plan the pricing page advertises
 * without it would be rejected at checkout.
 */
const MEMBERSHIP_PRODUCT_METADATA_KEY = "overhype_membership";

/**
 * Classify Stripe's active prices into the three plan slots the pricing page
 * shows, by each PRICE's own `recurring` field — not by guessing from the
 * parent product's name or defaulting to only its first price. A single
 * Stripe product commonly carries multiple price points (e.g. one
 * "Legendary" product with monthly, annual, and one-time prices all attached
 * — the natural dashboard setup), so grouping by product would put the whole
 * product in one bucket and silently drop its other prices.
 *
 * Only prices belonging to a membership-tagged product are considered —
 * `/api/stripe/plans` returns every active product in the catalog (render
 * credits, merch, tips, ...), not just membership ones.
 */
export function selectPlanPrices(plans: StripePlan[]): SelectedPlanPrices {
  const membershipPlans = plans.filter(p => p.metadata?.[MEMBERSHIP_PRODUCT_METADATA_KEY] === "true");
  const allPrices = membershipPlans.flatMap(p => p.prices);
  return {
    monthlyPrice: allPrices.find(p => p.recurring?.interval === "month"),
    annualPrice: allPrices.find(p => p.recurring?.interval === "year"),
    lifetimePrice: allPrices.find(p => !p.recurring),
  };
}
