import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function mockFetch(subscriptionResponse: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/stripe/subscription")
      ? subscriptionResponse
      : url.includes("/api/stripe/payment-history")
        ? { history: [] }
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
