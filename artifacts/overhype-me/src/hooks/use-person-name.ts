/**
 * @purpose The identity module (#719): owns the visitor's name and pronouns in localStorage, whether each was actually supplied, share-link application into empty halves, the sign-out clear, and the landing location the ask-decision reads; every identity read and write goes through this provider.
 * @subsystem public-site
 */

import { createContext, useCallback, useContext, useRef, useState, useEffect, ReactNode, createElement } from "react";
import { displayPronouns, DEFAULT_PRONOUNS } from "@/lib/pronouns";

const STORAGE_KEY_NAME     = "fact_db_name";
const STORAGE_KEY_PRONOUNS = "fact_db_pronouns";
const STORAGE_KEY_EXPLICIT = "fact_db_name_explicit"; // set when user intentionally sets their own identity
// Legacy keys — read-only for backward compat
const LEGACY_KEY_SUBJECT   = "fact_db_pronoun_subject";
const LEGACY_KEY_OBJECT    = "fact_db_pronoun_object";
const LEGACY_KEY_FIRST     = "fact_db_first_name";
const LEGACY_KEY_LAST      = "fact_db_last_name";

/**
 * Empty default — the app no longer ships with a seeded persona. The legacy
 * "David Franklin" string is kept for the one-time migration in
 * `resolveInitialIdentity`.
 */
export const DEFAULT_NAME = "";
const LEGACY_DEFAULT_NAME = "David Franklin";
export { DEFAULT_PRONOUNS };

// Derived for callers that still need individual parts
export const DEFAULT_PRONOUN_SUBJECT = "he";
export const DEFAULT_PRONOUN_OBJECT  = "him";

/** Storage access that never throws (private mode, blocked site data). */
export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function browserStorage(): SafeStorage {
  return {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };
}

export interface ResolvedIdentity {
  name: string;
  pronouns: string;
  /** Pronouns came from the visitor or a link, not the rendering fallback. */
  pronounsSupplied: boolean;
  /**
   * The halves this page load's share link filled in, held but not yet
   * written: whether they are the visitor's to keep depends on whether the
   * visitor is signed in, which is not known yet (#723).
   */
  pending: PendingLinkHalves;
}

export interface PendingLinkHalves {
  name: string | null;
  pronouns: string | null;
}

export const NO_PENDING_LINK: PendingLinkHalves = { name: null, pronouns: null };

/**
 * Reads the stored identity and fills whichever halves the browser does not
 * already hold from this page load's share-link parameters, in the returned
 * identity only. Nothing from the link is written here: the provider commits
 * it once auth resolves signed out, and drops it if signed in. Until then the
 * link stays in the address bar, so a reload resolves the same way.
 */
export function resolveInitialIdentity(
  storage: SafeStorage,
  urlName: string | null,
  urlPronouns: string | null,
): ResolvedIdentity {
  let storedName = storage.get(STORAGE_KEY_NAME);
  // One-time migration: clear the seeded placeholder unless the visitor chose it.
  if (storedName === LEGACY_DEFAULT_NAME && storage.get(STORAGE_KEY_EXPLICIT) !== "1") {
    storage.remove(STORAGE_KEY_NAME);
    storedName = null;
  }

  let storedPronouns = storage.get(STORAGE_KEY_PRONOUNS);
  if (!storedPronouns) {
    const sub = storage.get(LEGACY_KEY_SUBJECT);
    const obj = storage.get(LEGACY_KEY_OBJECT);
    if (sub || obj) {
      storedPronouns = `${sub || "he"}/${obj || "him"}`;
      storage.set(STORAGE_KEY_PRONOUNS, storedPronouns);
    }
  }

  const pending: PendingLinkHalves = { name: null, pronouns: null };

  let name = storedName?.trim() || "";
  const linkName = urlName?.trim();
  if (!name && linkName) {
    name = linkName;
    pending.name = linkName;
  }

  let pronouns = storedPronouns?.trim() || "";
  const linkPronouns = urlPronouns?.trim();
  if (!pronouns && linkPronouns) {
    pronouns = linkPronouns;
    pending.pronouns = linkPronouns;
  }

  return {
    name,
    pronouns: pronouns || DEFAULT_PRONOUNS,
    pronounsSupplied: !!pronouns,
    pending,
  };
}

/**
 * Writes the held link halves: the visitor turned out to be signed out, so they
 * are theirs. A half the browser holds by now (another tab saved it while this
 * one waited) is never overwritten, the same rule the link obeyed on load.
 */
export function commitLinkHalves(storage: SafeStorage, pending: PendingLinkHalves) {
  if (pending.name && !storage.get(STORAGE_KEY_NAME)?.trim()) storage.set(STORAGE_KEY_NAME, pending.name);
  if (pending.pronouns && !storage.get(STORAGE_KEY_PRONOUNS)?.trim()) storage.set(STORAGE_KEY_PRONOUNS, pending.pronouns);
}

/** The held link halves once another tab has written or cleared `key`: that half is no longer the link's to decide. */
export function dropPendingForKey(pending: PendingLinkHalves, key: string | null): PendingLinkHalves {
  if (key === STORAGE_KEY_NAME) return { ...pending, name: null };
  if (key === STORAGE_KEY_PRONOUNS) return { ...pending, pronouns: null };
  return pending;
}

/**
 * What an account's profile means for the browser copy: the name when it has
 * one, and pronouns only when it has some. An empty profile value is never
 * stored or counted as supplied; the rendering fallback stays a fallback.
 */
export function profileIdentity(name: string, pronouns: string): { name: string; pronouns: string | null } {
  return { name: name.trim(), pronouns: pronouns.trim() || null };
}

// ── This page load's share link and landing location ─────────────────────────
// Read once, synchronously, before any React rendering.
const _hasWindow    = typeof window !== "undefined";
const _urlParams    = new URLSearchParams(_hasWindow ? window.location.search : "");
const _URL_NAME     = _urlParams.get("displayName");
const _URL_PRONOUNS = _urlParams.get("pronouns");
const _SHARE_LINK   = !!(_URL_NAME || _URL_PRONOUNS);

/**
 * The path this page load landed on, relative to the router base like
 * wouter's `useLocation()`; the shared-content exception keys off it.
 */
export const LANDING_LOCATION = (() => {
  if (!_hasWindow) return "/";
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const path = window.location.pathname;
  return base && path.startsWith(base) ? path.slice(base.length) || "/" : path;
})();

/** Removes the share-link parameters from the address bar once applied. */
function stripShareParams() {
  if (!_SHARE_LINK || !_hasWindow) return;
  const params = new URLSearchParams(window.location.search);
  params.delete("displayName");
  params.delete("pronouns");
  const remaining = params.toString();
  const clean = remaining ? `${window.location.pathname}?${remaining}` : window.location.pathname;
  window.history.replaceState(window.history.state, "", clean);
}

/** Removes every stored identity key, legacy keys included. */
export function clearStoredIdentity(storage: SafeStorage) {
  for (const key of [
    STORAGE_KEY_NAME, STORAGE_KEY_PRONOUNS, STORAGE_KEY_EXPLICIT,
    LEGACY_KEY_SUBJECT, LEGACY_KEY_OBJECT, LEGACY_KEY_FIRST, LEGACY_KEY_LAST,
  ]) {
    storage.remove(key);
  }
}

const storage = browserStorage();

/** Records that the visitor set their own identity (the legacy-default migration reads it). */
function markExplicit() {
  storage.set(STORAGE_KEY_EXPLICIT, "1");
}

// ── Context ───────────────────────────────────────────────────────────────────

interface PersonNameContextValue {
  name:           string;
  pronouns:       string;  // full stored value: "he/him" or pipe-delimited custom
  pronounSubject: string;  // derived — for callers that only need subject
  pronounObject:  string;  // derived — for callers that only need object
  /** Pronouns were supplied by the visitor or a link, not the rendering fallback. */
  pronounsSupplied: boolean;
  setName:        (name: string) => void;
  setPronouns:    (pronouns: string) => void;
  /** Clear all stored identity data and reset to defaults (the sign-out clear). */
  reset:          () => void;
  /** Overwrite name+pronouns from an authenticated profile without marking explicit. */
  syncFromProfile: (name: string, pronouns: string) => void;
  /**
   * Settles this page load's share link once auth has resolved: signed out,
   * its held halves are written; signed in, they are dropped (the account
   * wins). Either way the parameters leave the address bar. Runs once.
   */
  resolveShareLink: (signedIn: boolean) => void;
  /** This page load's share link has been settled, so the identity is the visitor's, not the link's pending one. */
  shareLinkResolved: boolean;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  name:           DEFAULT_NAME,
  pronouns:       DEFAULT_PRONOUNS,
  pronounSubject: DEFAULT_PRONOUN_SUBJECT,
  pronounObject:  DEFAULT_PRONOUN_OBJECT,
  pronounsSupplied: false,
  setName:        () => {},
  setPronouns:    () => {},
  reset:          () => {},
  syncFromProfile: () => {},
  resolveShareLink: () => {},
  shareLinkResolved: true,
});

function splitSubjectObject(pronouns: string): { subject: string; object: string } {
  if (pronouns.includes("|")) {
    const parts = pronouns.split("|");
    return { subject: parts[0] || "he", object: parts[1] || "him" };
  }
  const slashIdx = pronouns.indexOf("/");
  if (slashIdx >= 0) {
    return { subject: pronouns.slice(0, slashIdx), object: pronouns.slice(slashIdx + 1) };
  }
  return { subject: pronouns, object: pronouns };
}

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => resolveInitialIdentity(storage, _URL_NAME, _URL_PRONOUNS));
  const [name,     setNameState]     = useState<string>(initial.name);
  const [pronouns, setPronounsState] = useState<string>(initial.pronouns);
  const [pronounsSupplied, setPronounsSupplied] = useState<boolean>(initial.pronounsSupplied);
  // Dropped half by half as the visitor or the account writes that half, and
  // cleared once resolved, so resolving never overrides a later choice and a
  // later sign-out never replays the link.
  const pendingRef = useRef<PendingLinkHalves>(initial.pending);
  const shareLinkResolvedRef = useRef(false);
  const [shareLinkResolved, setShareLinkResolved] = useState(false);

  const { subject, object } = splitSubjectObject(pronouns);


  function setName(value: string) {
    pendingRef.current = { ...pendingRef.current, name: null };
    const n = value.trim();
    if (n) {
      storage.set(STORAGE_KEY_NAME, n);
      markExplicit();
    } else {
      // Empty input clears identity entirely (back to cold visitor state).
      storage.remove(STORAGE_KEY_NAME);
      storage.remove(STORAGE_KEY_EXPLICIT);
    }
    storage.remove(LEGACY_KEY_FIRST);
    storage.remove(LEGACY_KEY_LAST);
    setNameState(n);
  }

  function setPronouns(value: string) {
    pendingRef.current = { ...pendingRef.current, pronouns: null };
    const v = value.trim() || DEFAULT_PRONOUNS;
    storage.set(STORAGE_KEY_PRONOUNS, v);
    markExplicit();
    setPronounsState(v);
    setPronounsSupplied(true);
  }

  function reset() {
    pendingRef.current = NO_PENDING_LINK;
    clearStoredIdentity(storage);
    setNameState(DEFAULT_NAME);
    setPronounsState(DEFAULT_PRONOUNS);
    setPronounsSupplied(false);
  }

  function syncFromProfile(newName: string, newPronouns: string) {
    const { name: n, pronouns: p } = profileIdentity(newName, newPronouns);
    pendingRef.current = NO_PENDING_LINK;
    if (n) {
      storage.set(STORAGE_KEY_NAME, n);
      markExplicit();
    }
    if (p) storage.set(STORAGE_KEY_PRONOUNS, p);
    else storage.remove(STORAGE_KEY_PRONOUNS);
    setNameState(n);
    setPronounsState(p ?? DEFAULT_PRONOUNS);
    setPronounsSupplied(!!p);
  }

  const resolveShareLink = useCallback((signedIn: boolean) => {
    if (shareLinkResolvedRef.current) return;
    shareLinkResolvedRef.current = true;
    const pending = pendingRef.current;
    pendingRef.current = NO_PENDING_LINK;
    if (!signedIn) {
      commitLinkHalves(storage, pending);
    } else {
      if (pending.name) setNameState(DEFAULT_NAME);
      if (pending.pronouns) {
        setPronounsState(DEFAULT_PRONOUNS);
        setPronounsSupplied(false);
      }
    }
    stripShareParams();
    setShareLinkResolved(true);
  }, []);

  // Another tab's save or clear reaches this tab, so an open sheet can close.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      pendingRef.current = dropPendingForKey(pendingRef.current, e.key);
      if (e.key === STORAGE_KEY_NAME) setNameState(e.newValue?.trim() || DEFAULT_NAME);
      if (e.key === STORAGE_KEY_PRONOUNS) {
        setPronounsState(e.newValue || DEFAULT_PRONOUNS);
        setPronounsSupplied(!!e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(
    PersonNameContext.Provider,
    {
      value: {
        name,
        pronouns,
        pronounSubject: subject,
        pronounObject:  object,
        pronounsSupplied,
        setName,
        setPronouns,
        reset,
        syncFromProfile,
        resolveShareLink,
        shareLinkResolved,
      },
    },
    children,
  );
}

export function usePersonName() {
  return useContext(PersonNameContext);
}

// Re-export for convenience in callers that just want the display string
export { displayPronouns };
