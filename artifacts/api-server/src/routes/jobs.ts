import { isRealAdminRequest } from "../lib/adminIdentity";
import { Router, type IRouter, type Request, type Response } from "express";
import { runDailyFactOfTheDay } from "../jobs/factOfTheDay";
import { logger } from "../lib/logger";
import { runRetentionWindowJobs } from "../lib/dataLifecycle";
import { runDailyMaintenance } from "../lib/maintenance";
import { timingSafeEqual } from "node:crypto";

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

/** Compared in constant time, so the answer's timing says nothing about the secret. */
function isCronAuthorized(req: Request): boolean {
  const auth = req.headers["x-cron-secret"];
  if (typeof auth !== "string") return false;
  const given = Buffer.from(auth);
  const expected = Buffer.from(CRON_SECRET!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// POST /jobs/fact-of-the-day — run manually (cron or admin-triggered). Goes
// through the same once-per-day guard as the scheduler (Issue #1092): it sends
// today's batch only if no instance has, and answers what happened.
router.post("/jobs/fact-of-the-day", async (req: Request, res: Response) => {
  // Operational privilege: the REAL admin flag, over all three grant
  // mechanisms, and never the toggle-aware one.
  const isAdmin = isRealAdminRequest(req);
  if (!isCronAuthorized(req) && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const result = await runDailyFactOfTheDay();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Fact of the Day job error");
    res.status(500).json({ error: "Job failed" });
  }
});

export default router;


router.post("/jobs/data-retention", async (req: Request, res: Response) => {
  // Operational privilege: the REAL admin flag, over all three grant
  // mechanisms, and never the toggle-aware one.
  const isAdmin = isRealAdminRequest(req);
  if (!isCronAuthorized(req) && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const result = await runRetentionWindowJobs();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "Data retention job error");
    res.status(500).json({ error: "Job failed" });
  }
});

// POST /jobs/maintenance — the daily maintenance run (launch Phase 14,
// increment 6; lib/maintenance.ts), called once a day by a Cloudflare
// scheduled trigger. Answers 200 when every job succeeded and 500 when any
// failed, with each job's outcome either way, so the caller's own log shows a
// failed day.
router.post("/jobs/maintenance", async (req: Request, res: Response) => {
  // Operational privilege: the REAL admin flag, as for the jobs above.
  if (!isCronAuthorized(req) && !isRealAdminRequest(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const run = await runDailyMaintenance();
  res.status(run.ok ? 200 : 500).json(run);
});
