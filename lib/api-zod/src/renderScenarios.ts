/**
 * Moderation render-scenario vocabulary — SHARED between the api-server (policy,
 * hashing, orchestration in `factRenderScenarios.ts`) and the admin frontend
 * (the Step-2 visual-review grid). This module is pure types/enums + static
 * descriptor data + the waiver wire schema — NO logic, NO crypto, NO DB. Keeping
 * the descriptors here (rather than only behind the API) means the frontend and
 * server share one source of truth and can't drift.
 *
 * A "scenario" is one default test render the moderator reviews in Step 2:
 *   - generic_t2i               RETIRED: no reference photo. Every picture now
 *                               starts from a photo; the key stays so its stored
 *                               renders still read.
 *   - i2i_male_default          image-to-image with the default male reference
 *   - i2i_female_default        image-to-image with the default female reference
 *   - i2i_nonhuman_animal       image-to-image with the default pet reference
 *
 * The three kinds a gag's examples are drawn from (male, female, pet) map onto
 * the i2i scenarios; a picture's subject is a person or a pet (2026-11-15).
 */

import { z } from "zod";
import type { SubjectRenderMode } from "./imagePromptGeneration";

// ─── Scenario keys ───────────────────────────────────────────────────────────

export const RENDER_SCENARIO_KEYS = [
  "generic_t2i",
  "i2i_male_default",
  "i2i_female_default",
  "i2i_nonhuman_animal",
] as const;
export type RenderScenarioKey = (typeof RENDER_SCENARIO_KEYS)[number];

export const renderScenarioKeySchema = z.enum(RENDER_SCENARIO_KEYS);

/** Identity class of the default reference image an i2i scenario feeds the engine. */
export const REFERENCE_IDENTITY_TYPES = [
  "male",
  "female",
  "nonhuman_animal",
] as const;
export type ReferenceIdentityType = (typeof REFERENCE_IDENTITY_TYPES)[number];

// ─── Per-tile derived status ───────────────────────────────────────────────
//
// Status + stale are DERIVED at read time from the latest attempt row and the
// current input hash (never persisted). "skipped" is a healthy outcome for an
// optional non-human scenario that doesn't apply — distinct from "missing".

export const RENDER_SCENARIO_STATUS_VALUES = [
  "missing",   // applies, but no attempt exists yet
  "queued",    // attempt enqueued, prompt not generated
  "rendering", // prompt generated, image not ready
  "done",      // image ready
  "failed",    // attempt errored
  "blocked",   // subject↔fact compatibility poor / engine refused
  "skipped",   // optional scenario that does not apply (healthy)
] as const;
export type RenderScenarioStatus = (typeof RENDER_SCENARIO_STATUS_VALUES)[number];

/** Required-scenario states that block clean approval (a waiver must name them). */
export const PROBLEMATIC_SCENARIO_STATUSES = [
  "missing",
  "queued",
  "rendering",
  "failed",
  "blocked",
  "stale",
] as const;
export type ProblematicScenarioStatus = (typeof PROBLEMATIC_SCENARIO_STATUSES)[number];

// ─── Static scenario descriptors (shared source of truth) ────────────────────

export interface RenderScenarioDescriptor {
  key: RenderScenarioKey;
  label: string;
  purpose: string;
  subjectRenderMode: SubjectRenderMode;
  /** null for t2i (no reference image). */
  referenceIdentityType: ReferenceIdentityType | null;
  /** Required scenarios are always attempted and gate approval. */
  required: boolean;
  /**
   * A retired scenario is never offered, run or required; its key stays so
   * its stored attempts still read (compiler review, Phase 2: there is no
   * picture without a photo, David 2026-11-14).
   */
  retired?: boolean;
}

export const RENDER_SCENARIO_DESCRIPTORS: Record<RenderScenarioKey, RenderScenarioDescriptor> = {
  generic_t2i: {
    key: "generic_t2i",
    label: "Generic (text-to-image, retired)",
    purpose: "Retired: a picture with no reference photo. Kept so its stored renders still read.",
    subjectRenderMode: "t2i_fallback",
    referenceIdentityType: null,
    required: false,
    retired: true,
  },
  i2i_male_default: {
    key: "i2i_male_default",
    label: "Male subject (image-to-image)",
    purpose: "How the fact renders when a user uploads a male reference photo.",
    subjectRenderMode: "human_identity_i2i",
    referenceIdentityType: "male",
    required: true,
  },
  i2i_female_default: {
    key: "i2i_female_default",
    label: "Female subject (image-to-image)",
    purpose: "How the fact renders when a user uploads a female reference photo.",
    subjectRenderMode: "human_identity_i2i",
    referenceIdentityType: "female",
    required: true,
  },
  i2i_nonhuman_animal: {
    key: "i2i_nonhuman_animal",
    label: "Non-human · animal (image-to-image)",
    purpose: "How the fact renders when the subject is an animal (e.g. a cat). Conditional.",
    subjectRenderMode: "nonhuman_subject_i2i",
    referenceIdentityType: "nonhuman_animal",
    required: false,
  },
};

export const REQUIRED_RENDER_SCENARIO_KEYS: readonly RenderScenarioKey[] = RENDER_SCENARIO_KEYS.filter(
  (k) => RENDER_SCENARIO_DESCRIPTORS[k].required,
);

/** The scenarios that can still be run: every key but the retired ones. */
export const ACTIVE_RENDER_SCENARIO_KEYS: readonly RenderScenarioKey[] = RENDER_SCENARIO_KEYS.filter(
  (k) => !RENDER_SCENARIO_DESCRIPTORS[k].retired,
);

export const NONHUMAN_RENDER_SCENARIO_KEYS: readonly RenderScenarioKey[] = [
  "i2i_nonhuman_animal",
];

// ─── Scenario card (GET /render-scenarios response item) ─────────────────────

export interface RenderScenarioCard {
  key: RenderScenarioKey;
  label: string;
  purpose: string;
  referenceIdentityType: ReferenceIdentityType | null;
  required: boolean;
  /**
   * A retired scenario's stored render (the no-photo one): history to look at,
   * never to run again or approve as a gag's example. The server sets it on
   * every card; optional so older card constructors still type-check.
   */
  retired?: boolean;
  status: RenderScenarioStatus;
  /** True when the latest attempt was generated before the current tuning/config. */
  stale: boolean;
  /** Latest attempt id for this scenario, or null when none exists. */
  latestAttemptId: number | null;
  /** Present when status === "done": admin-gated image URL for the thumbnail. */
  imageUrl: string | null;
  /** Present for failed/blocked tiles. */
  message: string | null;
  // Eval harness (Slice 2B): the moderator's opportunistic verdict on the latest
  // attempt, so the Step-2 tile can render the rating control + chips. Null when
  // unrated (or no attempt). Optional so pre-eval card constructors still satisfy
  // the type; the server (buildCard) always populates them. These moderation
  // ratings are "directional only" in the dashboard — only eval-run rows are A/B.
  moderatorRating?: number | null;
  failureTag?: string | null;
  evalNotes?: string | null;
}

// ─── Approval waiver (pending_reviews.visual_render_approval_waiver) ──────────
// Retired 2026-11-15 (plan PLAN_GAG_EXAMPLES.md): nothing writes a waiver any
// more. The schema stays to read the waivers past reviews recorded.

export const visualRenderWaivedScenarioSchema = z.object({
  scenarioKey: renderScenarioKeySchema,
  statusAtWaiver: z.enum(PROBLEMATIC_SCENARIO_STATUSES),
  latestAttemptId: z.number().nullable().optional(),
  reason: z.string().max(500).optional(),
});

export const visualRenderApprovalWaiverSchema = z.object({
  waivedAt: z.string(),
  waivedByAdminUserId: z.string(),
  waivedScenarios: z.array(visualRenderWaivedScenarioSchema),
  requiredScenarioPolicyVersion: z.string(),
});
export type VisualRenderApprovalWaiver = z.infer<typeof visualRenderApprovalWaiverSchema>;

