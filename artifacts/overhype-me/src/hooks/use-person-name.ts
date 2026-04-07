import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";
import { displayPronouns, DEFAULT_PRONOUNS } from "@/lib/pronouns";

const STORAGE_KEY_NAME     = "fact_db_name";
const STORAGE_KEY_PRONOUNS = "fact_db_pronouns";
const STORAGE_KEY_EXPLICIT = "fact_db_name_explicit"; // set when user intentionally sets their own identity
// Legacy keys — read-only for backward compat
const LEGACY_KEY_SUBJECT   = "fact_db_pronoun_subject";
const LEGACY_KEY_OBJECT    = "fact_db_pronoun_object";

export const DEFAULT_NAME = "David Franklin";
export { DEFAULT_PRONOUNS };

// Derived for callers that still need individual parts
export const DEFAULT_PRONOUN_SUBJECT = "he";
export const DEFAULT_PRONOUN_OBJECT  = "him";

// ── Read share-link URL params at module load time ────────────────────────────
// This runs synchronously before any React rendering, so the initial state
// is already correct on the very first render.
const _urlParams    = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
const _URL_NAME     = _urlParams.get("displayName");
const _URL_PRONOUNS = _urlParams.get("pronouns");

/**
 * True when this page load included share-link personalisation params.
 */
export const SHARE_LINK_ACTIVE = !!(_URL_NAME || _URL_PRONOUNS);

// ── Explicit-flag helpers ─────────────────────────────────────────────────────

/**
 * Returns true if the user has deliberately set their own name/pronouns
 * (via the NameTag editor, registration, or auth profile sync).
 * When true, share-link URL params are ignored — the user's own identity wins.
 */
function isUserExplicit(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_EXPLICIT) === "1";
  } catch {
    return false;
  }
}

function markExplicit() {
  try {
    localStorage.setItem(STORAGE_KEY_EXPLICIT, "1");
  } catch { /* ignore */ }
}

// ── Initial-state helpers ─────────────────────────────────────────────────────

function getInitialName(): string {
  const stored = localStorage.getItem(STORAGE_KEY_NAME);

  // URL param wins only when:
  //   • a share link is active
  //   • AND the user has NOT explicitly set their own name
  //   • AND they have no stored name (or only the default placeholder)
  if (_URL_NAME && !isUserExplicit() && (!stored || stored === DEFAULT_NAME)) {
    return _URL_NAME;
  }

  return stored || DEFAULT_NAME;
}

function getInitialPronouns(): string {
  // URL param wins under the same conditions as name
  if (_URL_PRONOUNS && !isUserExplicit()) {
    const stored = localStorage.getItem(STORAGE_KEY_PRONOUNS);
    if (!stored) return _URL_PRONOUNS;
  }

  // New unified key
  const stored = localStorage.getItem(STORAGE_KEY_PRONOUNS);
  if (stored) return stored;

  // Migrate from legacy subject/object keys
  const sub = localStorage.getItem(LEGACY_KEY_SUBJECT);
  const obj = localStorage.getItem(LEGACY_KEY_OBJECT);
  if (sub || obj) {
    const migrated = `${sub || "he"}/${obj || "him"}`;
    localStorage.setItem(STORAGE_KEY_PRONOUNS, migrated);
    return migrated;
  }

  return DEFAULT_PRONOUNS;
}

// ── Context ───────────────────────────────────────────────────────────────────

interface PersonNameContextValue {
  name:           string;
  pronouns:       string;  // full stored value: "he/him" or pipe-delimited custom
  pronounSubject: string;  // derived — for callers that only need subject
  pronounObject:  string;  // derived — for callers that only need object
  setName:        (name: string) => void;
  setPronouns:    (pronouns: string) => void;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  name:           DEFAULT_NAME,
  pronouns:       DEFAULT_PRONOUNS,
  pronounSubject: DEFAULT_PRONOUN_SUBJECT,
  pronounObject:  DEFAULT_PRONOUN_OBJECT,
  setName:        () => {},
  setPronouns:    () => {},
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
  const [name,     setNameState]     = useState<string>(getInitialName);
  const [pronouns, setPronounsState] = useState<string>(getInitialPronouns);

  const { subject, object } = splitSubjectObject(pronouns);

  // Persist URL-param values to localStorage so they survive URL cleanup,
  // but only when the user hasn't set their own explicit identity.
  useEffect(() => {
    if (!SHARE_LINK_ACTIVE || isUserExplicit()) return;
    if (_URL_NAME)     localStorage.setItem(STORAGE_KEY_NAME, _URL_NAME);
    if (_URL_PRONOUNS) localStorage.setItem(STORAGE_KEY_PRONOUNS, _URL_PRONOUNS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setName(value: string) {
    const n = value.trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY_NAME, n);
    localStorage.removeItem("fact_db_first_name");
    localStorage.removeItem("fact_db_last_name");
    markExplicit();
    setNameState(n);
  }

  function setPronouns(value: string) {
    const v = value.trim() || DEFAULT_PRONOUNS;
    localStorage.setItem(STORAGE_KEY_PRONOUNS, v);
    markExplicit();
    setPronounsState(v);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_NAME     && e.newValue) setNameState(e.newValue);
      if (e.key === STORAGE_KEY_PRONOUNS && e.newValue) setPronounsState(e.newValue);
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
        setName,
        setPronouns,
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
