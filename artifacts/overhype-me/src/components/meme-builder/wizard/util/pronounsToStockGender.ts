/**
 * Maps a pronoun string to the gender key used by `facts.pexels_images`.
 *
 *   he/*   → "male"
 *   she/*  → "female"
 *   anything else (they/them, custom pronouns, undefined) → "neutral"
 *
 * Mirrors the server-side mapping in `routes/memes.ts` so the client default
 * fetches the same bucket the server would generate AI images for.
 */
export type StockGender = "male" | "female" | "neutral";

export function pronounsToStockGender(pronouns: string | null | undefined): StockGender {
  if (!pronouns) return "neutral";
  const subj = pronouns.toLowerCase().trim().split("/")[0]?.trim() ?? "";
  if (subj === "he") return "male";
  if (subj === "she") return "female";
  return "neutral";
}
