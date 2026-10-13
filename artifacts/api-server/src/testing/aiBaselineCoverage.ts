/**
 * What the AI baseline driver (`scripts/drive-ai-baseline.ts`) requires of a
 * review's render cards before it accepts their outcome; kept beside the other
 * test support so it can be unit-tested.
 */

/**
 * The review renders the baseline exists to cover (sub-plan D4: one Nano Banana
 * render per required scenario). Named here rather than read from the product's
 * list, so a change that narrows the required set breaks the journey instead of
 * shrinking what it checks (#654 round 3).
 */
export const BASELINE_RENDER_SCENARIOS = ["generic_t2i", "i2i_male_default", "i2i_female_default"] as const;

/** Why a review's render cards do not cover the baseline: an expected scenario is absent or not required. Empty when they do. */
export function renderCoverageProblems(cards: Array<{ key: string; required?: boolean }>): string[] {
  return BASELINE_RENDER_SCENARIOS.flatMap((key) => {
    const card = cards.find((c) => c.key === key);
    if (!card) return [`${key} is missing`];
    if (!card.required) return [`${key} is not required`];
    return [];
  });
}

/** The baseline's expected render cards, once each is present, required and terminal; null until then. */
export function settledBaselineRenders<T extends { key: string; required?: boolean; status: string }>(cards: T[]): T[] | null {
  if (renderCoverageProblems(cards).length > 0) return null;
  const expected = BASELINE_RENDER_SCENARIOS.map((key) => cards.find((c) => c.key === key)!);
  return expected.every((c) => ["done", "failed", "blocked"].includes(c.status)) ? expected : null;
}
