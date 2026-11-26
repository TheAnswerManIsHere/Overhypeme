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
   * The gag is still exactly the gag idea it was filled from (lib/gags/prefill.ts):
   * a change to it the moderator did not make. The editor keeps unsaved typing
   * over such a change rather than discarding it (Codex 4649903945, PR #1136).
   */
  prefilledUntouched: boolean;
  /**
   * Each picture's roles (Issue #1304, D1): its official renders and its
   * working render. They replaced the content-matched `renders` tiles when
   * the views moved to them (increment C).
   */
  roles: PerKind<GagPictureRoles>;
  /**
   * The one-line descriptions of the published and the draft content (plan
   * PLAN_PHASE7_AI_PICTURE_FLOW.md; api-server lib/gags/descriptions.ts).
   */
  descriptions: GagDescriptions;
}

/** A description of one version of a gag, as a moderator sees it. */
export interface GagDescriptionView {
  /** The version it describes; sent back when saving, so a changed gag is caught. */
  contentFingerprint: string;
  /** The line, with personalization tokens; null until drafted. */
  text: string | null;
  origin: "ai" | "moderator";
  /** Reviewed by a moderator: members see it once it describes the published content. */
  reviewed: boolean;
  /** "drafting" while one is being drafted; "failed" when the last drafting failed. */
  drafting: "none" | "drafting" | "failed";
  lastError: string | null;
}

export interface GagDescriptions {
  /** Null when the gag has no published content. */
  published: GagDescriptionView | null;
  /** Null when the draft content is the published content, or there is no draft. */
  draft: GagDescriptionView | null;
  /** A moderator's text for an earlier version of this gag, offered as a starting point; never applied. */
  earlierText: string | null;
}

// ─── A gag's renders: roles, history, cost, delete (Issue #1304) ───────────
// Plan docs/plans/PLAN_RENDER_HISTORY.md D1, D4, D5 and D6.

/**
 * The roles a render can hold for its picture (D1), each computed from
 * existing records, never stored:
 * - `live`: the gag's published pick for that picture;
 * - `approved_next`: the draft pick, when it differs from the published one;
 * - `working`: the newest render of that picture for this gag, whatever its
 *   content or status.
 * One render can hold several.
 */
export type RenderRole = "live" | "approved_next" | "working";

/** One picture's roles: the official renders, and the working render with its status. */
export interface GagPictureRoles {
  live: GagExample | null;
  /** The draft pick when it differs from the published one. */
  approvedNext: GagExample | null;
  /** The newest render of this picture; `stale` when it was drawn from an earlier version of the gag. */
  working: RenderScenarioCard | null;
}

/** Whether a render was ever approved (D4; David, Q51). */
export type RenderApproval =
  /** It is, or was, a pick: a current pick, a retained pick on the gag, or an approval record naming it. */
  | "approved"
  /** No such evidence, and drawn before every approval was recorded with its pick. */
  | "not_recorded"
  /** No such evidence, drawn after that guarantee began. */
  | "not_approved";

/**
 * What fal billed for a render (D5), summed over the requests it made (a
 * retry or a fallback makes several). Read from stored bills; viewing makes no
 * fal call.
 */
export type RenderCost =
  /**
   * Some or all of its requests have a bill: the known amount, how many sent
   * requests have none yet, and how many requests fal may or may not have
   * received (no fal id on record, and not refused at submission). The amount
   * is the whole cost only when both counts are zero.
   */
  | { state: "billed"; usd: number; unbilledRequests: number; unknownRequests: number }
  /** No bill yet, and at least one request has not been looked up. */
  | { state: "not_checked" }
  /** Every request was looked up in a window covering it, and fal had no bill. */
  | { state: "no_bill_found" }
  /** The billing-read key is not set, so nothing is looked up. */
  | { state: "billing_key_not_set" }
  /**
   * Whether fal received it is not on record: its requests carry no fal id and
   * were not refused at submission, or it has a picture and no request records
   * (drawn before requests were recorded). Never guessed (intent 5).
   */
  | { state: "not_recorded" }
  /** It never reached fal, so nothing was charged: refused at submission, or failed before any request. */
  | { state: "never_sent" };

/** The exact input one request sent to the engine. */
export interface RenderRequestRecord {
  id: number;
  endpointId: string;
  engineId: string | null;
  createdAt: string;
  /** The input object exactly as submitted. */
  request: unknown;
  billedUsd: number | null;
}

/** One render in a gag's history, with the full record of how it was made (D4). */
export interface RenderHistoryEntry {
  attemptId: number;
  /** The picture it drew (male, female, pet); null for a render of no example kind. */
  kind: GagExampleKind | null;
  createdAt: string;
  /** The admin who asked for it, named as History names admins. */
  drawnBy: { userId: string | null; name: string | null };
  /** The roles it holds now (D1). */
  roles: RenderRole[];
  status: RenderScenarioCard["status"];
  /** Why it failed, in words; null unless failed or blocked. */
  error: string | null;
  imageUrl: string | null;
  /** The gag as it was drawn: its scene and bubbles, from the render's frozen content. */
  gag: VisualPromptStrategyOverride | null;
  /** The reference photo: its identity type and asset version. */
  reference: { identityType: string | null; assetVersion: string | null };
  /** The engine that drew it, and the fallback when one happened. */
  engine: { engineId: string | null; fallback: { refusedEngineId: string; reason: string; drawnByEngineId: string } | null };
  /** The compiled prompt, and every request sent to the engine, exactly as sent. */
  prompt: { compiled: unknown; requests: RenderRequestRecord[] };
  approval: RenderApproval;
  cost: RenderCost;
}

/** A page of a gag's history, newest first (50 at a time); `nextBefore` reads the next older page, null at the end. */
export interface RenderHistoryPage {
  gagId: number;
  entries: RenderHistoryEntry[];
  nextBefore: string | null;
}

/** A removed gag that still has renders: its history, grouped by the gag's own id, never its slot. */
export interface RemovedGagHistory {
  gagId: number;
  renders: number;
  lastRenderAt: string;
}

export const gagRenderDeleteBodySchema = z.object(reviewScope).strict();
export type GagRenderDeleteBody = z.infer<typeof gagRenderDeleteBodySchema>;

/** A delete's answer: the row is gone; its picture file may still be on its way out (the cleanup list). */
export interface GagRenderDeleteResult {
  deleted: true;
  /** True while the cleanup list still holds its file: "Deleted; its picture file is still being removed". */
  fileStillBeingRemoved: boolean;
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
  /**
   * The gags are about to be filled from the fact's gag ideas (gag 1 from the
   * first idea, or untouched pre-filled gags after a changed note;
   * lib/gags/prefill.ts). The screen shows it and polls until it lands.
   */
  filling: boolean;
  /** The latest fill from the gag ideas failed for good, and the gags still wait for it: use an idea, or write the gag. */
  fillFailed: boolean;
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
