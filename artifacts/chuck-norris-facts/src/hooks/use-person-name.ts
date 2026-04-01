import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";

const STORAGE_KEY_FIRST = "fact_db_first_name";
const STORAGE_KEY_LAST  = "fact_db_last_name";

export const DEFAULT_FIRST = "Chuck";
export const DEFAULT_LAST  = "Norris";

interface PersonNameContextValue {
  firstName: string;
  lastName:  string;
  fullName:  string;
  setName:   (first: string, last: string) => void;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  firstName: DEFAULT_FIRST,
  lastName:  DEFAULT_LAST,
  fullName:  `${DEFAULT_FIRST} ${DEFAULT_LAST}`,
  setName:   () => {},
});

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const [firstName, setFirst] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY_FIRST) ?? DEFAULT_FIRST,
  );
  const [lastName, setLast] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY_LAST) ?? DEFAULT_LAST,
  );

  function setName(first: string, last: string) {
    const f = first.trim() || DEFAULT_FIRST;
    const l = last.trim()  || DEFAULT_LAST;
    localStorage.setItem(STORAGE_KEY_FIRST, f);
    localStorage.setItem(STORAGE_KEY_LAST,  l);
    setFirst(f);
    setLast(l);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_FIRST && e.newValue) setFirst(e.newValue);
      if (e.key === STORAGE_KEY_LAST  && e.newValue) setLast(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(
    PersonNameContext.Provider,
    { value: { firstName, lastName, fullName: `${firstName} ${lastName}`, setName } },
    children,
  );
}

export function usePersonName() {
  return useContext(PersonNameContext);
}
