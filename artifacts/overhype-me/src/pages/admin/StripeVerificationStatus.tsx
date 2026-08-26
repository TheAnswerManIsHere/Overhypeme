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

/** Fast enough that a recovery is visible while an operator is still looking. */
export const VERIFICATION_POLL_INTERVAL_MS = 5_000;

export interface StripeVerificationStatusProps {
  /**
   * Fetches one sample of the guard's state. Injected so the polling behavior
   * can be exercised without a network, and so the page keeps owning the
   * endpoint it already fetches.
   */
  fetchStatus: () => Promise<VerificationSnapshot | null>;
  pollIntervalMs?: number;
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
  pollIntervalMs = VERIFICATION_POLL_INTERVAL_MS,
}: StripeVerificationStatusProps) {
  const [poll, setPoll] = useState<VerificationPollState>(EMPTY_POLL_STATE);
  /**
   * A ref, not state, and that matters: `setStarted(true)` would re-render
   * immediately, tearing down this effect and cancelling the very first sample
   * before it resolved — so the panel would render nothing at all.
   */
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const sample = async () => {
      try {
        const observation = await fetchStatus();
        if (cancelled || !observation) return;
        setPoll((previous) => recordObservation(previous, observation));
      } catch {
        // A failed fetch is not information about the guard. Count it as a quiet
        // poll so the settle window still closes, and report nothing.
        if (cancelled) return;
        setPoll((previous) => ({ ...previous, quietPolls: previous.quietPolls + 1 }));
      }
    };

    if (!startedRef.current) {
      startedRef.current = true;
      void sample();
      return () => { cancelled = true; };
    }

    if (!shouldKeepPolling(poll)) return () => { cancelled = true; };

    const timer = setTimeout(() => { void sample(); }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, fetchStatus, pollIntervalMs]);

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
