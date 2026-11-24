/**
 * Word-boundary helpers used by the split slider.
 *
 * Lifted verbatim from the original `MemeBuilder.tsx` so the wizard's split
 * defaults match the legacy builder when `fact.split_token_index` is absent.
 * The fact-creation pipeline will populate `split_token_index` server-side
 * (MBFO follow-up), at which point this fallback only fires for legacy facts.
 */

export function getWords(factText: string): string[] {
  return factText.split(/\s+/).filter(w => w.length > 0);
}

/**
 * Picks a sensible default split index by walking outward from the middle and
 * preferring breaks after sentence-ish punctuation (`, . - ! ? ; : — –`).
 */
export function intelligentSplit(factText: string): number {
  const words = getWords(factText);
  if (words.length <= 2) return words.length;
  const mid = Math.ceil(words.length / 2);
  for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
    const idx = mid + delta;
    if (idx > 0 && idx < words.length) {
      const word = words[idx - 1];
      if (/[,.\-!?;:—–]$/.test(word ?? "")) return idx;
    }
  }
  return mid;
}
