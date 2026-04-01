import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";
import { displayPronouns, DEFAULT_PRONOUNS } from "@/lib/pronouns";

const STORAGE_KEY_NAME    = "fact_db_name";
const STORAGE_KEY_PRONOUNS = "fact_db_pronouns";
// Legacy keys — read-only for backward compat
const LEGACY_KEY_SUBJECT  = "fact_db_pronoun_subject";
const LEGACY_KEY_OBJECT   = "fact_db_pronoun_object";

export const DEFAULT_NAME = "David Franklin";
export { DEFAULT_PRONOUNS };

// Derived for callers that still need individual parts
export const DEFAULT_PRONOUN_SUBJECT = "he";
export const DEFAULT_PRONOUN_OBJECT  = "him";

function getInitialName(): string {
  return localStorage.getItem(STORAGE_KEY_NAME) || DEFAULT_NAME;
}

function getInitialPronouns(): string {
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

  function setName(value: string) {
    const n = value.trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY_NAME, n);
    localStorage.removeItem("fact_db_first_name");
    localStorage.removeItem("fact_db_last_name");
    setNameState(n);
  }

  function setPronouns(value: string) {
    const v = value.trim() || DEFAULT_PRONOUNS;
    localStorage.setItem(STORAGE_KEY_PRONOUNS, v);
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
