/**
 * Operator-provisioned Stripe webhook endpoints with environment-only secrets
 * (launch Phase 15, increment 4; the plan's C2).
 *
 * Two invariants, each held against the real thing it protects:
 *
 *   1. With no configured signing secret, verification REFUSES — even when the
 *      library's managed-webhook row holds a secret that would verify the
 *      delivery. Run against the real `stripe-replit-sync` instance and the
 *      real `stripe._managed_webhooks` table, because the fallback being closed
 *      lives in the library (`processWebhook` reads that row when its config
 *      has no secret).
 *   2. Start-up only READS the operator's endpoint: a missing, disabled,
 *      misdirected or under-subscribed endpoint is reported as the mode not set
 *      up, and nothing is created — checked on the fake account, whose endpoint
 *      store would show a creation.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { StripeSync, runMigrations } from "stripe-replit-sync";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import { StripeWebhookSecretNotConfiguredError, refuseWithoutWebhookSecret } from "../lib/stripeClient.js";
import { checkOperatorWebhookEndpoint, type WebhookEndpointCheckInput } from "../lib/stripeWebhookEndpoint.js";
import {
  FAKE_SECRET_KEY,
  FAKE_WEBHOOK_ENDPOINT_ID,
  __forgetFakeWebhookEndpointsForTests,
  __setFakeOperatorWebhookEndpointForTests,
  fakeStripeDriver,
} from "../lib/stripeFakeDriver.js";
import { realStripeDriver } from "../lib/stripeRealDriver.js";
import { getSiteBaseUrl } from "../lib/siteUrl.js";

const ACCOUNT = `acct_whsec_${randomUUID().slice(0, 8)}`;
const ROW_SECRET = "whsec_managed_row_must_not_verify";
const CONFIGURED_SECRET = "whsec_configured_in_environment";
const built: StripeSync[] = [];

function newSync(webhookSecret: string | null): StripeSync {
  const sync = new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL!, max: 1 },
    stripeSecretKey: "sk_test_whsec_never_sent",
    ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
  });
  // The account the library resolves, without an API round-trip.
  (sync as unknown as { cachedAccount: { id: string } }).cachedAccount = { id: ACCOUNT };
  built.push(sync);
  return sync;
}

function signedDelivery(secret: string): { payload: Buffer; signature: string } {
  // A type the library has no handler for, so a delivery that verifies is
  // ignored by the mirror rather than written anywhere.
  const payload = JSON.stringify({
    id: `evt_whsec_${randomUUID().slice(0, 8)}`,
    object: "event",
    type: "whsec_test.unhandled",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: "whsec_test" } },
  });
  const signature = new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret });
  return { payload: Buffer.from(payload), signature };
}

describe("verification without a configured secret", () => {
  before(async () => {
    await runMigrations({ databaseUrl: process.env.DATABASE_URL! });
    // What an earlier boot's findOrCreateManagedWebhook left behind: a managed
    // row for the account whose secret signs today's deliveries. Written by the
    // library's own upsert, so the row has exactly the library's shape.
    await db.execute(sql`INSERT INTO stripe.accounts (_raw_data) VALUES (${JSON.stringify({ id: ACCOUNT, object: "account" })}::jsonb) ON CONFLICT DO NOTHING`);
    const writer = newSync(null) as unknown as { upsertManagedWebhooks: (rows: unknown[], accountId: string) => Promise<unknown> };
    await writer.upsertManagedWebhooks([{
      id: `we_${ACCOUNT}`, object: "webhook_endpoint", url: "https://example.test/api/stripe/webhook", secret: ROW_SECRET,
      status: "enabled", enabled_events: ["*"], livemode: false, metadata: {}, created: 0, api_version: null,
      application: null, description: null,
    }], ACCOUNT);
  });

  after(async () => {
    await db.execute(sql`DELETE FROM stripe._managed_webhooks WHERE account_id = ${ACCOUNT}`);
    await db.execute(sql`DELETE FROM stripe.accounts WHERE id = ${ACCOUNT}`);
    for (const s of built) {
      await (s as unknown as { postgresClient: { pool: { end: () => Promise<void> } } }).postgresClient.pool.end();
    }
  });

  it("the unguarded library DOES fall back to the managed row (the path being closed, measured)", async () => {
    const { payload, signature } = signedDelivery(ROW_SECRET);
    await newSync(null).processWebhook(payload, signature);
  });

  it("refuses when no secret is configured, even though the managed row holds one that verifies", async () => {
    const sync = refuseWithoutWebhookSecret(newSync(null), null, "STRIPE_WEBHOOK_SECRET_TEST");
    const { payload, signature } = signedDelivery(ROW_SECRET);
    await assert.rejects(
      sync.processWebhook(payload, signature),
      (err: unknown) =>
        err instanceof StripeWebhookSecretNotConfiguredError &&
        err.setting === "STRIPE_WEBHOOK_SECRET_TEST" &&
        /secret/i.test(err.message) && !/signature/i.test(err.message),
    );
  });

  it("with a configured secret, that secret verifies and the managed row's does not", async () => {
    const sync = refuseWithoutWebhookSecret(newSync(CONFIGURED_SECRET), CONFIGURED_SECRET, "STRIPE_WEBHOOK_SECRET_TEST");
    const good = signedDelivery(CONFIGURED_SECRET);
    await sync.processWebhook(good.payload, good.signature);

    const stale = signedDelivery(ROW_SECRET);
    await assert.rejects(sync.processWebhook(stale.payload, stale.signature), (err: unknown) => err instanceof Stripe.errors.StripeSignatureVerificationError);
  });

  it("the real driver reads no fallback: an empty setting is not configured", () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET_TEST;
    try {
      process.env.STRIPE_WEBHOOK_SECRET_TEST = "";
      assert.equal(realStripeDriver.webhookSecret(false), null);
    } finally {
      if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET_TEST;
      else process.env.STRIPE_WEBHOOK_SECRET_TEST = saved;
    }
  });
});

describe("the start-up check reads the operator's endpoint and creates none", () => {
  const url = () => `${getSiteBaseUrl()}/api/stripe/webhook`;
  const client = () => fakeStripeDriver.createClient(FAKE_SECRET_KEY);
  const input = (over: Partial<WebhookEndpointCheckInput> = {}): WebhookEndpointCheckInput => ({
    stripe: client(),
    url: url(),
    secretConfigured: true,
    endpointId: FAKE_WEBHOOK_ENDPOINT_ID,
    settings: realStripeDriver.settingNames(false),
    requiredEvents: ["charge.refunded", "customer.subscription.updated"],
    ...over,
  });
  /** Endpoints the fake account holds beyond the operator's: a creation would show here. */
  async function createdEndpoints(): Promise<number> {
    const listed = await (client() as unknown as { webhookEndpoints: { list: () => Promise<{ data: unknown[] }> } })
      .webhookEndpoints.list();
    return listed.data.length;
  }

  afterEach(() => __forgetFakeWebhookEndpointsForTests());

  it("an enabled endpoint at this URL, subscribed to everything, is set up", async () => {
    assert.deepEqual(await checkOperatorWebhookEndpoint(input()), { ok: true, endpointId: FAKE_WEBHOOK_ENDPOINT_ID });
  });

  const cases: Array<[string, () => void, Partial<WebhookEndpointCheckInput>, string, RegExp]> = [
    ["no configured secret", () => {}, { secretConfigured: false }, "secret_not_configured", /STRIPE_WEBHOOK_SECRET_TEST/],
    ["no named endpoint", () => {}, { endpointId: null }, "endpoint_not_named", /STRIPE_WEBHOOK_ENDPOINT_ID_TEST/],
    ["a missing endpoint", () => __setFakeOperatorWebhookEndpointForTests("missing"), {}, "endpoint_not_found", /does not exist/],
    ["a disabled endpoint", () => __setFakeOperatorWebhookEndpointForTests({ status: "disabled" }), {}, "endpoint_disabled", /is disabled in Stripe/],
    ["an endpoint delivering elsewhere", () => __setFakeOperatorWebhookEndpointForTests({ url: "https://elsewhere.example/api/stripe/webhook" }), {}, "endpoint_url_mismatch", /elsewhere\.example/],
    ["an endpoint missing an event type", () => __setFakeOperatorWebhookEndpointForTests({ enabled_events: ["charge.refunded"] }), {}, "endpoint_events_missing", /customer\.subscription\.updated/],
  ];
  for (const [name, arrange, over, problem, detail] of cases) {
    it(`${name} is reported as not set up, and nothing is created`, async () => {
      arrange();
      const check = await checkOperatorWebhookEndpoint(input(over));
      assert.equal(check.ok, false);
      assert.equal(!check.ok && check.problem, problem);
      assert.match(!check.ok ? check.detail : "", detail);
      assert.equal(await createdEndpoints(), 0, "the check must create no endpoint");
    });
  }

  it("Stripe not answering is a throw (retried as transient), not a configuration answer", async () => {
    const failing = { webhookEndpoints: { retrieve: () => Promise.reject(Object.assign(new Error("connection reset"), { statusCode: 500 })) } };
    await assert.rejects(
      checkOperatorWebhookEndpoint(input({ stripe: failing as unknown as WebhookEndpointCheckInput["stripe"] })),
      /connection reset/,
    );
  });
});
