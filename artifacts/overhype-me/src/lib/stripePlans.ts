export interface StripePlanPrice {
  id: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: string; interval_count?: number } | null;
}

export interface StripePlan {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: StripePlanPrice[];
}

/**
 * Product-metadata key that marks a product as conferring Legendary
 * membership. Mirrors MEMBERSHIP_PRODUCT_METADATA_KEY in
 * artifacts/api-server/src/lib/membershipPricing.ts — duplicated here
 * because the frontend can't import backend code. `/stripe/checkout` and
 * `/stripe/subscription/switch-plan` enforce this same allowlist, so any
 * frontend surface that turns `/stripe/plans` into a selectable plan must
 * apply this same filter, or it can offer a plan the grant layer will
 * reject. This is the single frontend copy — every consumer imports it from
 * here rather than re-declaring it, so the pricing page and the subscription
 * switcher can't silently disagree about which products are memberships.
 */
export const MEMBERSHIP_PRODUCT_METADATA_KEY = "overhype_membership";

export function isMembershipProduct(plan: Pick<StripePlan, "metadata">): boolean {
  return plan.metadata?.[MEMBERSHIP_PRODUCT_METADATA_KEY] === "true";
}

export function filterMembershipPlans<T extends Pick<StripePlan, "metadata">>(plans: T[]): T[] {
  return plans.filter(isMembershipProduct);
}
