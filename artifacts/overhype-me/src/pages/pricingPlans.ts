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
 * Classify Stripe's active prices into the three plan slots the pricing page
 * shows, by each PRICE's own `recurring` field — not by guessing from the
 * parent product's name or defaulting to only its first price. A single
 * Stripe product commonly carries multiple price points (e.g. one
 * "Legendary" product with monthly, annual, and one-time prices all attached
 * — the natural dashboard setup), so grouping by product would put the whole
 * product in one bucket and silently drop its other prices.
 */
export function selectPlanPrices(plans: StripePlan[]): SelectedPlanPrices {
  const allPrices = plans.flatMap(p => p.prices);
  return {
    monthlyPrice: allPrices.find(p => p.recurring?.interval === "month"),
    annualPrice: allPrices.find(p => p.recurring?.interval === "year"),
    lifetimePrice: allPrices.find(p => !p.recurring),
  };
}
