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
  OBSERVATION_TTL_MS,
  SETTLE_CONFIRM_POLLS,
  nextExpiryAt,
  pruneStaleObservations,
  describeScope,
  parseToggleErrorBody,
  recordObservation,
  shouldKeepPolling,
  worstObservedState,
  type VerificationSnapshot,
} from "./stripeVerification";
import {
  StripeVerificationStatus,
  VERIFICATION_POLL_INTERVAL_MS,
} from "./StripeVerificationStatus";

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

describe("observations expire", () => {
  it("an instance not seen within the TTL stops driving the headline and the polling", () => {
    // Round 3's P2. In an autoscale deployment an instance observed as `pending`
    // can be terminated during a rollout. With no liveness bound its entry stays
    // in the map forever: the panel keeps polling because something is still
    // transitional, and keeps presenting the dead instance's state as the
    // current worst even after every reachable instance has verified.
    const t0 = 1_000_000;
    let state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "gone", state: "pending" }), t0);
    state = recordObservation(state, snap({ instanceId: "live-one", state: "verified" }), t0);

    // While both are fresh, the dead one correctly dominates.
    expect(worstObservedState(pruneStaleObservations(state, t0))).toBe("pending");
    expect(shouldKeepPolling(pruneStaleObservations(state, t0))).toBe(true);

    // The surviving instance keeps answering; the terminated one never does.
    const later = t0 + OBSERVATION_TTL_MS + 1;
    state = recordObservation(state, snap({ instanceId: "live-one", state: "verified" }), later);

    const pruned = pruneStaleObservations(state, later);
    expect(Object.keys(pruned.byInstance)).toEqual(["live-one"]);
    expect(worstObservedState(pruned)).toBe("verified");
  });

  it("the next expiry is the EARLIEST observation's, so a waker cannot sleep past one", () => {
    // Round 4's P2: pruning at render time is not reactive to time, so a caller
    // that has stopped polling needs to know when to wake. Keying on the newest
    // entry would sleep straight past an older one still on screen.
    const t0 = 3_000_000;
    let state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "old" }), t0);
    state = recordObservation(state, snap({ instanceId: "new" }), t0 + 5_000);
    expect(nextExpiryAt(state)).toBe(t0 + OBSERVATION_TTL_MS);
    expect(nextExpiryAt(EMPTY_POLL_STATE)).toBeNull();
  });

  it("pruning is identity when nothing has expired", () => {
    const t0 = 2_000_000;
    const state = recordObservation(EMPTY_POLL_STATE, snap({ instanceId: "a" }), t0);
    expect(pruneStaleObservations(state, t0 + 1)).toBe(state);
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

    render(<StripeVerificationStatus fetchStatus={fetchStatus} expectedMode="test" pollIntervalMs={1} settledPollIntervalMs={1} />);

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
    render(<StripeVerificationStatus fetchStatus={fetchStatus} expectedMode="test" pollIntervalMs={1} settledPollIntervalMs={1} />);

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
    render(<StripeVerificationStatus fetchStatus={fetchStatus} expectedMode="test" pollIntervalMs={1} settledPollIntervalMs={1} />);

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

    render(<StripeVerificationStatus fetchStatus={fetchStatus} expectedMode="test" pollIntervalMs={1} settledPollIntervalMs={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("refused");
    });
    cleanup();
  });

  it("a seed for a DIFFERENT mode is rejected, and the panel fetches instead", async () => {
    // Round 1's P2. After a successful toggle the page's summary still
    // describes the previous mode, and this component remounts with it. Seeding
    // from that reports the wrong mode's state — and if the previous state was
    // `unconfigured`, which is terminal and deliberately unpolled, the panel
    // would never fetch again and would sit on the stale answer indefinitely.
    const fetchStatus = vi.fn(async () =>
      snap({ instanceId: "inst-1", state: "verified", mode: "live" }),
    );
    render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        initial={snap({ instanceId: "inst-1", state: "unconfigured", mode: "test", reason: "no keys" })}
        expectedMode="live"
        pollIntervalMs={1}
        settledPollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("verified");
    });
    expect(fetchStatus).toHaveBeenCalled();
    cleanup();
  });

  it("with no known stored mode, nothing is attributed and nothing is shown", async () => {
    // `expectedMode` is null while the page is still loading its config rows.
    // No sample can be attributed to a mode in that window, and a state shown
    // without the mode it belongs to is the same overclaim this panel exists to
    // avoid — so it renders nothing until the page knows. In the real page that
    // window is one fetch long, and the panel is keyed on the mode, so it
    // remounts and starts sampling the moment the mode is known.
    const fetchStatus = vi.fn(async () => snap({ instanceId: "inst-1", state: "verified", mode: "test" }));
    const { container } = render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        initial={snap({ instanceId: "inst-1", state: "unconfigured", mode: "test" })}
        expectedMode={null}
        pollIntervalMs={1}
        settledPollIntervalMs={1}
      />,
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("stripe-verification")).toBeNull();
    expect(container.textContent).toBe("");
    cleanup();
  });

  it("a poll sample for a DIFFERENT stored mode is rejected, and the page is told", async () => {
    // Round 3's P2. Only the initial seed was mode-checked. If another admin or
    // another tab changes the stored mode while this page is open, later polls
    // return snapshots for the NEW mode while this panel and the toggle beside
    // it still describe the old one — so the panel could report "Payments
    // verified" under a stale TEST label from a sample that describes LIVE.
    let call = 0;
    const fetchStatus = vi.fn(async () => {
      call++;
      return call === 1
        ? snap({ instanceId: "inst-1", state: "refused", mode: "test", reason: "wrong account" })
        : snap({ instanceId: "inst-2", state: "verified", mode: "live" });
    });
    const onStoredModeChanged = vi.fn();

    render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        expectedMode="test"
        onStoredModeChanged={onStoredModeChanged}
        pollIntervalMs={1}
        settledPollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("refused");
    });

    // The live-mode sample must never be mixed in: the panel still shows only
    // what it saw for the mode it is labelled with.
    await waitFor(() => expect(onStoredModeChanged).toHaveBeenCalled());
    expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("refused");
    expect(screen.getByTestId("stripe-verification").getAttribute("data-instances")).toBe("1");
    // Fired at most once, so a page that cannot refresh does not spin.
    expect(onStoredModeChanged).toHaveBeenCalledTimes(1);
    // And it carries the OBSERVED mode, not just a bare signal: the page needs
    // the authoritative value, because the endpoint it would otherwise re-read
    // can answer from an instance still holding a stale config cache.
    expect(onStoredModeChanged).toHaveBeenCalledWith("live");
    cleanup();
  });

  it("an unreadable mode does NOT consume the one-shot mode-change notification", async () => {
    // Round 5's P2. When the responding instance cannot read the stored mode it
    // emits `mode: null` — ignorance, not a change. The old branch spent the
    // one-shot notification on it: the Billing page cannot apply a null mode,
    // its fallback refresh can return the same cached value it already had, and
    // a LATER poll reporting a GENUINE switch then found the notification
    // already consumed. The page sat on the old mode, rejecting every sample,
    // until someone reloaded it.
    let call = 0;
    const fetchStatus = vi.fn(async () => {
      call++;
      if (call === 1) return snap({ instanceId: "inst-1", state: "verified", mode: "test" });
      if (call === 2) return snap({ instanceId: "inst-9", state: "pending", mode: null });
      return snap({ instanceId: "inst-2", state: "verified", mode: "live" });
    });
    const onStoredModeChanged = vi.fn();

    render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        expectedMode="test"
        onStoredModeChanged={onStoredModeChanged}
        pollIntervalMs={1}
        settledPollIntervalMs={1}
      />,
    );

    // The genuine switch must still be announced, with the real mode — which is
    // exactly what the unreadable sample used to swallow.
    await waitFor(() => expect(onStoredModeChanged).toHaveBeenCalledWith("live"));
    expect(onStoredModeChanged).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("a settled panel keeps sampling before the TTL, so a live instance does not age out", async () => {
    // Round 5's P2 on the expiry wake-up. Round 4 scheduled that wake to PRUNE,
    // and pruning cannot tell a terminated instance from one nothing has asked
    // lately — which, once polling has settled, is every instance. So every
    // terminal observation aged out at the TTL and the whole panel vanished
    // from a perfectly healthy page.
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async () => snap({ instanceId: "inst-1", state: "verified", mode: "test" }));
      render(
        <StripeVerificationStatus
          fetchStatus={fetchStatus}
          expectedMode="test"
          pollIntervalMs={10}
          settledPollIntervalMs={10}
        />,
      );

      // Close the settle window, then prove polling has actually STOPPED —
      // otherwise the assertions below would pass on ordinary polling and say
      // nothing about the wake-up at all.
      await vi.advanceTimersByTimeAsync(10 * (SETTLE_CONFIRM_POLLS + 3));
      const settledCalls = fetchStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchStatus.mock.calls.length).toBe(settledCalls);

      // Now past the point where the observation would age out. The instance is
      // still answering, so the panel must still show it — which requires the
      // scheduled wake to have SAMPLED rather than pruned.
      await vi.advanceTimersByTimeAsync(OBSERVATION_TTL_MS);

      expect(fetchStatus.mock.calls.length).toBeGreaterThan(settledCalls);
      expect(screen.getByTestId("stripe-verification").getAttribute("data-state")).toBe("verified");
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it("a seeded initial sample renders without a second fetch", async () => {
    // The page's own summary fetch already carries this field; re-requesting it
    // on mount would double the load on the heaviest admin endpoint.
    const fetchStatus = vi.fn(async () => snap({ instanceId: "inst-1", state: "verified" }));
    render(
      <StripeVerificationStatus
        fetchStatus={fetchStatus}
        initial={snap({ instanceId: "inst-1", state: "verified", mode: "test" })}
        expectedMode="test"
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
