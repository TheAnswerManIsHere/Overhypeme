import { Router, type IRouter, type Request, type Response } from "express";
import { runFactOfTheDayJob } from "../jobs/factOfTheDay";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// CRON_SECRET is required — no fallback. Validate at module load so the server
// fails fast at startup rather than silently rejecting all cron requests with
// 403 at runtime. Keep this as a module-level throw so it surfaces in the same
// boot-error path as other required-env checks (e.g. PORT).
const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) {
  throw new Error(
    "CRON_SECRET environment variable is required but was not provided. Set it in Replit Secrets.",
  );
}

function isCronAuthorized(req: Request): boolean {
  const auth = req.headers["x-cron-secret"];
  return auth === CRON_SECRET;
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
