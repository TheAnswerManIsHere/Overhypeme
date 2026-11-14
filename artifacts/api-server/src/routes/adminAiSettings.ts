/**
 * The read-only AI settings route (David, 2026-11-14: a page that SHOWS the
 * values, not one that sets them). Admin only.
 *
 *   GET /api/admin/ai-settings   every AI step's engine, model and parameters as sent, and every system prompt, all from code
 *
 * There is no write route: AI call settings live in code (decisions.md
 * 2026-11-14), so a change is a reviewed pull request.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import { aiSettingsView } from "../lib/aiSettingsView";

const router: IRouter = Router();

router.get("/admin/ai-settings", requireAdmin, async (_req: Request, res: Response) => {
  res.json(await aiSettingsView());
});

export default router;
