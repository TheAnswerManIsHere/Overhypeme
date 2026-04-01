import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";

const STORAGE_KEY_NAME    = "fact_db_name";
const STORAGE_KEY_SUBJECT = "fact_db_pronoun_subject";
const STORAGE_KEY_OBJECT  = "fact_db_pronoun_object";
const LEGACY_KEY_PRONOUNS = "fact_db_pronouns";

export const DEFAULT_NAME           = "David Franklin";
export const DEFAULT_PRONOUN_SUBJECT = "he";
export const DEFAULT_PRONOUN_OBJECT  = "him";

function getInitialName(): string {
  const stored = localStorage.getItem(STORAGE_KEY_NAME);
  if (!stored || stored === "Chuck Norris" || stored === "Chuck" || stored === "Norris") {
    return DEFAULT_NAME;
  }
  return stored;
}

function getInitialSubject(): string {
  const stored = localStorage.getItem(STORAGE_KEY_SUBJECT);
  if (stored) return stored;
  const legacy = localStorage.getItem(LEGACY_KEY_PRONOUNS);
  if (legacy) {
    const part = legacy.split("/")[0];
    if (part) return part;
  }
  return DEFAULT_PRONOUN_SUBJECT;
}

function getInitialObject(): string {
  const stored = localStorage.getItem(STORAGE_KEY_OBJECT);
  if (stored) return stored;
  const legacy = localStorage.getItem(LEGACY_KEY_PRONOUNS);
  if (legacy) {
    const part = legacy.split("/")[1];
    if (part) return part;
  }
  return DEFAULT_PRONOUN_OBJECT;
}

interface PersonNameContextValue {
  name:           string;
  pronounSubject: string;
  pronounObject:  string;
  setName:        (name: string) => void;
  setPronouns:    (subject: string, object: string) => void;
}

const PersonNameContext = createContext<PersonNameContextValue>({
  name:           DEFAULT_NAME,
  pronounSubject: DEFAULT_PRONOUN_SUBJECT,
  pronounObject:  DEFAULT_PRONOUN_OBJECT,
  setName:        () => {},
  setPronouns:    () => {},
});

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const [name,           setNameState]    = useState<string>(getInitialName);
  const [pronounSubject, setSubjectState] = useState<string>(getInitialSubject);
  const [pronounObject,  setObjectState]  = useState<string>(getInitialObject);

  function setName(value: string) {
    const n = value.trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY_NAME, n);
    localStorage.removeItem("fact_db_first_name");
    localStorage.removeItem("fact_db_last_name");
    setNameState(n);
  }

  function setPronouns(subject: string, object: string) {
    const sub = subject.trim() || DEFAULT_PRONOUN_SUBJECT;
    const obj = object.trim()  || DEFAULT_PRONOUN_OBJECT;
    localStorage.setItem(STORAGE_KEY_SUBJECT, sub);
    localStorage.setItem(STORAGE_KEY_OBJECT,  obj);
    setSubjectState(sub);
    setObjectState(obj);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_NAME    && e.newValue) setNameState(e.newValue);
      if (e.key === STORAGE_KEY_SUBJECT && e.newValue) setSubjectState(e.newValue);
      if (e.key === STORAGE_KEY_OBJECT  && e.newValue) setObjectState(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(
    PersonNameContext.Provider,
    { value: { name, pronounSubject, pronounObject, setName, setPronouns } },
    children,
  );
}

export function usePersonName() {
  return useContext(PersonNameContext);
}
