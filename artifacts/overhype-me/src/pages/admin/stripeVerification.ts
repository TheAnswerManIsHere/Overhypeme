/**
 * The Billing page's model of the Stripe account guard's status.
 *
 * Pure — no React, no fetch — because the interesting behavior here is a
 * decision about when to stop polling, and that decision is wrong in a way a
 * rendered smoke test would not catch.
 *
 * ## The value is per-instance, and the page must not launder that away
 *
 * The deployment is `autoscale` with the server running in every instance, so
 * `/admin/stripe/summary` answers from whichever instance the router picked.
 * The server labels its answer with the responding instance; if the page then
 * stopped polling the moment *one* instance answered terminal, it would report
 * recovery for a fleet that has not recovered — the label would be honest and
 * the behavior would still be wrong, which is the exact species of overclaim
 * this workstream kept producing.
 *
 * So: observations are kept per instance, and polling continues while any
 * observed instance is transitional **and** for a bounded settle window after
 * everything looks terminal, so other instances get sampled. The page reports
 * how many instances it has sampled and never claims to speak for the
 * deployment. A fleet-wide aggregate needs shared state, which this increment
 * may not add; this is the honest per-instance mechanism in its place.
 */

import type { StripeVerificationSnapshot, StripeVerificationState } from "@workspace/api-zod";

export type VerificationState = StripeVerificationState;
export type VerificationSnapshot = StripeVerificationSnapshot;

/**
 * What the panel shows for one instance: the guard's state, plus one state the
 * guard does not have. `setup_incomplete` is a VERIFIED instance whose setup
 * (webhook registration) has not finished — checkout is open there, but
 * Stripe's events are not arriving. Reading it as plain `verified` was the
 * observability half of #577's P1: a setup that kept failing showed only in
 * the log while the panel said all was well.
 */
export type DisplayState = VerificationState | "setup_incomplete";

export function displayStateOf(observation: VerificationSnapshot): DisplayState {
  if (observation.state === "verified" && observation.setup && observation.setup.state !== "complete") {
    return "setup_incomplete";
  }
  return observation.state;
}

/** The operator-facing reason for an instance that is not fully healthy, or null. */
export function reasonFor(observation: VerificationSnapshot): string | null {
  const display = displayStateOf(observation);
  if (display === "verified") return null;
  if (display === "setup_incomplete") return observation.setup?.reason ?? null;
  return observation.reason;
}

export interface VerificationPollState {
  byInstance: Record<string, VerificationSnapshot>;
  /** When each instance was last actually observed, for the liveness bound below. */
  seenAt: Record<string, number>;
  /** Consecutive polls that revealed nothing new — no new instance, no state change. */
  quietPolls: number;
}

/**
 * How many further polls to run after everything observed looks terminal.
 * Each one is a fresh chance for the router to hand us a different instance.
 */
export const SETTLE_CONFIRM_POLLS = 3;

/**
 * How long an unseen instance's observation still counts.
 *
 * Instances come and go — a rollout replaces them, autoscale removes them under
 * load. Without a liveness bound, one instance observed as `pending` and then
 * terminated stays in the map forever: the panel keeps polling because something
 * is still transitional, and keeps reporting that dead instance's state as the
 * current worst even after every reachable instance has verified. A terminated
 * `refused` entry does the same thing after polling stops.
 *
 * So an observation is evidence with a shelf life. This is deliberately several
 * poll intervals, so an instance the router simply did not pick for a few polls
 * is not mistaken for one that is gone.
 */
export const OBSERVATION_TTL_MS = 120_000;

export const EMPTY_POLL_STATE: VerificationPollState = { byInstance: {}, seenAt: {}, quietPolls: 0 };

export function recordObservation(
  previous: VerificationPollState,
  observation: VerificationSnapshot,
  now: number = Date.now(),
): VerificationPollState {
  const known = previous.byInstance[observation.instanceId];
  const isNew = known === undefined;
  // Compared on the DISPLAY state, so setup finishing on a verified instance
  // counts as a change and is seen, not absorbed into the settle window.
  const changed = !isNew && displayStateOf(known) !== displayStateOf(observation);
  return {
    byInstance: { ...previous.byInstance, [observation.instanceId]: observation },
    seenAt: { ...previous.seenAt, [observation.instanceId]: now },
    quietPolls: isNew || changed ? 0 : previous.quietPolls + 1,
  };
}

/**
 * Drop observations older than the TTL. Applied before every reading of the
 * state — the headline, the scope line, and the polling decision — so a stale
 * entry cannot survive in one of them while being expired in another.
 */
export function pruneStaleObservations(
  state: VerificationPollState,
  now: number = Date.now(),
): VerificationPollState {
  const liveIds = Object.keys(state.byInstance).filter(
    (id) => now - (state.seenAt[id] ?? 0) < OBSERVATION_TTL_MS,
  );
  if (liveIds.length === Object.keys(state.byInstance).length) return state;
  const byInstance: Record<string, VerificationSnapshot> = {};
  const seenAt: Record<string, number> = {};
  for (const id of liveIds) {
    byInstance[id] = state.byInstance[id]!;
    seenAt[id] = state.seenAt[id]!;
  }
  return { byInstance, seenAt, quietPolls: state.quietPolls };
}

/**
 * When the earliest-expiring observation ages out, or `null` if there are none.
 *
 * Expiry is a function of time, and nothing re-renders on its own once polling
 * stops — so a caller that has stopped polling needs to know when to wake and
 * re-derive, or a terminated instance stays on screen indefinitely.
 */
export function nextExpiryAt(state: VerificationPollState): number | null {
  const times = Object.values(state.seenAt);
  if (times.length === 0) return null;
  return Math.min(...times) + OBSERVATION_TTL_MS;
}

function observations(state: VerificationPollState): VerificationSnapshot[] {
  return Object.values(state.byInstance);
}

export function shouldKeepPolling(state: VerificationPollState): boolean {
  const seen = observations(state);
  if (seen.length === 0) {
    // Nothing observed yet. `quietPolls > 0` means a fetch was attempted and
    // failed — a failed fetch is not information about the guard, so keep
    // trying for the settle window rather than giving up: stopping here would
    // render nothing at all, for the lifetime of the mount, and the state the
    // panel exists to show would be silently absent.
    return state.quietPolls > 0 && state.quietPolls < SETTLE_CONFIRM_POLLS;
  }

  // Terminal and deliberately unpolled: an integration nobody enabled is not a
  // fault and is not recovering. Polling it forever would render an intentional
  // absence as temporary recovery.
  if (seen.every((o) => o.state === "unconfigured")) return false;

  // Setup still owed on a verified instance is transitional too: the server's
  // retry loop is working on it, and the panel should see it finish.
  if (seen.some((o) => o.state === "pending" || displayStateOf(o) === "setup_incomplete")) return true;

  // Everything observed has settled — but "everything observed" is not
  // "everything". Keep sampling for a bounded window.
  return state.quietPolls < SETTLE_CONFIRM_POLLS;
}

/**
 * The single state to lead with, chosen so a partially-recovered fleet never
 * reads as healthy: any instance still refusing or pending outranks a verified
 * one.
 */
export function worstObservedState(state: VerificationPollState): DisplayState | null {
  const seen = observations(state);
  if (seen.length === 0) return null;
  const order: DisplayState[] = ["refused", "pending", "setup_incomplete", "unconfigured", "verified"];
  for (const candidate of order) {
    if (seen.some((o) => displayStateOf(o) === candidate)) return candidate;
  }
  return null;
}

export function instancesSampled(state: VerificationPollState): number {
  return observations(state).length;
}

/** Operator-facing label. Says "instance(s) sampled" — never "the deployment". */
export function describeScope(state: VerificationPollState): string {
  const n = instancesSampled(state);
  if (n === 0) return "No instance sampled yet.";
  if (n === 1) {
    const only = observations(state)[0]!;
    return `This instance only (${only.instanceId.slice(0, 8)}). Other instances of this autoscale deployment may differ.`;
  }
  return `${n} instances sampled. Other instances of this autoscale deployment may differ.`;
}

export function headlineFor(state: DisplayState): string {
  switch (state) {
    case "verified":
      return "Payments verified";
    case "setup_incomplete":
      return "Account verified — Stripe setup not finished";
    case "pending":
      return "Payments unavailable — verifying";
    case "refused":
      return "Payments refused — account not verified";
    case "unconfigured":
      return "Stripe is not configured";
  }
}

/**
 * Read the server's reason out of a failed response body.
 *
 * `toggleLiveMode()` used to do `if (!resp.ok) throw new Error("Failed to
 * update")` — the body was never read, so every non-success reply, whatever it
 * said, reached the operator as that one string. An operator seeing it had no
 * way to tell a mismatched account from a transient failure, and *which key
 * points at which account* is the entire value of the refusal.
 */
export function parseToggleErrorBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return fallback;
}
