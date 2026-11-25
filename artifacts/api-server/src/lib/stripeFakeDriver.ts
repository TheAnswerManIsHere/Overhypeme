/**
 * The fake Stripe driver (#566, plan `docs/plans/PLAN_STRIPE_FAKE.md`).
 *
 * A credential-free Stripe for CI and local runs: the read path — account
 * verification, managed-webhook registration, backfill into the `stripe.*`
 * mirror, the catalog — works against a small fixed catalog, and nothing here
 * can reach a real Stripe account.
 *
 * Why it is safe by construction rather than by configuration:
 *
 *   - It holds no credential. Its "keys" are fixed placeholders, and selecting
 *     it with any real Stripe key in the environment refuses to boot
 *     (`doubleSelection.ts`, the `STRIPE_BACKEND` row).
 *   - It never imports the real driver or `stripeRawClient.ts`, so there is no
 *     code path from here to an environment credential or the live SDK client.
 *     (Checked by a test of this module's import closure.)
 *   - The sync library's own SDK client is built with the placeholder key and
 *     replaced by this fake before the build is returned. Were the swap ever
 *     missed, the placeholder reaches no account.
 *   - It runs only on a database created for it (`stripeDatabasePartition.ts`).
 *
 * What it does, by kind of call (plan decision 11):
 *
 *   - catalog reads → the fixture in `stripeFakeFixture.ts`;
 *   - list reads of resources it does not model → empty, which is true of an
 *     account with no customers;
 *   - webhook endpoints → held in memory. Retrieving one it does not hold answers
 *     `resource_missing` (404), as Stripe does — the response the sync library
 *     treats as "recreate", so a restart re-registers instead of failing setup;
 *   - payment mutations → `StripeFakeUnsupportedError`, never a fabricated
 *     success. Money moving is the event-channel increment;
 *   - any member it does not implement at all → `StripeFakeUnsupportedError`
 *     naming the member, which is how a library upgrade that calls something new
 *     fails loudly instead of quietly.
 *
 * Test mode only: live mode is "unconfigured", so the existing toggle refusal
 * applies (plan decision 8).
 */
import type Stripe from "stripe";
import type { StripeApi } from "./stripeApi.js";
import type { StripeDriver } from "./stripeDriverTypes.js";
import { StripeFakeUnsupportedError } from "./stripeFakeErrors.js";
import { FAKE_ACCOUNT_ID, FAKE_PRICES, FAKE_PRODUCTS } from "./stripeFakeFixture.js";
import { getSiteBaseUrl } from "./siteUrl.js";

/** A placeholder, not a credential: it identifies the fake and reaches no account. */
export const FAKE_SECRET_KEY = "sk_test_fake_double_reaches_no_account";
const FAKE_PUBLISHABLE_KEY = "pk_test_fake_double";
/** The fake's configured webhook signing secret: a placeholder, like the key. */
export const FAKE_WEBHOOK_SECRET = "whsec_fake_double_placeholder";
/** The endpoint the fake account's "operator" provisioned, named as an operator names theirs. */
export const FAKE_WEBHOOK_ENDPOINT_ID = "we_fake_operator_provisioned";

const NEXT_INCREMENT = "payment flows on the fake arrive with the event-channel increment (#566 next)";

// ── Response shapes ─────────────────────────────────────────────────────────

function respond<T>(value: T): Promise<Stripe.Response<T>> {
  return Promise.resolve(value as Stripe.Response<T>);
}

/** Stripe's `resource_missing`, with the fields the sync library inspects. */
function resourceMissing(kind: string, id: string): Error {
  return Object.assign(new Error(`No such ${kind}: '${id}'`), {
    type: "StripeInvalidRequestError",
    rawType: "invalid_request_error",
    statusCode: 404,
    code: "resource_missing",
  });
}

function refuse(member: string): Promise<never> {
  return Promise.reject(new StripeFakeUnsupportedError(member, NEXT_INCREMENT));
}

/**
 * Stripe's list result: awaitable for one page, and async-iterable over every
 * item (the sync library consumes lists with `for await`).
 */
function list<T extends { id: string }>(items: readonly T[], params?: unknown): Stripe.ApiListPromise<T> {
  // `params` is whatever the caller passed first — list params or, in the
  // SDK's other overload, request options — so only pagination is read from it.
  const p = (params ?? {}) as { limit?: unknown; starting_after?: unknown };
  const after = typeof p.starting_after === "string" ? p.starting_after : undefined;
  const from = after ? items.findIndex((i) => i.id === after) + 1 : 0;
  const limit = typeof p.limit === "number" ? p.limit : 10;
  const page = items.slice(from, from + limit);
  const result = { object: "list", data: page, has_more: from + limit < items.length, url: "/v1/fake" };
  const rest = items.slice(from)[Symbol.iterator]();
  const iterator = {
    next: async () => rest.next(),
    [Symbol.asyncIterator]() {
      return this;
    },
    autoPagingEach: async (onItem: (item: T) => unknown) => {
      for (const item of items.slice(from)) if ((await onItem(item)) === false) break;
    },
    autoPagingToArray: async (opts: { limit: number }) => items.slice(from, from + opts.limit),
  };
  return Object.assign(Promise.resolve(result), iterator) as unknown as Stripe.ApiListPromise<T>;
}

/** An empty list of `T` — true of an account with no customers, invoices or charges. */
const empty = <T extends { id: string }>(params?: unknown) => list<T>([], params);

/** A retrieve for a resource the fake holds none of: Stripe's own 404. */
const noneById = (kind: string) => (id: string) => Promise.reject(resourceMissing(kind, id));

// ── State ───────────────────────────────────────────────────────────────────

/**
 * The endpoint an operator provisioned on the fake account, as one is on a real
 * account: enabled, at this server's own webhook URL, subscribed to every event.
 * The fake holds no other endpoint and implements only `retrieve`: nothing in
 * this application creates, replaces or deletes one, so any attempt reaches the
 * fake's refusal by name. A test reshapes it (disabled, elsewhere, gone)
 * through `__setFakeOperatorWebhookEndpointForTests`, and `null` restores it.
 */
type OperatorEndpointOverride = Partial<Pick<Stripe.WebhookEndpoint, "status" | "url" | "enabled_events">> | "missing" | null;
let operatorEndpointOverride: OperatorEndpointOverride = null;
export function __setFakeOperatorWebhookEndpointForTests(next: OperatorEndpointOverride): void {
  operatorEndpointOverride = next;
}

function operatorEndpoint(): Stripe.WebhookEndpoint | null {
  if (operatorEndpointOverride === "missing") return null;
  return {
    id: FAKE_WEBHOOK_ENDPOINT_ID,
    object: "webhook_endpoint",
    api_version: null,
    application: null,
    created: 0,
    description: "Provisioned by the operator",
    enabled_events: ["*"],
    livemode: false,
    metadata: {},
    status: "enabled",
    url: `${getSiteBaseUrl()}/api/stripe/webhook`,
    ...(operatorEndpointOverride ?? {}),
  } as Stripe.WebhookEndpoint;
}

function retrieveWebhookEndpoint(id: string): Promise<Stripe.Response<Stripe.WebhookEndpoint>> {
  const found = id === FAKE_WEBHOOK_ENDPOINT_ID ? operatorEndpoint() : null;
  return found ? respond(found) : Promise.reject(resourceMissing("webhook_endpoint", id));
}

/**
 * Events the fake account holds, newest first, as Stripe lists them. Empty
 * unless a test seeds some: the event channel itself is a later increment.
 */
let fakeEvents: Stripe.Event[] = [];
export function __setFakeStripeEventsForTests(events: readonly Stripe.Event[]): void {
  fakeEvents = [...events].sort((a, b) => b.created - a.created);
}

function listEvents(params?: unknown): Stripe.ApiListPromise<Stripe.Event> {
  const created = ((params ?? {}) as { created?: { gte?: number; lte?: number } }).created ?? {};
  const inRange = fakeEvents.filter((e) =>
    (created.gte === undefined || e.created >= created.gte) && (created.lte === undefined || e.created <= created.lte));
  return list(inRange, params);
}

function findById<T extends { id: string }>(items: readonly T[], kind: string, id: string): Promise<Stripe.Response<T>> {
  const found = items.find((i) => i.id === id);
  return found ? respond(found) : Promise.reject(resourceMissing(kind, id));
}

const account = {
  id: FAKE_ACCOUNT_ID,
  object: "account",
  business_profile: { name: "Fake Stripe account (fixture)" },
  charges_enabled: false,
  country: "US",
  created: 1767225600,
  default_currency: "usd",
  details_submitted: true,
  email: null,
  metadata: {},
  payouts_enabled: false,
  type: "standard",
} as unknown as Stripe.Account;

// ── The application contract ────────────────────────────────────────────────

/**
 * Typed as `StripeApi`, so adding a member to that contract is a type error
 * here until the fake implements it — the drift guard's second half.
 */
const appSurface: StripeApi = {
  accounts: { retrieve: () => respond(account) },
  billingPortal: { sessions: { create: () => refuse("billingPortal.sessions.create") } },
  charges: {
    list: empty<Stripe.Charge>,
    retrieve: noneById("charge"),
  },
  checkout: {
    sessions: {
      create: () => refuse("checkout.sessions.create"),
      list: empty<Stripe.Checkout.Session>,
      listLineItems: (_id: string, params?: unknown) => empty<Stripe.LineItem>(params),
      retrieve: noneById("checkout.session"),
    },
  },
  customers: {
    create: () => refuse("customers.create"),
    retrieve: noneById("customer"),
  },
  disputes: { retrieve: noneById("dispute") },
  events: { list: listEvents, retrieve: (id: string) => findById(fakeEvents, "event", id) },
  invoicePayments: {
    list: empty<Stripe.InvoicePayment>,
  },
  invoices: {
    createPreview: () => refuse("invoices.createPreview"),
    list: empty<Stripe.Invoice>,
    retrieve: noneById("invoice"),
  },
  paymentIntents: { retrieve: noneById("payment_intent") },
  prices: { retrieve: (id: string) => findById(FAKE_PRICES, "price", id) },
  products: { retrieve: (id: string) => findById(FAKE_PRODUCTS, "product", id) },
  subscriptionItems: {
    list: empty<Stripe.SubscriptionItem>,
  },
  subscriptions: {
    cancel: () => refuse("subscriptions.cancel"),
    retrieve: noneById("subscription"),
    update: () => refuse("subscriptions.update"),
  },
  webhookEndpoints: { retrieve: retrieveWebhookEndpoint },
};

// ── What the sync library calls on its read path ────────────────────────────

/**
 * Outside the compiler's reach (the library is compiled JS), so held only to
 * what the boot sequence and backfill exercise; anything else refuses by name.
 */
const librarySurface = {
  products: { list: (params?: unknown) => list(FAKE_PRODUCTS, params) },
  prices: { list: (params?: unknown) => list(FAKE_PRICES, params) },
  plans: { list: empty },
  customers: { list: empty },
  subscriptions: { list: empty },
  subscriptionSchedules: { list: empty },
  setupIntents: { list: empty },
  paymentMethods: { list: empty },
  paymentIntents: { list: empty },
  taxIds: { list: empty },
  creditNotes: { list: empty },
  disputes: { list: empty },
  refunds: { list: empty },
  radar: { earlyFraudWarnings: { list: empty } },
};

// ── Assembly ────────────────────────────────────────────────────────────────

type Surface = { [key: string]: unknown };

function merge(a: Surface, b: Surface): Surface {
  const out: Surface = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key];
    out[key] =
      existing && typeof existing === "object" && value && typeof value === "object"
        ? merge(existing as Surface, value as Surface)
        : value;
  }
  return out;
}

/** Properties a runtime probes without meaning to call Stripe; answering them `undefined` is not a refusal. */
const INTROSPECTION = new Set(["then", "toJSON", "constructor", "inspect", "asymmetricMatch", "$$typeof"]);

/**
 * A member the fake does not have: calling it refuses by name, and so does
 * anything reached through it — `webhooks.constructEventAsync` refuses as that,
 * not as a TypeError about `undefined`.
 */
function missing(name: string): unknown {
  return new Proxy(() => {}, {
    apply: () => refuse(name),
    get: (_fn, prop) =>
      typeof prop === "symbol" || INTROSPECTION.has(prop) ? undefined : missing(`${name}.${prop}`),
  });
}

/** Refuse, by dotted name, any member the fake does not implement — at any depth. */
function guarded(target: Surface, path: string): Surface {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol" || INTROSPECTION.has(prop)) return Reflect.get(obj, prop);
      const name = path ? `${path}.${prop}` : prop;
      if (!(prop in obj)) return missing(name);
      const value = obj[prop];
      return value && typeof value === "object" ? guarded(value as Surface, name) : value;
    },
  });
}

const fakeClient = guarded(merge(appSurface as unknown as Surface, librarySurface), "") as unknown as StripeApi;

// ── The driver ──────────────────────────────────────────────────────────────

function testModeOnly(liveMode: boolean): void {
  if (liveMode) {
    throw new Error(
      "Stripe credentials not configured — the fake Stripe driver is test-mode only (active mode: live).",
    );
  }
}

export const fakeStripeDriver: StripeDriver = {
  kind: "fake",

  settingNames() {
    return {
      secret: "the fake Stripe driver's placeholder key",
      publishable: "the fake Stripe driver's placeholder key",
      account: "the fake Stripe account",
      webhookSecret: "the fake Stripe driver's placeholder webhook secret",
      webhookEndpoint: "the fake account's operator-provisioned endpoint",
    };
  },

  configuredSecretKey(liveMode) {
    return liveMode ? undefined : FAKE_SECRET_KEY;
  },

  credentials(liveMode) {
    testModeOnly(liveMode);
    return { secretKey: FAKE_SECRET_KEY, publishableKey: FAKE_PUBLISHABLE_KEY };
  },

  webhookSecret(liveMode) {
    return liveMode ? null : FAKE_WEBHOOK_SECRET;
  },

  webhookEndpointId(liveMode) {
    return liveMode ? null : FAKE_WEBHOOK_ENDPOINT_ID;
  },

  expectedAccountId(liveMode) {
    return liveMode ? undefined : FAKE_ACCOUNT_ID;
  },

  createClient(secretKey) {
    // Only ever its own placeholder: a fake that was somehow handed a real key
    // refuses rather than pretending that key belongs to the fake account.
    if (secretKey !== FAKE_SECRET_KEY) {
      throw new StripeFakeUnsupportedError("createClient", "the fake driver accepts only its own placeholder key");
    }
    return fakeClient;
  },

  async buildSync({ secretKey, webhookSecret }) {
    if (secretKey !== FAKE_SECRET_KEY) {
      throw new StripeFakeUnsupportedError("buildSync", "the fake driver accepts only its own placeholder key");
    }
    const { StripeSync } = await import("stripe-replit-sync");
    const sync = new StripeSync({
      poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
      stripeSecretKey: secretKey,
      ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
    });
    // The library builds its own SDK client in its constructor, with no way to
    // inject one; it keeps it in a public `stripe` field that every later call
    // reads. Replacing it here, before the build is returned, means no call the
    // library makes can reach the network (plan decision 9).
    (sync as unknown as { stripe: unknown }).stripe = fakeClient;
    return sync;
  },

  credentialPresence() {
    return {
      secretKeyTest: true,
      secretKeyLive: false,
      publishableKeyTest: true,
      publishableKeyLive: false,
      webhookSecretTest: true,
      webhookSecretLive: false,
      webhookEndpointTest: true,
      webhookEndpointLive: false,
    };
  },
};
