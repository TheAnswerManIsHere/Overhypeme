/**
 * A fact's gags: request bodies and the shape the admin gag routes return
 * (plan docs/plans/PLAN_THREE_GAGS.md; migration 0139). A gag is one way of
 * making a fact's joke visible, with its whole visual setup (a
 * `VisualPromptStrategyOverride`). A fact has one to three, in slots 1-3, and
 * every slot follows the same rules.
 */
import { z } from "zod";
import type { VisualPromptStrategyOverride } from "./visualStrategyOverride";
import type { RenderScenarioCard, RenderScenarioKey } from "./renderScenarios";

/**
 * The subject kinds a gag is shown with, one committed reference photo each
 * (plan docs/plans/PLAN_GAG_EXAMPLES.md; David, 2026-11-15, Q8): a gag needs
 * an approved example of each before it is offered.
 */
export const GAG_EXAMPLE_KINDS = ["male", "female", "pet"] as const;
export type GagExampleKind = (typeof GAG_EXAMPLE_KINDS)[number];
export const gagExampleKindSchema = z.enum(GAG_EXAMPLE_KINDS);

/** The render scenario that draws each kind. */
export const SCENARIO_FOR_KIND: Record<GagExampleKind, RenderScenarioKey> = {
  male: "i2i_male_default",
  female: "i2i_female_default",
  pet: "i2i_nonhuman_animal",
};

/** The kind a render scenario draws, or null for a scenario that is not a kind. */
export function kindForScenario(key: string | null | undefined): GagExampleKind | null {
  for (const kind of GAG_EXAMPLE_KINDS) if (SCENARIO_FOR_KIND[kind] === key) return kind;
  return null;
}

/** The iteration render: the one kind drawn when a gag's content changes. */
export const ITERATION_KIND: GagExampleKind = "male";

/** The most gags a fact can have. */
export const MAX_GAGS_PER_FACT = 3;

/** The open review an action comes from; a live fact's Facts editor sends none. */
const reviewScope = { reviewId: z.number().int().positive().optional() };

export const gagCreateBodySchema = z.object({
  content: z.unknown(),
  slot: z.number().int().min(1).max(MAX_GAGS_PER_FACT).optional(),
  ...reviewScope,
}).strict();
export type GagCreateBody = z.infer<typeof gagCreateBodySchema>;

export const gagSaveBodySchema = z.object({ content: z.unknown(), ...reviewScope }).strict();
export type GagSaveBody = z.infer<typeof gagSaveBodySchema>;

export const gagScopeBodySchema = z.object(reviewScope).strict();
export type GagScopeBody = z.infer<typeof gagScopeBodySchema>;

export const gagRendersBodySchema = z.object({
  /** The kinds to draw for the gag's current content. */
  kinds: z.array(gagExampleKindSchema).min(1),
  /**
   * Draw again even when a render of this content already exists for a kind:
   * the moderator's explicit redraw. Without it, an existing render is reused.
   */
  redraw: z.boolean().optional(),
  ...reviewScope,
}).strict();
export type GagRendersBody = z.infer<typeof gagRendersBodySchema>;

export const gagApproveBodySchema = z.object({ attemptId: z.number().int().positive(), ...reviewScope }).strict();
export type GagApproveBody = z.infer<typeof gagApproveBodySchema>;

/**
 * A gag's state for moderators, in words:
 * - `new`: saved, never approved; hidden from users.
 * - `approved`: approved and, on a live fact, offered to users.
 * - `approved_with_change`: approved, with a saved change not yet approved; users get the approved version.
 */
export type GagState = "new" | "approved" | "approved_with_change";

export interface GagExample {
  attemptId: number;
  /** Admin-gated image URL; null when the image is not available. */
  imageUrl: string | null;
}

/** One value per subject kind. */
export type PerKind<T> = Record<GagExampleKind, T>;

export interface GagView {
  id: number;
  slot: number;
  state: GagState;
  /** Whether a user could be offered this gag now: approved, on a live fact. */
  availableToUsers: boolean;
  /** The lowest-slot available gag: what users get with no picker. */
  isDefault: boolean;
  approvedContent: VisualPromptStrategyOverride | null;
  /** The approved version's examples, per kind (all three unless grandfathered). */
  approvedExamples: PerKind<GagExample | null>;
  /**
   * Approved before example sets (migration 0142, Q11): offered with fewer than
   * three examples until it first completes a set.
   */
  grandfathered: boolean;
  approvedAt: string | null;
  pendingContent: VisualPromptStrategyOverride | null;
  /** Inside a refresh: the review that owns the pending picks or removal. */
  pendingReviewId: number | null;
  /**
   * Picks for the content being worked on, per kind. Outside a refresh the
   * third pick applies the change; inside one, the picks apply at promotion.
   */
  pendingExamples: PerKind<GagExample | null>;
  /** Inside a refresh: removal requested, landing at promotion. */
  pendingRemove: boolean;
  /** The approved version predates the fact's latest refresh (shown as a note; never hides the gag). */
  refreshedSinceApproval: boolean;
  /**
   * This gag's render of its current content, per kind: the attempt the
   * scheduler reused or drew for that content (null when none was drawn).
   * Renders of other content are history and are not listed.
   */
  renders: PerKind<RenderScenarioCard | null>;
}

export interface FactGagsView {
  factId: number;
  isActive: boolean;
  /** The fact's open review, if any. */
  review: { id: number; stage: string; refresh: boolean } | null;
  /** True when a refresh is open: gags are edited only in its review. */
  frozenOutsideReview: boolean;
  gags: GagView[];
  maxGags: number;
}
