/**
 * @purpose The identity module's decisions as consumers read them (#719): whether the identity sheet should be open now, whether a builder may start from the identity, whether a page may render personalized content yet (Phase 4), and the one operation an in-page action calls to ask first and then run (`askBefore`, Phase 3); assembles the auth state, completeness and location once so no consumer rebuilds the policy's inputs.
 * @subsystem public-site
 */
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { LANDING_LOCATION, usePersonName } from "@/hooks/use-person-name";
import { canShowPersonalizedContent, canStartBuilder, isAccountComplete, mustWaitForIdentity, shouldAskForIdentity, type IdentityAuthState, type IdentityDecisionInput } from "@/lib/identity";

export interface IdentityGate {
  /** The identity sheet should be open on this page now. */
  shouldAsk: boolean;
  /**
   * A builder may initialize its draft from the identity now: auth has
   * resolved, the share link is settled (a builder copies the identity once,
   * so it must never copy a link's pending halves an account then drops), and
   * the identity is complete where Phase 1 requires it.
   */
  builderReady: boolean;
  /**
   * A page may render personalized content now (identity-flow Phase 4): the
   * fact page shows its loading surface until this holds, so a visitor without
   * a name sees the identity sheet first and never a fact read as "__".
   */
  contentReady: boolean;
  /**
   * What a builder's draft starts from (identity-flow Phase 2): signed in, the
   * ACCOUNT's own name and pronouns — never this browser's copy, which the
   * account mirror updates only after the render that published the account,
   * so a builder mounting in that render would copy the stale copy and keep
   * it; signed out, the browser's.
   */
  builderSeed: { name: string; pronouns: string };
}

/** A builder's starting identity: the account's own fields when signed in, else the browser's. */
export function builderSeedFor(
  auth: IdentityAuthState,
  account: { displayName?: string | null; pronouns?: string | null } | null,
  browser: { name: string; pronouns: string },
): { name: string; pronouns: string } {
  if (auth !== "signedIn") return browser;
  return {
    name: account?.displayName?.trim() || browser.name,
    pronouns: account?.pronouns?.trim() || browser.pronouns,
  };
}

/**
 * Set the first time this page load's location differs from where it landed,
 * and never cleared: the landing exception lapses for good once the visitor
 * leaves, whatever consumer is mounted when they return. A reload or a new tab
 * is a fresh page load, so it lands afresh.
 */
let landingLapsed = false;

/**
 * The one in-page action waiting for a complete identity (Phase 3). Held at
 * module level, like `landingLapsed`, so the sheet, the runner and every page
 * see the same one. A newer action replaces it; the runner discards it when
 * the location changes and runs it exactly once when the identity completes.
 */
interface PendingAction {
  run: () => void;
  /** Where the visitor asked; a pending action belongs to that page. */
  location: string;
}
let pendingAction: PendingAction | null = null;
const pendingListeners = new Set<() => void>();
function setPendingAction(next: PendingAction | null) {
  pendingAction = next;
  pendingListeners.forEach((l) => l());
}
function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}
const getPending = () => pendingAction;

/**
 * What `askBefore` reads when it is called: whether an action taken now must
 * wait, and where the visitor is. The runner, mounted once, keeps it current,
 * so the many controls that call `askBefore` (every heart in a gallery)
 * subscribe to nothing. Null until the runner has mounted; an action then
 * runs at once, as it did before Phase 3.
 */
let askSnapshot: { mustWait: boolean; location: string } | null = null;

/** Test seam: set what `askBefore` reads, without mounting the runner. */
export function setAskSnapshotForTest(next: { mustWait: boolean; location: string } | null) {
  askSnapshot = next;
}

/** Test seam: take the waiting action's effect, clearing it, as the runner would. */
export function takePendingActionForTest(): (() => void) | null {
  const run = pendingAction?.run ?? null;
  setPendingAction(null);
  return run;
}

/** Test seam: forget any pending action, the landing lapse and the snapshot. */
export function resetIdentityGateForTest() {
  pendingAction = null;
  landingLapsed = false;
  askSnapshot = null;
  pendingListeners.forEach((l) => l());
}

interface GateState {
  decision: Omit<IdentityDecisionInput, "actionPending">;
  auth: IdentityAuthState;
  builderReady: boolean;
  builderSeed: { name: string; pronouns: string };
  location: string;
}

function useGateState(): GateState {
  const { user, isAuthenticated, isLoading, status } = useAuth();
  const { name, pronouns, pronounsSupplied, shareLinkResolved } = usePersonName();
  const [location] = useLocation();
  if (location !== LANDING_LOCATION) landingLapsed = true;
  // A failed auth read is not "signed out": nobody knows who this is yet, so
  // the decision is "not yet" (identity-flow Phase 2, "unknown is not missing").
  const auth: IdentityAuthState =
    isLoading || status === "failed" ? "loading" : isAuthenticated ? "signedIn" : "signedOut";
  const completeness = { hasName: !!name.trim(), pronounsSupplied };
  const account = user as { displayName?: string | null; pronouns?: string | null; eligibility?: string } | null;
  const accountComplete = isAccountComplete(account?.displayName, account?.pronouns);
  return {
    decision: {
      auth,
      completeness,
      accountDisplayName: account?.displayName ?? null,
      accountPronouns: account?.pronouns ?? null,
      accountEligible: account?.eligibility === undefined ? undefined : account.eligibility === "eligible",
      location,
      landingLocation: LANDING_LOCATION,
      landingLapsed,
    },
    auth,
    builderReady: shareLinkResolved && canStartBuilder(auth, completeness, accountComplete),
    builderSeed: builderSeedFor(auth, account, { name, pronouns }),
    location,
  };
}

export function useIdentityGate(): IdentityGate {
  const state = useGateState();
  const pending = useSyncExternalStore(subscribePending, getPending, getPending);
  return {
    shouldAsk: shouldAskForIdentity({ ...state.decision, actionPending: pending !== null }),
    builderReady: state.builderReady,
    contentReady: canShowPersonalizedContent(state.decision),
    builderSeed: state.builderSeed,
  };
}

/**
 * The one operation an in-page action calls (Phase 3): run `action` now if
 * the identity allows, otherwise hold it as the one pending action, which
 * opens the identity sheet even on a landing page, and run it exactly once
 * when the identity completes. Pages wrap their own handler's effect in it;
 * none of them decides whether to ask. An effect that needs a browser gesture
 * (clipboard, a window, the native share sheet) keeps its tap only when it
 * runs at once; when it has to wait, pass `afterAsking` to run instead, which
 * opens the menu or modal that holds it, so the gesture is the visitor's next
 * tap and never a delayed callback.
 */
export type AskBefore = (action: () => void, options?: { afterAsking?: () => void }) => void;

const askBefore: AskBefore = (action, options) => {
  if (!askSnapshot?.mustWait) {
    action();
    return;
  }
  setPendingAction({ run: options?.afterAsking ?? action, location: askSnapshot.location });
};

/** The operation, for a component: stable, and subscribes to nothing. */
export function useAskBefore(): AskBefore {
  return askBefore;
}

/**
 * An action that needs an account (vote, heart, posting a comment): signed
 * out, the visitor goes straight to sign-in without being asked (Phase 3,
 * P3-1, David 2026-11-04); signed in, it goes through `askBefore`, so an
 * account missing its name or pronouns is asked first.
 */
export function useAskBeforeSignedIn(): (signInHref: string, action: () => void) => void {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  return useCallback(
    (signInHref: string, action: () => void) => {
      if (!isAuthenticated) setLocation(signInHref);
      else askBefore(action);
    },
    [isAuthenticated, setLocation],
  );
}

/**
 * Runs the pending action exactly once when the identity completes, and drops
 * it when the visitor is no longer on the page they asked from. A failed
 * account save leaves the identity incomplete, so the action keeps waiting
 * for the sheet's retry. Mounted once.
 */
export function PendingActionRunner(): null {
  const state = useGateState();
  const pending = useSyncExternalStore(subscribePending, getPending, getPending);
  const wait = mustWaitForIdentity(state.decision);
  useLayoutEffect(() => {
    askSnapshot = { mustWait: wait, location: state.location };
  }, [wait, state.location]);
  useEffect(() => {
    if (!pending) return;
    if (pending.location !== state.location) {
      setPendingAction(null);
      return;
    }
    if (wait) return;
    setPendingAction(null);
    pending.run();
  }, [pending, state.location, wait]);
  return null;
}

/**
 * Settles this page load's share link once auth resolves: a signed-out visitor
 * keeps its halves, a signed-in account wins over them. Nothing from the link
 * is written before that, so a reload in between resolves the same way.
 * Mounted once.
 */
export function ShareLinkResolver(): null {
  const { isAuthenticated, isLoading } = useAuth();
  const { resolveShareLink } = usePersonName();
  useEffect(() => {
    if (!isLoading) resolveShareLink(isAuthenticated);
  }, [isLoading, isAuthenticated, resolveShareLink]);
  return null;
}
