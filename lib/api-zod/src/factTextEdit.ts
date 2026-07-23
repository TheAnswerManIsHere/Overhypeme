import { z } from "zod/v4";

/**
 * Shared contract for the approved-fact-text lock (Plan v4) — the confirmation
 * envelope, the impact/consequence payload the modal renders, and the typed
 * 4xx codes. Imported by BOTH the server (route + service) and the admin
 * frontend so the two never drift.
 */

/** Max stored fact text — mirrors the submit-review cap (previously absent on
 *  the admin PATCH). */
export const FACT_TEXT_MAX_CHARS = 2000;

/** The exact phrase the admin must type to authorize an approved-fact text
 *  edit. Validated case-sensitively on BOTH client and server. */
export const APPROVED_FACT_TEXT_EDIT_PHRASE = "CHANGE APPROVED FACT TEXT";

export const FACT_TEXT_EDIT_REASON_MIN = 10;
export const FACT_TEXT_EDIT_REASON_MAX = 2000;

/** The confirmation envelope sent with a PATCH that changes a protected fact's
 *  text. `expectedOldTextHash` binds the confirmation to the exact wording the
 *  admin reviewed (optimistic concurrency); the server rejects a stale hash. */
export const confirmTextEditSchema = z.object({
  phrase: z.literal(APPROVED_FACT_TEXT_EDIT_PHRASE),
  reason: z.string().trim().min(FACT_TEXT_EDIT_REASON_MIN).max(FACT_TEXT_EDIT_REASON_MAX),
  expectedOldTextHash: z.string().min(1),
});
export type ConfirmTextEdit = z.infer<typeof confirmTextEditSchema>;

/** Machine-readable protection reason (server-owned; surfaced in the impact). */
export type FactTextProtectionReason =
  | "active"
  | "ever_approved"
  | "ambiguous_unresolved_reviews"
  | "orphan_or_legacy";

/** Typed 4xx codes the PATCH text path can return. */
export const FACT_TEXT_EDIT_CODES = {
  REQUIRES_CONFIRMATION: "TEXT_EDIT_REQUIRES_CONFIRMATION",
  STALE_BASELINE: "TEXT_EDIT_STALE_BASELINE",
  DEPENDENT_VARIANT_IN_PROGRESS: "DEPENDENT_VARIANT_IN_PROGRESS",
  STAGING_PREP_IN_PROGRESS: "STAGING_PREP_IN_PROGRESS",
  INVALID_CONFIRMATION: "TEXT_EDIT_INVALID_CONFIRMATION",
  GRAMMAR_INVALID: "TEXT_EDIT_GRAMMAR_INVALID",
  TOO_LONG: "TEXT_EDIT_TOO_LONG",
} as const;
export type FactTextEditCode = (typeof FACT_TEXT_EDIT_CODES)[keyof typeof FACT_TEXT_EDIT_CODES];

/** A direct child variant blocking a root re-word (mid-cycle). */
export interface BlockingVariant {
  factId: number;
  reason: "unresolved_review" | "active_enrichment_job";
}

/** Everything the confirmation modal needs to render a truthful diff +
 *  consequences. Returned with both the REQUIRES_CONFIRMATION and the
 *  STALE_BASELINE 409s (same shape, so the two can't drift). */
export interface ApprovedFactTextEditImpact {
  protected: boolean;
  protectionReason: FactTextProtectionReason;
  /** Current stored (normalized) wording — the diff's left side + hash source. */
  currentStoredText: string;
  /** What the proposed text normalizes to for storage — the diff's right side. */
  normalizedProposedText: string;
  /** sha256 of currentStoredText; echo back in the confirmation envelope. */
  expectedOldTextHash: string;
  isRoot: boolean;
  /** Direct child variants whose enrichment a re-word invalidates. */
  affectedVariantCount: number;
  /** Subset of the above that are mid-cycle and BLOCK the edit. */
  blockingVariants: BlockingVariant[];
  /** Memes that permanently keep the old wording (persisted vs currently live). */
  persistedMemeCount: number;
  liveMemeCount: number;
  /** A refresh candidate is in flight for this fact (edit will block its promote). */
  refreshInFlight: boolean;
}

/** Per-queue dispatch state returned after a staging restart / prep ensure. */
export interface PrepDispatchState {
  factId: number;
  enrichment: { status: string; inserted: boolean };
  pexels: { status: string; inserted: boolean };
}
