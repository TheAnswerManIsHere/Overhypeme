import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SubscriptionPanel } from "@/components/SubscriptionPanel";

/**
 * Regression coverage for the Membership card's subscription controls.
 *
 * The bug: the controls block — "Switch to Annual" AND "Cancel Subscription" —
 * was gated on `subscription`, the row mirrored out of Stripe by the sync
 * library. That mirror is populated by the Stripe webhook, so it is EMPTY for
 * the first minutes of every new subscription, while `appSubscription` (our own
 * entitlement row) is written synchronously at checkout verification. A monthly
 * subscriber who had just paid therefore saw no way to switch plans and no way
 * to cancel, on a card that otherwise rendered their renewal date correctly.
 *
 * The app DB is the authority here; the mirror is a lagging cache.
 */

const MONTHLY_PRICE_ID = "price_monthly_test";
const ANNUAL_PRICE_ID = "price_annual_test";

/** Shaped after the real /api/stripe/plans payload: separate membership
 *  products for monthly and annual, each tagged with the membership key. */
const PLANS = [
  {
    id: "prod_monthly",
    name: "Legendary Monthly",
    description: null,
    metadata: { membership: "true", overhype_membership: "true" },
    prices: [
      {
        id: MONTHLY_PRICE_ID,
        unit_amount: 399,
        currency: "usd",
        recurring: { interval: "month", interval_count: 1 },
      },
    ],
  },
  {
    id: "prod_annual",
    name: "Legendary Annual",
    description: null,
    metadata: { membership: "true", overhype_membership: "true" },
    prices: [
      {
        id: ANNUAL_PRICE_ID,
        unit_amount: 2499,
        currency: "usd",
        recurring: { interval: "year", interval_count: 1 },
      },
    ],
  },
];

const ACTIVE_MONTHLY_APP_SUB = {
  id: 1,
  userId: "user_1",
  stripeSubscriptionId: "sub_test",
  plan: "monthly",
  status: "active",
  currentPeriodEnd: "2026-09-29T04:10:05.000Z",
  cancelAtPeriodEnd: false,
};

/** The mirrored Stripe row, once the webhook has synced it. */
const MIRRORED_MONTHLY_SUB = {
  id: "sub_test",
  status: "active",
  current_period_end: 1790654400,
  cancel_at_period_end: false,
  items: {
    data: [
      {
        price: {
          id: MONTHLY_PRICE_ID,
          unit_amount: 399,
          recurring: { interval: "month" },
        },
      },
    ],
  },
};

function mockFetch(subscriptionResponse: unknown, history: unknown[] = []) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/stripe/subscription")
      ? subscriptionResponse
      : url.includes("/api/stripe/payment-history")
        ? { history }
        : url.includes("/api/stripe/plans")
          ? { plans: PLANS }
          : {};
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
}

function renderPanel() {
  const { hook } = memoryLocation({ path: "/profile" });
  return render(
    <Router hook={hook}>
      <SubscriptionPanel />
    </Router>,
  );
}

describe("SubscriptionPanel subscription controls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("offers Switch to Annual and Cancel while the Stripe mirror has not synced the subscription yet", async () => {
    // subscription: null is exactly what GET /stripe/subscription returns when
    // the webhook has not yet written the row into stripe.subscriptions.
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: ACTIVE_MONTHLY_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    expect(await screen.findByRole("button", { name: /Switch to Annual/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel Subscription/i })).toBeTruthy();
  });

  it("still offers both controls once the mirror has caught up", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ACTIVE_MONTHLY_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    expect(await screen.findByRole("button", { name: /Switch to Annual/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel Subscription/i })).toBeTruthy();
  });

  it("offers no recurring-subscription controls to a Legendary for Life member", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: null,
        membershipTier: "legendary",
        isLifetime: true,
      }),
    );

    renderPanel();

    // Wait for the panel to leave its loading state before asserting absence.
    await screen.findByRole("button", { name: /Manage billing/i });
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel Subscription/i })).toBeNull();
  });

  it("offers no recurring-subscription controls to a non-member", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: null,
        membershipTier: "registered",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Go Legendary/i });
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel Subscription/i })).toBeNull();
  });

  it("hides the controls block when the subscription is already set to cancel at period end", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: { ...ACTIVE_MONTHLY_APP_SUB, cancelAtPeriodEnd: true },
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Manage billing/i });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Cancel Subscription/i })).toBeNull();
  });
});

/** After a successful monthly -> annual switch, before the Stripe webhook has
 *  synced. The app DB says annual; the mirror still describes the old monthly
 *  price. This is the #601 state. */
const ANNUAL_APP_SUB = {
  ...ACTIVE_MONTHLY_APP_SUB,
  plan: "annual",
  currentPeriodEnd: "2027-08-29T04:46:17.000Z",
};

/** The mirrored Stripe row once the webhook has caught up to annual. */
const MIRRORED_ANNUAL_SUB = {
  ...MIRRORED_MONTHLY_SUB,
  items: {
    data: [
      {
        price: {
          id: ANNUAL_PRICE_ID,
          unit_amount: 2499,
          recurring: { interval: "year" },
        },
      },
    ],
  },
};

describe("SubscriptionPanel after a plan switch the mirror has not caught up to", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the annual plan from the app DB while the mirror still says monthly", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ANNUAL_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    // The card must not re-offer a switch the user has already paid for.
    await screen.findByRole("button", { name: /Cancel Subscription/i });
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
  });

  it("shows the annual renewal date from the app DB, not the mirror's monthly one", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ANNUAL_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Cancel Subscription/i });
    // App DB: 2027-08-29 (a year out). Mirror: 2026-09-29 (the old monthly
    // period). "Annual" above next month's date is the #602 round-1 defect.
    expect(screen.getByText(/August 2\d, 2027/)).toBeTruthy();
    expect(screen.queryByText(/September 2\d, 2026/)).toBeNull();
  });

  it("suppresses the charged amount rather than showing the pre-switch price", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ANNUAL_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Cancel Subscription/i });
    // $3.99/month is the stale mirror amount. Showing it next to an Annual plan
    // label would read as authoritative and be wrong.
    expect(screen.queryByText(/\$3\.99/)).toBeNull();
  });

  it("shows the annual amount once the mirror agrees", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_ANNUAL_SUB,
        appSubscription: ANNUAL_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Cancel Subscription/i });
    expect(screen.getByText(/\$24\.99/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
  });

  it("still shows the monthly amount and the switch button when both agree", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ACTIVE_MONTHLY_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    expect(await screen.findByRole("button", { name: /Switch to Annual/i })).toBeTruthy();
    expect(screen.getByText(/\$3\.99/)).toBeTruthy();
  });

  it("falls back to the mirror interval when the app DB has no plan", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: { ...ACTIVE_MONTHLY_APP_SUB, plan: "" },
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    // With nothing authoritative to say otherwise, the mirror is still the best
    // available answer -- the fix inverts precedence, it does not drop the mirror.
    expect(await screen.findByRole("button", { name: /Switch to Annual/i })).toBeTruthy();
  });
});

/** A renewal date at local noon on 2026-09-29, serialized to ISO. Built from
 *  local time, so the card formats it as September 29 whatever timezone the
 *  suite runs under (a fixed UTC instant reads as September 30 from UTC+12). */
const MIDDAY_APP_SUB = { ...ACTIVE_MONTHLY_APP_SUB, currentPeriodEnd: new Date(2026, 8, 29, 12).toISOString() };

describe("SubscriptionPanel card text the UAT steps name", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists purchase, refund and dispute entries with their labels in the profile payment history", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        {
          subscription: MIRRORED_MONTHLY_SUB,
          appSubscription: ACTIVE_MONTHLY_APP_SUB,
          membershipTier: "legendary",
          isLifetime: false,
        },
        [
          { id: 1, event: "lifetime_purchase", plan: "lifetime", amount: 9900, currency: "usd", createdAt: "2026-08-01T12:00:00.000Z" },
          { id: 2, event: "refund", plan: null, amount: 399, currency: "usd", createdAt: "2026-08-02T12:00:00.000Z" },
          { id: 3, event: "dispute_opened", plan: null, amount: 399, currency: "usd", createdAt: "2026-08-03T12:00:00.000Z" },
        ],
      ),
    );

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Payment History \(3\)/ }));
    expect(screen.getByText("Legendary for Life Purchase")).toBeTruthy();
    expect(screen.getByText("Refund")).toBeTruthy();
    expect(screen.getByText("Dispute Opened")).toBeTruthy();
  });

  it("names a Legendary for Life member's card as Legendary for Life and shows no Reactivate Subscription button", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: null,
        membershipTier: "legendary",
        isLifetime: true,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Manage billing/i });
    expect(screen.getByText("Legendary for Life — access never expires", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("legendary for life")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reactivate Subscription/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel Subscription/i })).toBeNull();
  });

  it("shows the Free Plan block text beside Go Legendary for a free account", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: null,
        membershipTier: "registered",
        isLifetime: false,
      }),
    );

    renderPanel();

    expect(await screen.findByText("Free Plan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go Legendary" })).toBeTruthy();
  });

  it("shows the renewal date on the card while the Stripe mirror is still empty", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: null,
        appSubscription: MIDDAY_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Cancel Subscription/i });
    expect(screen.getByText("September 29, 2026")).toBeTruthy();
  });

  it("reads Monthly as the plan label and $3.99/month on the price line for a genuine monthly subscriber", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        subscription: MIRRORED_MONTHLY_SUB,
        appSubscription: ACTIVE_MONTHLY_APP_SUB,
        membershipTier: "legendary",
        isLifetime: false,
      }),
    );

    renderPanel();

    await screen.findByRole("button", { name: /Switch to Annual/i });
    expect(screen.getByText(/^Monthly subscription/)).toBeTruthy();
    expect(screen.getByText("$3.99/month")).toBeTruthy();
  });

  it("cancel then reactivate: Subscription cancelled with the renewal date, Reactivate Subscription, no Cancel, then Cancel Subscription back", async () => {
    // Stateful stub: the cancel/reactivate routes flip the app-DB flag the
    // background refetch of /api/stripe/subscription then reads back.
    let cancelAtPeriodEnd = false;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: unknown = {};
        if (url.includes("/api/stripe/subscription/cancel")) {
          calls.push(`${init?.method} cancel`);
          cancelAtPeriodEnd = true;
          body = { subscription: { id: "sub_test" } };
        } else if (url.includes("/api/stripe/subscription/reactivate")) {
          calls.push(`${init?.method} reactivate`);
          cancelAtPeriodEnd = false;
          body = { subscription: { id: "sub_test" } };
        } else if (url.includes("/api/stripe/subscription")) {
          body = {
            subscription: null,
            appSubscription: { ...MIDDAY_APP_SUB, cancelAtPeriodEnd },
            membershipTier: "legendary",
            isLifetime: false,
          };
        } else if (url.includes("/api/stripe/payment-history")) {
          body = { history: [] };
        } else if (url.includes("/api/stripe/plans")) {
          body = { plans: PLANS };
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
      }),
    );

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /^Cancel Subscription$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, Cancel" }));

    // Cancelled: notice + renewal date + Reactivate, and the controls are gone.
    expect(await screen.findByText("Subscription cancelled")).toBeTruthy();
    expect(screen.getByText("September 29, 2026")).toBeTruthy();
    const reactivate = await screen.findByRole("button", { name: /Reactivate Subscription/i });
    expect(screen.queryByRole("button", { name: /Cancel Subscription/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to Annual/i })).toBeNull();

    fireEvent.click(reactivate);

    // Reactivated: the controls come back and the Reactivate button is gone.
    expect(await screen.findByRole("button", { name: /Cancel Subscription/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Switch to Annual/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reactivate Subscription/i })).toBeNull();
    expect(calls).toEqual(["POST cancel", "POST reactivate"]);
  });
});
