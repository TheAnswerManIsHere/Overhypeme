import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  EMPTY_POLL_STATE,
  describeScope,
  headlineFor,
  instancesSampled,
  nextExpiryAt,
  pruneStaleObservations,
  recordObservation,
  shouldKeepPolling,
  worstObservedState,
  type VerificationPollState,
  type VerificationSnapshot,
} from "./stripeVerification";

/** Fast enough that a change is visible while an operator is still looking. */
export const VERIFICATION_POLL_INTERVAL_MS = 5_000;

/**
 * How far before an observation's expiry the settled panel takes one sample.
 *
 * The lead has to be long enough for the request to complete, and short enough
 * that a terminated instance's entry still ages out promptly. It is a lead, not
 * an interval: the refresh happens once per TTL, not once per lead.
 */
export const TERMINAL_REFRESH_LEAD_MS = 15_000;

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
  /**
   * The mode the page believes is stored. An `initial` sample for any other
   * mode is REJECTED rather than shown: after a successful toggle the page's
   * summary still describes the previous mode, and seeding with it reports the
   * wrong mode's state. Worse, if that previous state was `unconfigured` —
   * terminal, and deliberately not polled — the panel would never fetch again
   * and would sit on the stale answer until a manual refresh. Pass `null` when
   * the stored mode is not known yet; that also rejects, which is correct.
   */
  expectedMode: "live" | "test" | null;
  /**
   * Called once if a sample arrives for a mode this page is not showing —
   * i.e. the stored mode changed somewhere else (another admin, another tab).
   * Rejecting the sample keeps the panel honest; this is what lets the PAGE
   * catch up, rather than sitting on a mode nobody is in any more. Fired at
   * most once per mount, so a page that cannot refresh does not spin.
   */
  onStoredModeChanged?: (observedMode: "live" | "test" | null) => void;
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
  expectedMode,
  onStoredModeChanged,
  pollIntervalMs = VERIFICATION_POLL_INTERVAL_MS,
  settledPollIntervalMs = VERIFICATION_SETTLED_POLL_INTERVAL_MS,
}: StripeVerificationStatusProps) {
  const seed = initial && expectedMode !== null && initial.mode === expectedMode ? initial : null;
  const [poll, setPoll] = useState<VerificationPollState>(() =>
    seed ? recordObservation(EMPTY_POLL_STATE, seed) : EMPTY_POLL_STATE,
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
  const announcedModeChange = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (cancelled) return;
      const pruned = pruneStaleObservations(pollRef.current);
      if (shouldKeepPolling(pruned)) {
        const delay = pollRef.current.quietPolls > 0 ? settledPollIntervalMs : pollIntervalMs;
        timer = setTimeout(() => void sample(), delay);
        return;
      }

      // Polling has stopped, but expiry is a function of TIME, and `pruneStale-
      // Observations` at render time is not reactive to it. Without a wake-up,
      // an instance observed as `refused` and then terminated stays on screen
      // forever, because nothing ever re-renders to notice its entry aged out.
      //
      // Round 4 scheduled that wake-up to PRUNE, and round 5 found what pruning
      // alone cannot know: once polling has stopped, a still-running instance
      // looks exactly like a terminated one — neither has been seen lately,
      // because nothing has been asking. Every terminal observation therefore
      // aged out at the TTL and the whole panel vanished from a healthy page.
      //
      // So the wake-up SAMPLES, slightly before the oldest observation is due
      // to expire. A live instance answers and its entry is renewed; a
      // terminated one does not and its entry ages out on the next pass. That
      // is the distinction the panel needs, and it costs one request per TTL
      // per mount — two orders of magnitude below the polling interval, and
      // only while an admin has the page open.
      const expiresAt = nextExpiryAt(pruned);
      if (expiresAt === null) return;
      const wakeAt = expiresAt - TERMINAL_REFRESH_LEAD_MS;
      timer = setTimeout(() => void sample(), Math.max(0, wakeAt - Date.now()));
    };

    const sample = async () => {
      let next: VerificationPollState;
      try {
        const observation = await fetchStatus();
        if (cancelled) return;
        // EVERY observation is mode-checked, not just the seed. Round 3 caught
        // the difference: if another admin or another browser tab changes the
        // stored mode while this page is open, later polls return snapshots for
        // the NEW mode while this panel and the toggle beside it still describe
        // the old one — and mixing them reports, say, "Payments verified" under
        // a stale TEST label when the sample actually describes LIVE. A sample
        // for a mode this page is not showing is not evidence about this page.
        const usable = observation && expectedMode !== null && observation.mode === expectedMode;
        // Only when the page KNOWS its mode and the sample reports a DIFFERENT
        // known mode. Two kinds of ignorance are excluded, and round 5 caught
        // the second one:
        //
        //   - `expectedMode === null` — the page has not loaded the stored mode
        //     yet. That is ignorance, not a change.
        //   - `observation.mode === null` — the responding instance could not
        //     read the stored mode. Also ignorance, and treating it as a change
        //     spent the one-shot notification on nothing: the Billing page
        //     cannot apply a null mode, its fallback refresh can return the
        //     same cached value it already had, and a LATER poll reporting a
        //     genuine switch then found the notification already consumed —
        //     leaving the page stuck on the old mode until a reload.
        if (
          observation &&
          !usable &&
          expectedMode !== null &&
          observation.mode !== null &&
          !announcedModeChange.current
        ) {
          announcedModeChange.current = true;
          onStoredModeChanged?.(observation.mode);
        }
        next = usable
          ? recordObservation(pruneStaleObservations(pollRef.current), observation)
          : { ...pruneStaleObservations(pollRef.current), quietPolls: pollRef.current.quietPolls + 1 };
      } catch {
        // A failed fetch is not information about the guard. Count it as a quiet
        // poll so the settle window still closes, and report nothing.
        if (cancelled) return;
        next = { ...pruneStaleObservations(pollRef.current), quietPolls: pollRef.current.quietPolls + 1 };
      }
      pollRef.current = next;
      setPoll(next);
      scheduleNext();
    };

    // A seed the page had for THIS mode is already recorded, so the first
    // request here is a poll rather than a duplicate of the fetch that produced
    // it. A rejected or absent seed samples immediately instead.
    if (seed) scheduleNext();
    else void sample();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Mount-scoped on purpose: the loop owns its own scheduling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pruned before every reading of the state, so an expired entry cannot drive
  // the headline while being expired in the polling decision, or vice versa.
  const live = pruneStaleObservations(poll);
  const state = worstObservedState(live);
  if (state === null) return null;

  const tone =
    state === "verified" ? "text-green-400 border-green-500/30 bg-green-500/10"
      : state === "pending" ? "text-blue-400 border-blue-500/30 bg-blue-500/10"
      : state === "refused" ? "text-red-400 border-red-500/30 bg-red-500/10"
      : "text-muted-foreground border-border bg-muted/20";

  const reasons = Object.values(live.byInstance)
    .filter((o) => o.state !== "verified" && o.reason)
    .map((o) => ({ instanceId: o.instanceId, reason: o.reason! }));

  return (
    <div
      className={`mt-4 border rounded-sm p-3 text-xs ${tone}`}
      data-testid="stripe-verification"
      data-state={state}
      data-instances={instancesSampled(live)}
    >
      <div className="flex items-center gap-2 font-medium">
        {state === "verified"
          ? <ShieldCheck className="w-4 h-4 shrink-0" />
          : <AlertTriangle className="w-4 h-4 shrink-0" />}
        <span>{headlineFor(state)}</span>
      </div>
      <p className="mt-1 opacity-80">{describeScope(live)}</p>
      {reasons.map((r) => (
        <p key={r.instanceId} className="mt-1 opacity-80">
          <span className="font-mono">{r.instanceId.slice(0, 8)}</span>: {r.reason}
        </p>
      ))}
    </div>
  );
}
