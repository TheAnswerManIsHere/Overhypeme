/**
 * The read-only start-up check of the operator's Stripe webhook endpoint
 * (launch Phase 15, increment 4).
 *
 * Start-up used to call the library's `findOrCreateManagedWebhook`, which
 * creates an endpoint when it finds none, deletes and recreates a disabled one,
 * deletes any it considers orphaned, and stores the new endpoint's signing
 * secret in `stripe._managed_webhooks`. So a boot could replace an endpoint, and
 * verification could carry on against a secret only the database knew. Now the
 * operator provisions one endpoint per deployed environment and Stripe mode, in
 * Stripe's dashboard, and names it to the server by two settings: the endpoint's
 * id and its signing secret. Start-up READS that endpoint and says what is wrong
 * with it; it never creates, enables or replaces one.
 *
 * A configuration problem is an answer (`ok: false`), not a throw. A throw is
 * reserved for Stripe not answering, which the caller retries like any other
 * transient setup failure.
 */
import type Stripe from "stripe";
import { isStripeResourceMissing, type StripeApi } from "./stripeApi.js";

export type WebhookEndpointProblem =
  | "secret_not_configured"
  | "endpoint_not_named"
  | "endpoint_not_found"
  | "endpoint_disabled"
  | "endpoint_url_mismatch"
  | "endpoint_events_missing";

export type WebhookEndpointCheck =
  | { ok: true; endpointId: string }
  | { ok: false; problem: WebhookEndpointProblem; detail: string };

export interface WebhookEndpointCheckInput {
  /** This mode's Stripe client, already verified to be the declared account. */
  stripe: Pick<StripeApi, "webhookEndpoints">;
  /** The URL Stripe must deliver to: this server's own webhook route. */
  url: string;
  /** Whether a signing secret is configured for this mode (never the value). */
  secretConfigured: boolean;
  /** The configured endpoint id, or null. */
  endpointId: string | null;
  /** The settings' names, for the operator-facing detail. */
  settings: { webhookSecret: string; webhookEndpoint: string };
  /** The event types the product processes; the endpoint must deliver all of them. */
  requiredEvents: readonly string[];
}

export async function checkOperatorWebhookEndpoint(input: WebhookEndpointCheckInput): Promise<WebhookEndpointCheck> {
  const { stripe, url, settings } = input;
  if (!input.secretConfigured) {
    return {
      ok: false,
      problem: "secret_not_configured",
      detail: `no webhook signing secret is configured (${settings.webhookSecret}), so every delivery is refused`,
    };
  }
  if (!input.endpointId) {
    return {
      ok: false,
      problem: "endpoint_not_named",
      detail: `no webhook endpoint is named (${settings.webhookEndpoint})`,
    };
  }

  let endpoint: Stripe.WebhookEndpoint;
  try {
    endpoint = await stripe.webhookEndpoints.retrieve(input.endpointId);
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      return {
        ok: false,
        problem: "endpoint_not_found",
        detail: `the webhook endpoint named in ${settings.webhookEndpoint} does not exist on this Stripe account`,
      };
    }
    throw err;
  }

  if (endpoint.status !== "enabled") {
    return {
      ok: false,
      problem: "endpoint_disabled",
      detail: `the webhook endpoint named in ${settings.webhookEndpoint} is ${endpoint.status} in Stripe; re-enable it in Stripe's dashboard`,
    };
  }
  if (endpoint.url !== url) {
    return {
      ok: false,
      problem: "endpoint_url_mismatch",
      detail: `the webhook endpoint named in ${settings.webhookEndpoint} delivers to ${endpoint.url}, not to this server's ${url}`,
    };
  }
  const subscribed = new Set(endpoint.enabled_events);
  const missing = subscribed.has("*") ? [] : input.requiredEvents.filter((type) => !subscribed.has(type));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: "endpoint_events_missing",
      detail: `the webhook endpoint named in ${settings.webhookEndpoint} is not subscribed to ${missing.length} event type(s) the product processes: ${missing.join(", ")}`,
    };
  }
  return { ok: true, endpointId: endpoint.id };
}
