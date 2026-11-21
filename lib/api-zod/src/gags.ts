/**
 * A fact's gags: request bodies and the shape the admin gag routes return
 * (plan docs/plans/PLAN_THREE_GAGS.md; migration 0139). A gag is one way of
 * making a fact's joke visible, with its whole visual setup (a
 * `VisualPromptStrategyOverride`). A fact has one to three, in slots 1-3, and
 * every slot follows the same rules.
 */
import { z } from "zod";
import {
  BUBBLE_ENTITY_MAX_CHARS,
  BUBBLE_TEXT_MAX_CHARS,
  BUBBLE_TYPE_VALUES,
  MAX_BUBBLES,
  SCENE_RAW_MAX_CHARS,
  type GagCastEntry,
  type GagCastExtraction,
  type VisualPromptStrategyOverride,
} from "./visualStrategyOverride";
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

/** The kinds drawn once the gag works ("Render female and pet"). */
export const REST_KINDS: readonly GagExampleKind[] = GAG_EXAMPLE_KINDS.filter((k) => k !== ITERATION_KIND);

/** Each kind in words, capitalised. */
export const KIND_LABEL: Record<GagExampleKind, string> = { male: "Male", female: "Female", pet: "Pet" };

/** One value per kind, built from the kind list so a new kind is added in one place. */
export function mapKinds<T>(fn: (kind: GagExampleKind) => T): Record<GagExampleKind, T> {
  return Object.fromEntries(GAG_EXAMPLE_KINDS.map((k) => [k, fn(k)])) as Record<GagExampleKind, T>;
}

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

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

/**
 * Read who is in a draft's scene (plan PLAN_GAG_DIRECT_RENDER.md, F): the
 * scene and bubbles as the editor holds them, tokenized, before anything is
 * stored. The answer is the cast the save then carries.
 */
export const gagCastBodySchema = z.object({
  scene: z.string().min(1).max(SCENE_RAW_MAX_CHARS),
  bubbles: z.array(z.object({
    type: z.enum(BUBBLE_TYPE_VALUES).optional(),
    entity: z.string().max(BUBBLE_ENTITY_MAX_CHARS),
    text: z.string().max(BUBBLE_TEXT_MAX_CHARS),
  })).max(MAX_BUBBLES).default([]),
}).strict();
export type GagCastBody = z.infer<typeof gagCastBodySchema>;

/** The cast read from a draft, and the speakers its scene does not show. */
export interface GagCastView {
  cast: GagCastEntry[];
  castExtraction: GagCastExtraction;
  /** Bubble speakers the scene does not show: the draft cannot be saved until each is re-picked or the scene names them. */
  unboundSpeakers: string[];
}

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
 * Where a gag stands between the fact's two sets (migration 0157):
 * - `new`: in the draft only; nothing of it is published.
 * - `approved`: published, unchanged in the draft.
 * - `approved_with_change`: published, with a draft change (or removed in the
 *   draft) that members get only when the draft is published.
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
   * Approved before example sets (migration 0143, Q11): offered with fewer than
   * three examples until it first completes a set.
   */
  grandfathered: boolean;
  approvedAt: string | null;
  pendingContent: VisualPromptStrategyOverride | null;
  /** Draft picks for the content being worked on, per kind; they reach members only when the draft is published. */
  pendingExamples: PerKind<GagExample | null>;
  /** A published gag the draft removes: still offered until the draft is published. */
  draftRemoved: boolean;
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
  review: { id: number; stage: string } | null;
  gags: GagView[];
  maxGags: number;
  /**
   * The go-live rule on the fact's draft set (lib/gags/goLive.ts): whether
   * "Approve for production" (or, from Phase 3, "Publish changes") would be
   * accepted now, and if not, why in words.
   */
  draftReady: { ok: boolean; reason: string | null };
}

// ─── The fold and cast fill (plan PLAN_GAG_DIRECT_RENDER.md, E) ─────────────

export type GagFoldStage = "approved" | "pending";
/** nothing to fold · the fold would convert it · listed for a moderator · converted by an earlier run. */
export type GagFoldState = "nothing" | "would_convert" | "listed" | "already_converted";
/** extracted for the scene as it is · never read · read from an earlier scene · the reading failed or left a speaker unbound. */
export type GagCastState = "extracted" | "missing" | "stale" | "failed";

export interface GagFoldVersionReport {
  gagId: number;
  factId: number;
  slot: number;
  stage: GagFoldStage;
  fold: GagFoldState;
  cast: GagCastState;
  /** Why a moderator must convert it, or why its cast is missing. */
  reasons: string[];
  /** The latest job for this version, when one ran or is queued. */
  job: { status: string; error: string | null } | null;
}

/** The fold's report, which is also its dry run: computed from the gags as they are now, writing nothing. */
export interface GagFoldReport {
  versions: number;
  fold: Record<GagFoldState, number>;
  cast: Record<GagCastState, number>;
  jobs: { queued: number; running: number };
  /** Versions listed for a moderator: the fold will not convert them. Must be empty before the switch. */
  forModerator: GagFoldVersionReport[];
  /** Versions with no current cast. Must be empty before the switch. */
  castMissing: GagFoldVersionReport[];
}

export interface GagFoldStartResponse {
  requested: number;
  queued: number;
  deduped: number;
}
