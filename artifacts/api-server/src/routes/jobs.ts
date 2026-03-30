import { Router, type IRouter, type Request, type Response } from "express";
import { runFactOfTheDayJob } from "../jobs/factOfTheDay";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isCronAuthorized(req: Request): boolean {
  const auth = req.headers["x-cron-secret"];
  if (CRON_SECRET && auth === CRON_SECRET) return true;
  return false;
}

// POST /jobs/fact-of-the-day — run manually (cron or admin-triggered)
router.post("/jobs/fact-of-the-day", async (req: Request, res: Response) => {
  const isAdmin = req.isAuthenticated() && (req.user as { isAdmin?: boolean })?.isAdmin;
  if (!isCronAuthorized(req) && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const result = await runFactOfTheDayJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Fact of the Day job error");
    res.status(500).json({ error: "Job failed" });
  }
});

export default router;
