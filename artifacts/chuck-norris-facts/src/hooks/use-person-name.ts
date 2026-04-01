import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";
import type { PronounSet } from "@/lib/render-fact";

const STORAGE_KEY_NAME     = "fact_db_name";
const STORAGE_KEY_PRONOUNS = "fact_db_pronouns";

export const DEFAULT_NAME     = "David Franklin";
export const DEFAULT_PRONOUNS: PronounSet = "he/him";

function getInitialName(): string {
  const stored = localStorage.getItem(STORAGE_KEY_NAME);
  if (!stored || stored === "Chuck Norris" || stored === "Chuck" || stored === "Norris") {
    return DEFAULT_NAME;
  }
  return stored;
}

function getInitialPronouns(): PronounSet {
  const stored = localStorage.getItem(STORAGE_KEY_PRONOUNS) as PronounSet | null;
  if (stored === "he/him" || stored === "she/her" || stored === "they/them") return stored;
  return DEFAULT_PRONOUNS;
}

interface PersonNameContextValue {
  name:        string;
  pronouns:    PronounSet;
  setName:     (name: string) => void;
  setPronouns: (pronouns: PronounSet) => void;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  name:        DEFAULT_NAME,
  pronouns:    DEFAULT_PRONOUNS,
  setName:     () => {},
  setPronouns: () => {},
});

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const [name,     setNameState]     = useState<string>(getInitialName);
  const [pronouns, setPronounsState] = useState<PronounSet>(getInitialPronouns);

  function setName(value: string) {
    const n = value.trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY_NAME, n);
    localStorage.removeItem("fact_db_first_name");
    localStorage.removeItem("fact_db_last_name");
    setNameState(n);
  }

  function setPronouns(value: PronounSet) {
    localStorage.setItem(STORAGE_KEY_PRONOUNS, value);
    setPronounsState(value);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_NAME     && e.newValue) setNameState(e.newValue);
      if (e.key === STORAGE_KEY_PRONOUNS && e.newValue) setPronounsState(e.newValue as PronounSet);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(
    PersonNameContext.Provider,
    { value: { name, pronouns, setName, setPronouns } },
    children,
  );
}

export function usePersonName() {
  return useContext(PersonNameContext);
}
