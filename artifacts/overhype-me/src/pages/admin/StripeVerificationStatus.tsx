import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  EMPTY_POLL_STATE,
  describeScope,
  headlineFor,
  instancesSampled,
  recordObservation,
  shouldKeepPolling,
  worstObservedState,
  type VerificationPollState,
  type VerificationSnapshot,
} from "./stripeVerification";

/** Fast enough that a change is visible while an operator is still looking. */
export const VERIFICATION_POLL_INTERVAL_MS = 5_000;

/**
 * Once nothing is changing, back off to the server's own retry cadence.
 *
 * The server re-attempts verification every 30s, so a recovery cannot surface
 * faster than that however often the page asks — and the endpoint it asks is
 * the admin summary, which runs a filtered tier-count aggregate over `users`
 * plus two webhook-audit queries. Polling that every 5s for the duration of a
 * Stripe outage, which is exactly when this panel is being watched, is load
 * bought for nothing.
 */
export const VERIFICATION_SETTLED_POLL_INTERVAL_MS = 30_000;

export interface StripeVerificationStatusProps {
  /**
   * Fetches one sample of the guard's state. Injected so the polling behavior
   * can be exercised without a network, and so the page keeps owning the
   * endpoint it already fetches.
   */
  fetchStatus: () => Promise<VerificationSnapshot | null>;
  /**
   * A sample the page already has — the summary fetch it performs on mount
   * carries this field, so seeding it here avoids a second request for a value
   * already in hand.
   */
  initial?: VerificationSnapshot | null;
  pollIntervalMs?: number;
  settledPollIntervalMs?: number;
}

/**
 * The account guard's state, shown rather than logged.
 *
 * Every string here is scoped to the instances actually sampled, and the
 * polling stops on a rule that accounts for there being more than one. A page
 * that stopped the moment ONE instance answered terminal would report recovery
 * for a fleet that has not recovered — the label would be honest and the
 * behavior would still be wrong, which is the species of overclaim this
 * workstream's review found eight times, twice inside a fix for a previous
 * instance of it.
 */
export function StripeVerificationStatus({
  fetchStatus,
  initial = null,
  pollIntervalMs = VERIFICATION_POLL_INTERVAL_MS,
  settledPollIntervalMs = VERIFICATION_SETTLED_POLL_INTERVAL_MS,
}: StripeVerificationStatusProps) {
  const [poll, setPoll] = useState<VerificationPollState>(() =>
    initial ? recordObservation(EMPTY_POLL_STATE, initial) : EMPTY_POLL_STATE,
  );

  /**
   * The loop reads the latest state through a ref rather than through the
   * effect's dependencies. Depending on `poll` would tear the effect down and
   * rebuild it on every sample, which needs a second guard to stop the teardown
   * from cancelling the very first request — and getting that wrong renders
   * nothing at all.
   */
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (cancelled || !shouldKeepPolling(pollRef.current)) return;
      const delay = pollRef.current.quietPolls > 0 ? settledPollIntervalMs : pollIntervalMs;
      timer = setTimeout(() => void sample(), delay);
    };

    const sample = async () => {
      let next: VerificationPollState;
      try {
        const observation = await fetchStatus();
        if (cancelled) return;
        next = observation
          ? recordObservation(pollRef.current, observation)
          : { ...pollRef.current, quietPolls: pollRef.current.quietPolls + 1 };
      } catch {
        // A failed fetch is not information about the guard. Count it as a quiet
        // poll so the settle window still closes, and report nothing.
        if (cancelled) return;
        next = { ...pollRef.current, quietPolls: pollRef.current.quietPolls + 1 };
      }
      pollRef.current = next;
      setPoll(next);
      scheduleNext();
    };

    // `initial`, when the page had one, is already recorded — so the first
    // request here is a poll, not a duplicate of the fetch that produced it.
    if (initial) scheduleNext();
    else void sample();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Mount-scoped on purpose: the loop owns its own scheduling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = worstObservedState(poll);
  if (state === null) return null;

  const tone =
    state === "verified" ? "text-green-400 border-green-500/30 bg-green-500/10"
      : state === "pending" ? "text-blue-400 border-blue-500/30 bg-blue-500/10"
      : state === "refused" ? "text-red-400 border-red-500/30 bg-red-500/10"
      : "text-muted-foreground border-border bg-muted/20";

  const reasons = Object.values(poll.byInstance)
    .filter((o) => o.state !== "verified" && o.reason)
    .map((o) => ({ instanceId: o.instanceId, reason: o.reason! }));

  return (
    <div
      className={`mt-4 border rounded-sm p-3 text-xs ${tone}`}
      data-testid="stripe-verification"
      data-state={state}
      data-instances={instancesSampled(poll)}
    >
      <div className="flex items-center gap-2 font-medium">
        {state === "verified"
          ? <ShieldCheck className="w-4 h-4 shrink-0" />
          : <AlertTriangle className="w-4 h-4 shrink-0" />}
        <span>{headlineFor(state)}</span>
      </div>
      <p className="mt-1 opacity-80">{describeScope(poll)}</p>
      {reasons.map((r) => (
        <p key={r.instanceId} className="mt-1 opacity-80">
          <span className="font-mono">{r.instanceId.slice(0, 8)}</span>: {r.reason}
        </p>
      ))}
    </div>
  );
}
