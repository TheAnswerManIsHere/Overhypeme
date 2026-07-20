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
 * Shared: does ANY price in the list resolve to a tagged membership product?
 * Each price's product is resolved on demand (the common case is a single item
 * whose product is already expanded, so no extra Stripe call is made).
 */
async function anyPriceGrantsMembership(
  prices: Array<Stripe.Price | null | undefined>,
  resolver: ProductResolver,
): Promise<boolean> {
  for (const price of prices) {
    if (!price) continue;
    if (await priceGrantsMembership(price, resolver)) return true;
  }
  return false;
}

/**
 * A subscription grants membership iff ANY of its line-item prices resolves to
 * a tagged membership product.
 */
export async function subscriptionGrantsMembership(
  sub: Stripe.Subscription,
  resolver: ProductResolver,
): Promise<boolean> {
  return anyPriceGrantsMembership(
    (sub.items?.data ?? []).map((item) => item.price as Stripe.Price | undefined),
    resolver,
  );
}

/**
 * A one-time Checkout Session grants membership iff ANY of its line items
 * resolves to a tagged membership product.
 *
 * This is the AUTHORITATIVE one-time check — it reads the actual purchased
 * product, NOT any metadata stamp on the PaymentIntent. Legacy Checkout
 * Sessions created before the allowlist existed carry `membership=true` on
 * non-membership one-time prices, so trusting that stamp would let a pre-staged
 * session mint Legendary after deploy. Verifying the line item's product closes
 * that window. Expand `line_items.data.price.product` (or list line items with
 * that expand) before calling so the product is resolvable.
 */
export async function checkoutLineItemsGrantMembership(
  lineItems: Array<Stripe.LineItem | null | undefined> | undefined,
  resolver: ProductResolver,
): Promise<boolean> {
  return anyPriceGrantsMembership(
    (lineItems ?? []).map((item) => item?.price as Stripe.Price | undefined),
    resolver,
  );
}
