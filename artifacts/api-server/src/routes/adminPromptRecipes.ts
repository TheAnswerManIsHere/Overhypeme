/**
 * The prompt tuner's recipe routes (part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A and D). Admin only.
 *
 *   GET  /api/admin/prompt-recipes                    every piece (its label, when it appears, slots, baseline) and every image engine family with its versions, live version and promotions
 *   POST /api/admin/prompt-recipes/:family/versions   save a new version (never edits one); refused when the wording is malformed or does not fit the prompt budget
 *   POST /api/admin/prompt-recipes/:family/promote    make a version (or, with null, the baseline) live; a changed policy line needs confirmPolicy
 *   POST /api/admin/prompt-recipes/:family/preview    compile a fact's latest stored render plan with candidate wording, without a planner call
 *
 * Saving or previewing changes nothing live. A promotion changes the wording
 * renders on that family's engines use from then on, never which engine.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { imagePromptAttemptsTable } from "@workspace/db/schema";
import { promptRecipePreviewSchema, promptRecipePromoteSchema, promptRecipeSaveSchema } from "@workspace/api-zod";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { requireAdmin } from "./admin";
import { RECIPE_PIECES, recipeProblems } from "../lib/imagePrompt/recipe";
import { draftRecipe, listRecipeFamilies, promoteRecipe, RecipeRefused, saveRecipeVersion } from "../lib/imagePrompt/recipeStore";
import { recipeBudgetProblems } from "../lib/imagePrompt/promptBudget";
import { recompileStoredAttempt } from "../lib/imagePromptJobs";

const router: IRouter = Router();

const familyParam = (req: Request): string | null => {
  const f = String(req.params["family"] ?? "");
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(f) ? f : null;
};

function refused(res: Response, err: unknown): boolean {
  if (!(err instanceof RecipeRefused)) return false;
  res.status(409).json({ error: "recipe_refused", refusal: err.message, ...err.details });
  return true;
}

router.get("/admin/prompt-recipes", requireAdmin, async (_req: Request, res: Response) => {
  res.json({
    pieces: RECIPE_PIECES.map((p) => ({ key: p.key, label: p.label, group: p.group, when: p.when, slots: p.slots, policy: "policy" in p && !!p.policy, baseline: p.text })),
    families: await listRecipeFamilies(),
  });
});

router.post("/admin/prompt-recipes/:family/versions", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const family = familyParam(req);
  if (!family) { res.status(400).json({ error: "Invalid family" }); return; }
  const parsed = promptRecipeSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    res.status(201).json({ version: await saveRecipeVersion({ family, ...parsed.data, userId: req.user.id }) });
  } catch (err) {
    if (!refused(res, err)) throw err;
  }
});

router.post("/admin/prompt-recipes/:family/promote", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const family = familyParam(req);
  if (!family) { res.status(400).json({ error: "Invalid family" }); return; }
  const parsed = promptRecipePromoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  try {
    res.json({ promotion: await promoteRecipe({ family, ...parsed.data, userId: req.user.id }) });
  } catch (err) {
    if (!refused(res, err)) throw err;
  }
});

router.post("/admin/prompt-recipes/:family/preview", requireAdmin, async (req: Request, res: Response) => {
  const family = familyParam(req);
  if (!family) { res.status(400).json({ error: "Invalid family" }); return; }
  const parsed = promptRecipePreviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }
  const { pieces, factId, subjectRenderMode } = parsed.data;
  const { draft: recipe } = await draftRecipe(family, parsed.data.basedOnVersionId, pieces);
  const [attempt] = await db.select().from(imagePromptAttemptsTable)
    .where(and(eq(imagePromptAttemptsTable.factId, factId), eq(imagePromptAttemptsTable.subjectRenderMode, subjectRenderMode), isNotNull(imagePromptAttemptsTable.visualPlan)))
    .orderBy(desc(imagePromptAttemptsTable.id)).limit(1);
  const problems = [...recipeProblems(pieces), ...recipeBudgetProblems(recipe)];
  if (!attempt) {
    res.status(404).json({ error: "no_stored_plan", refusal: "this fact has no stored render plan for that photo type yet; a moderation render or a comparison makes one", problems });
    return;
  }
  const compiled = await recompileStoredAttempt(attempt, recipe);
  if (!compiled) {
    res.status(409).json({ error: "plan_unusable", refusal: "this fact's latest stored render plan can no longer be compiled", problems });
    return;
  }
  res.json({
    attemptId: attempt.id,
    prompt: compiled.prompt,
    length: compiled.prompt.length,
    sections: (compiled.promptBreakdown ?? []).filter((s) => s.status !== "empty").map((s) => ({ id: s.id, label: s.label, status: s.status, text: s.text })),
    overflowBy: compiled.diagnostics?.requiredBudgetOverflow?.overBy ?? 0,
    problems,
  });
});

export default router;
