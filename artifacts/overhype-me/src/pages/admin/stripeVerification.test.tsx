/**
 * The Billing page's half of the Stripe account guard.
 *
 * Tests 10, 16, 18 and 19 from the plan, plus the polling-termination behavior
 * recorded as a gap at plan approval: labelling the value per-instance made the
 * *sample* honest and left the *behavior* wrong, because the page still stopped
 * polling on whichever instance answered terminal first.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import {
  EMPTY_POLL_STATE,
  SETTLE_CONFIRM_POLLS,
  describeScope,
  parseToggleErrorBody,
  recordObservation,
  shouldKeepPolling,
  worstObservedState,
  type VerificationSnapshot,
} from "./stripeVerification";
import { StripeVerificationStatus } from "./StripeVerificationStatus";

function snap(partial: Partial<VerificationSnapshot> & { instanceId: string }): VerificationSnapshot {
  return {
    state: "pending",
    mode: "test",
    reason: null,
    lastAttemptAt: null,
    scope: "instance",
    ...partial,
  };
}

describe("test 10 — a refused toggle shows the server's reason", () => {
  it("uses the server's message rather than the hardcoded fallback", () => {
    // Before this, `toggleLiveMode()` did `if (!resp.ok) throw new Error("Failed
    // to update")` and never read the body — so every non-success reply, whatever
    // it said, reached the operator as that one string, and a mismatched account
    // was indistinguishable from a network blip. Which key points at which
    // account is the entire value of the refusal.
    const body = {
      error:
        "STRIPE ACCOUNT MISMATCH — STRIPE_SECRET_KEY_LIVE belongs to account acct_other, " +
        "but STRIPE_ACCOUNT_ID_LIVE declares acct_expected.",
    };
    expect(parseToggleErrorBody(body, "Failed to update")).toContain("acct_other");
    expect(parseToggleErrorBody(body, "Failed to update")).toContain("STRIPE_SECRET_KEY_LIVE");
  });

  it("falls back only when the body carries no reason", () => {
    expect(parseToggleErrorBody(null, "Failed to update")).toBe("Failed to update");
    expect(parseToggleErrorBody({}, "Failed to update")).toBe("Failed to update");
    expect(parseToggleErrorBody({ error: "   " }, "Failed to update")).toBe("Failed to update");
    expect(parseToggleErrorBody("not an object", "Failed to update")).toBe("Failed to update");
  });
});

describe("the polling rule accounts for there being more than one instance", () => {
  it("keeps polling while any observed instance is still transitional", () => {
    let state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "a", state: "pending" }));
    expect(shouldKeepPolling(state)).toBe(true);

    // One instance verifies. The page must NOT conclude the deployment has
    // recovered — that is the defect this rule exists to prevent.
    state = recordObservation(state, snap({ instanceId: "b", state: "pending" }));
    state = recordObservation(state, snap({ instanceId: "a", state: "verified" }));
    expect(shouldKeepPolling(state)).toBe(true);
    expect(worstObservedState(state)).toBe("pending");
  });

  it("stops only after a settle window with nothing new", () => {
    let state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "a", state: "verified" }));
    // Still sampling: another instance may answer differently.
    for (let i = 0; i < SETTLE_CONFIRM_POLLS; i++) {
      expect(shouldKeepPolling(state)).toBe(true);
      state = recordObservation(state, snap({ instanceId: "a", state: "verified" }));
    }
    expect(shouldKeepPolling(state)).toBe(false);
  });

  it("a newly-seen instance reopens the window", () => {
    let state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "a", state: "verified" }));
    for (let i = 0; i < SETTLE_CONFIRM_POLLS; i++) {
      state = recordObservation(state, snap({ instanceId: "a", state: "verified" }));
    }
    expect(shouldKeepPolling(state)).toBe(false);

    state = recordObservation(state, snap({ instanceId: "c", state: "refused" }));
    expect(shouldKeepPolling(state)).toBe(true);
    expect(worstObservedState(state)).toBe("refused");
  });

  it("test 19 — the scope description names instances, never the deployment", () => {
    const one = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "abcdef0123456789" }));
    expect(describeScope(one)).toContain("abcdef01");
    expect(describeScope(one)).toMatch(/this instance only/i);
    expect(describeScope(one)).not.toMatch(/\bthe deployment (is|has)\b/i);

    const two = recordObservation(one, snap({ instanceId: "zzzz" }));
    expect(describeScope(two)).toMatch(/2 instances sampled/);
  });
});

describe("the rendered status surface", () => {
  it("test 16 — pending becomes verified without a manual refresh", async () => {
    // The server recovers only once the test has observed `pending`, so the
    // transition is genuinely rendered by the component's own polling rather
    // than raced past by a fast fixture.
    let recovered = false;
    const fetchStatus = vi.fn(async () =>
      recovered
        ? snap({ instanceId: "inst-1", state: "verified", reason: null })
        : snap({ instanceId: "inst-1", state: "pending", reason: "Stripe unreachable" }),
    );

    render(<StripeVerificationStatus fetchStatus={fetchStatus} pollIntervalMs={1} settledPollIntervalMs={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("pending");
    });
    expect(screen.getByText(/Stripe unreachable/)).toBeTruthy();

    recovered = true;

    // No refresh, no click, no remount — the page's own polling renders it.
    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("verified");
    });
    cleanup();
  });

  it("test 18 — an unconfigured integration renders as not-configured and is NOT polled", async () => {
    const fetchStatus = vi.fn(async () => snap({ instanceId: "inst-1", state: "unconfigured", reason: "no keys" }));
    render(<StripeVerificationStatus fetchStatus={fetchStatus} pollIntervalMs={1} settledPollIntervalMs={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("unconfigured");
    });
    expect(screen.getByText(/not configured/i)).toBeTruthy();

    // Terminal, so the page stops. Without this, the page polls forever against
    // an integration nobody enabled, and renders an intentional absence as
    // temporary recovery.
    const callsAfterFirstRender = fetchStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchStatus.mock.calls.length).toBe(callsAfterFirstRender);
    cleanup();
  });

  it("test 19 — the rendered value is labelled with its instance", async () => {
    const fetchStatus = vi.fn(async () =>
      snap({ instanceId: "9f8e7d6c-1111-2222-3333-444455556666", state: "verified" }),
    );
    render(<StripeVerificationStatus fetchStatus={fetchStatus} pollIntervalMs={1} settledPollIntervalMs={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-instances")).toBe("1");
    });
    expect(screen.getByText(/9f8e7d6c/)).toBeTruthy();
    cleanup();
  });

  it("a first fetch that fails keeps trying instead of rendering nothing forever", async () => {
    // The panel exists to SHOW a state rather than log it, so a transport
    // failure on the first sample must not silently leave the operator with a
    // blank space — and `shouldKeepPolling` returns false on an empty
    // observation set, which is exactly what that would have produced.
    let call = 0;
    const fetchStatus = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("network");
      return snap({ instanceId: "inst-1", state: "refused", reason: "wrong account" });
    });

    render(<StripeVerificationStatus fetchStatus={fetchStatus} pollIntervalMs={1} settledPollIntervalMs={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("refused");
    });
    cleanup();
  });

  it("a seeded initial sample renders without a second fetch", async () => {
    // The page's own summary fetch already carries this field; re-requesting it
    // on mount would double the load on the heaviest admin endpoint.
    const fetchStatus = vi.fn(async () => snap({ instanceId: "inst-1", state: "verified" }));
    render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        initial={snap({ instanceId: "inst-1", state: "verified" })}
        pollIntervalMs={10_000}
        settledPollIntervalMs={10_000}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("verified");
    });
    expect(fetchStatus).not.toHaveBeenCalled();
    cleanup();
  });
});
