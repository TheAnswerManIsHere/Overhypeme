import { filterMembershipPlans, type StripePlan } from "@/lib/stripePlans";

export type { StripePlan, StripePlanPrice } from "@/lib/stripePlans";

export interface SelectedPlanPrices {
  monthlyPrice?: StripePlan["prices"][number];
  annualPrice?: StripePlan["prices"][number];
  lifetimePrice?: StripePlan["prices"][number];
}

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
  const allPrices = filterMembershipPlans(plans).flatMap(p => p.prices);
  return {
    monthlyPrice: allPrices.find(p => p.recurring?.interval === "month"),
    annualPrice: allPrices.find(p => p.recurring?.interval === "year"),
    lifetimePrice: allPrices.find(p => !p.recurring),
  };
}
