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
  /** Which halves this page load's share link filled in (and persisted). */
  fromLink: { name: boolean; pronouns: boolean };
}

/**
 * Reads the stored identity, applies this page load's share-link parameters
 * into whichever halves the browser does not already hold, and persists
 * exactly what it applied, so a reload resolves to the same identity.
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

  const fromLink = { name: false, pronouns: false };

  let name = storedName?.trim() || "";
  const linkName = urlName?.trim();
  if (!name && linkName) {
    name = linkName;
    storage.set(STORAGE_KEY_NAME, name);
    fromLink.name = true;
  }

  let pronouns = storedPronouns?.trim() || "";
  const linkPronouns = urlPronouns?.trim();
  if (!pronouns && linkPronouns) {
    pronouns = linkPronouns;
    storage.set(STORAGE_KEY_PRONOUNS, pronouns);
    fromLink.pronouns = true;
  }

  return {
    name,
    pronouns: pronouns || DEFAULT_PRONOUNS,
    pronounsSupplied: !!pronouns,
    fromLink,
  };
}

/** Removes from storage exactly the halves a share link filled in. */
export function discardLinkHalves(storage: SafeStorage, fromLink: ResolvedIdentity["fromLink"]) {
  if (fromLink.name) storage.remove(STORAGE_KEY_NAME);
  if (fromLink.pronouns) storage.remove(STORAGE_KEY_PRONOUNS);
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
  /** Takes back the halves this page load's share link filled in (a signed-in account wins). */
  discardShareLink: () => void;
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
  discardShareLink: () => {},
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
  // Cleared once used or once the visitor writes their own identity, so a
  // later discard can never take back something the visitor chose.
  const fromLinkRef = useRef(initial.fromLink);

  const { subject, object } = splitSubjectObject(pronouns);

  useEffect(() => { stripShareParams(); }, []);

  function setName(value: string) {
    fromLinkRef.current = { ...fromLinkRef.current, name: false };
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
    fromLinkRef.current = { ...fromLinkRef.current, pronouns: false };
    const v = value.trim() || DEFAULT_PRONOUNS;
    storage.set(STORAGE_KEY_PRONOUNS, v);
    markExplicit();
    setPronounsState(v);
    setPronounsSupplied(true);
  }

  function reset() {
    fromLinkRef.current = { name: false, pronouns: false };
    clearStoredIdentity(storage);
    setNameState(DEFAULT_NAME);
    setPronounsState(DEFAULT_PRONOUNS);
    setPronounsSupplied(false);
  }

  function syncFromProfile(newName: string, newPronouns: string) {
    const { name: n, pronouns: p } = profileIdentity(newName, newPronouns);
    fromLinkRef.current = { name: false, pronouns: false };
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

  const discardShareLink = useCallback(() => {
    const fromLink = fromLinkRef.current;
    if (!fromLink.name && !fromLink.pronouns) return;
    discardLinkHalves(storage, fromLink);
    if (fromLink.name) setNameState(DEFAULT_NAME);
    if (fromLink.pronouns) {
      setPronounsState(DEFAULT_PRONOUNS);
      setPronounsSupplied(false);
    }
    fromLinkRef.current = { name: false, pronouns: false };
  }, []);

  // Another tab's save or clear reaches this tab, so an open sheet can close.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
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
        discardShareLink,
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
