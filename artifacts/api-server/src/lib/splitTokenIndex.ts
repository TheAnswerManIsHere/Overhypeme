/**
 * Picks a sensible default word-split index for a fact template.
 *
 * The split index is the number of words that go into the *top* text block
 * in the Step-2 image wizard. A value of `k` means words [0..k) → top,
 * words [k..n) → bottom.
 *
 * Strategy: start from the middle, then walk outward ±3 words to prefer a
 * break that lands after sentence-ending punctuation (comma, dash, period,
 * etc.). Falls back to the exact midpoint when no punctuation break is found.
 *
 * This mirrors the client-side `intelligentSplit` in
 * `overhype-me/src/components/meme-builder/wizard/step2-image/sliders/splitLogic.ts`
 * but is kept server-side so the value can be persisted on the facts row at
 * insert time and served back to the wizard without client-side computation.
 */
export function computeSplitTokenIndex(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= 2) return words.length;

  const mid = Math.ceil(words.length / 2);

  for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
    const idx = mid + delta;
    if (idx > 0 && idx < words.length) {
      const word = words[idx - 1] ?? "";
      if (/[,.\-!?;:—–]$/.test(word)) return idx;
    }
  }

  return mid;
}
