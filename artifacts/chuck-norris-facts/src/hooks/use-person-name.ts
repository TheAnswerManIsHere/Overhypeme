import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";

const STORAGE_KEY = "fact_db_name";

export const DEFAULT_NAME = "David Franklin";

function getInitialName(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored || stored === "Chuck Norris" || stored === "Chuck" || stored === "Norris") {
    return DEFAULT_NAME;
  }
  // Migrate old split-key storage
  const oldFirst = localStorage.getItem("fact_db_first_name");
  const oldLast  = localStorage.getItem("fact_db_last_name");
  if (!stored && oldFirst && oldLast) {
    if (oldFirst === "Chuck" && oldLast === "Norris") return DEFAULT_NAME;
    return `${oldFirst} ${oldLast}`;
  }
  return stored;
}

interface PersonNameContextValue {
  name:    string;
  setName: (name: string) => void;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  name:    DEFAULT_NAME,
  setName: () => {},
});

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const [name, setNameState] = useState<string>(getInitialName);

  function setName(value: string) {
    const n = value.trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY, n);
    // Clear legacy split keys
    localStorage.removeItem("fact_db_first_name");
    localStorage.removeItem("fact_db_last_name");
    setNameState(n);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) setNameState(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(
    PersonNameContext.Provider,
    { value: { name, setName } },
    children,
  );
}

export function usePersonName() {
  return useContext(PersonNameContext);
}
