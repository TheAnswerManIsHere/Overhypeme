export interface PronounPair {
  value: string;
  label: string;
}

export const PRONOUN_PAIRS: PronounPair[] = [
  { value: "he/him",    label: "he/him" },
  { value: "she/her",   label: "she/her" },
  { value: "they/them", label: "they/them" },
  { value: "ze/zir",    label: "ze/zir" },
  { value: "ze/hir",    label: "ze/hir" },
  { value: "xe/xem",    label: "xe/xem" },
  { value: "ey/em",     label: "ey/em" },
  { value: "fae/faer",  label: "fae/faer" },
  { value: "it/its",    label: "it/its" },
  { value: "any",       label: "any pronouns" },
];

export function isKnownPronounPair(value: string): boolean {
  return PRONOUN_PAIRS.some((p) => p.value === value);
}
