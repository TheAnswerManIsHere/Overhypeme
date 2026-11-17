/**
 * The admin-action record's vocabulary (plan PLAN_FACT_LIFECYCLE_REBUILD.md 1I
 * and 3C): one value per kind of admin action on a fact or a review. Written by
 * recordAdminAction (api-server lib/adminActions.ts) into admin_actions.action;
 * read by Phase 3's History tab. A new mutation adds its value here and records
 * it in the same change.
 */
export const ADMIN_ACTION_VALUES = [
  // Moderation
  "provisional_approval",
  "wording_edit",
  "duplicate_check",
  "humor_note_save",
  "gag_approval",
  "back_to_gags",
  "test_renders_requested",
  "approve_for_production",
  "reject",
  // Classification
  "classification_edit",
  "classification_rerun",
  // A live fact
  "fact_edit",
  "deactivate",
  // Gags (in moderation and on a live fact)
  "gag_create",
  "gag_save",
  "gag_discard",
  "gag_remove",
  "gag_render_approval",
  "gag_ideas_requested",
  "gag_renders_requested",
  // Imports
  "import",
] as const;

export type AdminAction = (typeof ADMIN_ACTION_VALUES)[number];
