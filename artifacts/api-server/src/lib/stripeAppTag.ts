/**
 * @purpose The metadata tag every Stripe object this app creates carries, so objects in the shared Stripe account can be told apart from other business.
 * @subsystem payments
 *
 * One Stripe account serves Overhype.me and other business (David, 2026-10-28;
 * decisions.md). The checkout route writes this tag on customers, checkout
 * sessions, lifetime payment intents and subscriptions; the excluded-classes
 * inventory counts only tagged (or userId-carrying) objects as this app's.
 */
export const STRIPE_APP_TAG = { key: "app", value: "overhype" } as const;
