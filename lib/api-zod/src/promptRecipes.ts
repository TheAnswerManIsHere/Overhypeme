/**
 * The prompt tuner's wire vocabulary for prompt recipes (part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A and D). Shared by the
 * admin routes and the admin page. The pieces themselves, and which slots each
 * may name, are the server's (`lib/imagePrompt/recipe.ts`), checked there.
 */
import { z } from "zod";

const pieces = z.record(z.string().min(1).max(80), z.string().max(4000)).refine((p) => Object.keys(p).length <= 200, "too many pieces");

/** Save a new version: the pieces that differ from the version it is based on (or all of them), and a note. */
export const promptRecipeSaveSchema = z.object({
  pieces,
  note: z.string().trim().min(1).max(500),
  /** The version the editor started from; null for the baseline; omitted means the family's live version. */
  basedOnVersionId: z.number().int().positive().nullable().optional(),
}).strict();
export type PromptRecipeSaveRequest = z.infer<typeof promptRecipeSaveSchema>;

/** Make a version live for its family; null restores the baseline. */
export const promptRecipePromoteSchema = z.object({
  versionId: z.number().int().positive().nullable(),
  /** Required when the version changes a policy line against the live wording. */
  confirmPolicy: z.boolean().optional(),
}).strict();
export type PromptRecipePromoteRequest = z.infer<typeof promptRecipePromoteSchema>;

/** Compile a stored render of a fact again with candidate wording, without a planner call. */
export const promptRecipePreviewSchema = z.object({
  pieces,
  basedOnVersionId: z.number().int().positive().nullable().optional(),
  factId: z.number().int().positive(),
  subjectRenderMode: z.enum(["human_identity_i2i", "nonhuman_subject_i2i", "t2i_fallback"]),
}).strict();
export type PromptRecipePreviewRequest = z.infer<typeof promptRecipePreviewSchema>;
