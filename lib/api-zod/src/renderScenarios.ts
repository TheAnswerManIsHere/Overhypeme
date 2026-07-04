/**
 * Moderation render-scenario vocabulary — SHARED between the api-server (policy,
 * hashing, orchestration in `factRenderScenarios.ts`) and the admin frontend
 * (the Step-2 visual-review grid). This module is pure types/enums + static
 * descriptor data + the waiver wire schema — NO logic, NO crypto, NO DB. Keeping
 * the descriptors here (rather than only behind the API) means the frontend and
 * server share one source of truth and can't drift.
 *
 * A "scenario" is one default test render the moderator reviews in Step 2:
 *   - generic_t2i               text-to-image, no reference (the generic case)
 *   - i2i_male_default          image-to-image with the default male reference
 *   - i2i_female_default        image-to-image with the default female reference
 *   - i2i_nonhuman_animal       image-to-image with a non-human animal reference
 *   - i2i_nonhuman_object_vehicle  …with a non-human object/vehicle reference
 *
 * The first three are REQUIRED (always attempted). The two non-human scenarios
 * are OPTIONAL/conditional — see `resolveNonHumanScenarioApplicability` server
 * side; they auto-run only on a high-confidence non-human-subject signal and are
 * otherwise manually forceable.
 */

import { z } from "zod";
import type { SubjectRenderMode } from "./imagePromptGeneration";

// ─── Scenario keys ───────────────────────────────────────────────────────────

export const RENDER_SCENARIO_KEYS = [
  "generic_t2i",
  "i2i_male_default",
  "i2i_female_default",
  "i2i_nonhuman_animal",
  "i2i_nonhuman_object_vehicle",
] as const;
export type RenderScenarioKey = (typeof RENDER_SCENARIO_KEYS)[number];

export const renderScenarioKeySchema = z.enum(RENDER_SCENARIO_KEYS);

/** Identity class of the default reference image an i2i scenario feeds the engine. */
export const REFERENCE_IDENTITY_TYPES = [
  "male",
  "female",
  "nonhuman_animal",
  "nonhuman_object_vehicle",
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

// ─── Non-human applicability ─────────────────────────────────────────────────

/**
 * Result of the conservative non-human applicability check. `autoRun` only flips
 * true on a high-confidence signal that the *personalized subject itself* is
 * non-human — never merely because a non-human entity appears in the scene. The
 * UI always exposes a manual override regardless of `autoRun`.
 */
export interface NonHumanApplicability {
  autoRun: boolean;
  confidence: "high" | "medium" | "low";
  /** Which non-human reference to use when run (auto or forced). */
  subtype: "animal" | "object_vehicle" | "none";
  reason: string;
  evidence: string[];
  negativeEvidence: string[];
}

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
}

export const RENDER_SCENARIO_DESCRIPTORS: Record<RenderScenarioKey, RenderScenarioDescriptor> = {
  generic_t2i: {
    key: "generic_t2i",
    label: "Generic (text-to-image)",
    purpose: "How the fact renders with no reference photo — the generic, no-upload case.",
    subjectRenderMode: "t2i_fallback",
    referenceIdentityType: null,
    required: true,
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
  i2i_nonhuman_object_vehicle: {
    key: "i2i_nonhuman_object_vehicle",
    label: "Non-human · object/vehicle (image-to-image)",
    purpose: "How the fact renders when the subject is an object/vehicle (e.g. a car). Conditional.",
    subjectRenderMode: "nonhuman_subject_i2i",
    referenceIdentityType: "nonhuman_object_vehicle",
    required: false,
  },
};

export const REQUIRED_RENDER_SCENARIO_KEYS: readonly RenderScenarioKey[] = RENDER_SCENARIO_KEYS.filter(
  (k) => RENDER_SCENARIO_DESCRIPTORS[k].required,
);

export const NONHUMAN_RENDER_SCENARIO_KEYS: readonly RenderScenarioKey[] = [
  "i2i_nonhuman_animal",
  "i2i_nonhuman_object_vehicle",
];

// ─── Scenario card (GET /render-scenarios response item) ─────────────────────

export interface RenderScenarioCard {
  key: RenderScenarioKey;
  label: string;
  purpose: string;
  referenceIdentityType: ReferenceIdentityType | null;
  required: boolean;
  status: RenderScenarioStatus;
  /** True when the latest attempt was generated before the current tuning/config. */
  stale: boolean;
  /** Latest attempt id for this scenario, or null when none exists. */
  latestAttemptId: number | null;
  /** Present when status === "done": admin-gated image URL for the thumbnail. */
  imageUrl: string | null;
  /** Present for failed/blocked tiles. */
  message: string | null;
  /** Only set for the non-human scenarios: why it was included / skipped. */
  applicability: NonHumanApplicability | null;
  // Eval harness (Slice 2B): the moderator's opportunistic verdict on the latest
  // attempt, so the Step-2 tile can render the rating control + chips. Null when
  // unrated (or no attempt). Optional so pre-eval card constructors still satisfy
  // the type; the server (buildCard) always populates them. These moderation
  // ratings are "directional only" in the dashboard — only eval-run rows are A/B.
  moderatorRating?: number | null;
  failureTag?: string | null;
  evalNotes?: string | null;
}

export interface RenderScenarioGrid {
  reviewId: number;
  cards: RenderScenarioCard[];
  tally: {
    requested: number;
    done: number;
    rendering: number;
    queued: number;
    failed: number;
    blocked: number;
    skipped: number;
    stale: number;
  };
}

// ─── Approval waiver (persisted on pending_reviews.visual_render_approval_waiver) ─

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

/** Approval request fields the client sends when waiving visual-render problems. */
export const visualRenderWaiverRequestSchema = z.object({
  waiveVisualRenderIssues: z.boolean().optional(),
  waivedScenarioKeys: z.array(renderScenarioKeySchema).optional(),
});
export type VisualRenderWaiverRequest = z.infer<typeof visualRenderWaiverRequestSchema>;
