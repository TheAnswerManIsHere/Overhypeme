/**
 * Single source of truth for "does paying for this grant Legendary?"
 *
 * A Stripe *product* is a membership product iff its metadata carries
 * `overhype_membership = "true"`. The tag lives on the product in the Stripe
 * dashboard — the same screen where its price is created — so the catalog can
 * grow (render credits, merch, tips, cheaper add-ons) without any of those
 * non-membership purchases accidentally minting Legendary.
 *
 * This is a POSITIVE allowlist and every helper here fails CLOSED: anything we
 * cannot positively confirm to be a tagged, non-deleted membership product is
 * treated as NON-membership. The decision is enforced at every grant surface —
 * checkout (early rejection), the synchronous confirm endpoint, and the Stripe
 * webhook — so no single entry point is the only guard. Checkout is not the
 * only door that flips a user to Legendary; the webhook is, which is why the
 * gate has to live at the grant, not merely at checkout.
 */
import type Stripe from "stripe";

/** Product-metadata key that marks a product as conferring Legendary membership. */
export const MEMBERSHIP_PRODUCT_METADATA_KEY = "overhype_membership";

type MaybeProduct = Stripe.Product | Stripe.DeletedProduct | string | null | undefined;

/**
 * Pure check: is `product` a fully-resolved, non-deleted, membership-tagged
 * product? A bare id string (unexpanded) or a deleted product both fail closed,
 * because we cannot see the metadata to positively confirm membership.
 */
export function productGrantsMembership(product: MaybeProduct): boolean {
  if (!product || typeof product === "string") return false;
  if ((product as Stripe.DeletedProduct).deleted) return false;
  return (product as Stripe.Product).metadata?.[MEMBERSHIP_PRODUCT_METADATA_KEY] === "true";
}

/**
 * One-time ("Legendary for Life") payments don't carry the price on the
 * PaymentIntent, so they rely on the membership tag our checkout stamps onto
 * the PI — and checkout only stamps it AFTER verifying the product is a
 * membership product (see routes/stripe.ts). This predicate is that trust
 * check, shared by both the confirm endpoint and the webhook so the rule can't
 * drift between them.
 */
export function paymentIntentIsMembershipTagged(
  metadata: Stripe.Metadata | Record<string, string> | null | undefined,
): boolean {
  return metadata?.["membership"] === "true" || metadata?.["plan"] === "lifetime";
}

/** Resolves a Stripe product by id — injectable so callers/tests avoid live calls. */
export interface ProductResolver {
  retrieveProduct(id: string): Promise<Stripe.Product | Stripe.DeletedProduct>;
}

/**
 * Decide membership for a single price. If the price only carries the product
 * as an id (unexpanded), resolve it via `resolver.retrieveProduct`.
 */
export async function priceGrantsMembership(
  price: Stripe.Price,
  resolver: ProductResolver,
): Promise<boolean> {
  let product: MaybeProduct = price.product;
  if (typeof product === "string") {
    product = await resolver.retrieveProduct(product);
  }
  return productGrantsMembership(product);
}

/**
 * A subscription grants membership iff ANY of its line-item prices resolves to
 * a tagged membership product. Each price's product is resolved on demand (the
 * common case is a single item whose product is already expanded, so no extra
 * Stripe call is made).
 */
export async function subscriptionGrantsMembership(
  sub: Stripe.Subscription,
  resolver: ProductResolver,
): Promise<boolean> {
  const items = sub.items?.data ?? [];
  for (const item of items) {
    const price = item.price as Stripe.Price | undefined;
    if (!price) continue;
    if (await priceGrantsMembership(price, resolver)) return true;
  }
  return false;
}
