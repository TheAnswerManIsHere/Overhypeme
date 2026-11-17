/**
 * What the AI baseline driver (`src/testing/acceptance/driver.ts`) requires of a
 * gag's render tiles before it accepts their outcome; kept beside the other
 * test support so it can be unit-tested.
 */

/**
 * The renders the baseline exists to cover: a gag's three subject kinds, each
 * approved as one of its examples (plan docs/plans/PLAN_GAG_EXAMPLES.md). Named
 * here rather than read from the product's list, so a change that narrows the
 * set breaks the journey instead of shrinking what it checks (#654 round 3).
 */
export const BASELINE_RENDER_KINDS = ["male", "female", "pet"] as const;
export type BaselineKind = (typeof BASELINE_RENDER_KINDS)[number];

type Tiles<T> = Partial<Record<BaselineKind, T | null>>;

/** Why a gag's render tiles do not cover these kinds: a kind has no render yet. Empty when they do. */
export function renderCoverageProblems<T extends { status: string }>(renders: Tiles<T>, kinds: readonly BaselineKind[] = BASELINE_RENDER_KINDS): string[] {
  return kinds.flatMap((kind) => (renders[kind] && renders[kind]!.status !== "missing" ? [] : [`${kind} is missing`]));
}

/** The kinds' render tiles, once each is present and terminal; null until then. */
export function settledBaselineRenders<T extends { status: string }>(
  renders: Tiles<T>,
  kinds: readonly BaselineKind[] = BASELINE_RENDER_KINDS,
): Array<T & { kind: BaselineKind }> | null {
  if (renderCoverageProblems(renders, kinds).length > 0) return null;
  const tiles = kinds.map((kind) => ({ ...renders[kind]!, kind }));
  return tiles.every((c) => ["done", "failed", "blocked"].includes(c.status)) ? tiles : null;
}
