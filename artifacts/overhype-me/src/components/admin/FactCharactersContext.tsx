/**
 * The fact's effective character list, provided once by the gags panel and
 * read by every bubble editor inside it — the gag card's and the one inside
 * "More art direction" — so both placements offer the same speakers
 * (PLAN_BUBBLE_SPEAKERS.md, C) without threading a prop through every card.
 */
import { createContext, useContext } from "react";
import type { FactCharacter } from "@workspace/api-zod";

const EMPTY: readonly FactCharacter[] = [];

export const FactCharactersContext = createContext<readonly FactCharacter[]>(EMPTY);

export function useFactCharacters(): readonly FactCharacter[] {
  return useContext(FactCharactersContext);
}
