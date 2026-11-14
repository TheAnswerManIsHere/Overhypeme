/**
 * A fact's gags: request bodies and the shape the admin gag routes return
 * (plan docs/plans/PLAN_THREE_GAGS.md; migration 0139). A gag is one way of
 * making a fact's joke visible, with its whole visual setup (a
 * `VisualPromptStrategyOverride`). A fact has one to three, in slots 1-3, and
 * every slot follows the same rules.
 */
import { z } from "zod";
import type { VisualPromptStrategyOverride } from "./visualStrategyOverride";
import type { RenderScenarioGrid } from "./renderScenarios";
import { renderScenarioKeySchema } from "./renderScenarios";

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
  /** Named scenarios to rerun; omitted runs the default batch. */
  scenarios: z.array(renderScenarioKeySchema).min(1).optional(),
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

export interface GagView {
  id: number;
  slot: number;
  state: GagState;
  /** Whether a user could be offered this gag now: approved, on a live fact. */
  availableToUsers: boolean;
  /** The lowest-slot available gag: what users get with no picker. */
  isDefault: boolean;
  approvedContent: VisualPromptStrategyOverride | null;
  approvedExample: GagExample | null;
  /** An approved version carried over by migration 0139 with no example on record. */
  carriedOver: boolean;
  approvedAt: string | null;
  pendingContent: VisualPromptStrategyOverride | null;
  /** Inside a refresh: the review that owns the pending pick or removal. */
  pendingReviewId: number | null;
  /** Inside a refresh: the render picked as the change's example, landing at promotion. */
  pendingExample: GagExample | null;
  /** Inside a refresh: removal requested, landing at promotion. */
  pendingRemove: boolean;
  /** The approved version predates the fact's latest refresh (shown as a note; never hides the gag). */
  refreshedSinceApproval: boolean;
  /** This gag's test renders (latest per scenario). */
  renders: RenderScenarioGrid;
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
