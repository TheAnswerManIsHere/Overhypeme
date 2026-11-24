/**
 * @purpose The support correction of a mistyped date of birth (launch Phase 14, increment 4: "A mistyped date is corrected through support, and the screen says so"): an admin stores the corrected date, which must be 18 or over, and clears a recorded under-18 refusal in one write, so the account is no longer under age; an un-onboarded account then finishes set-up with that date.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import { ageInYears, MINIMUM_AGE } from "../lib/eligibility";
import { logger } from "../lib/logger";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// POST /admin/users/:id/correct-date-of-birth — body { dateOfBirth: "YYYY-MM-DD" }.
// Only an adult date is a correction: a date under 18 would leave the account
// under age by its stored date, so it is refused rather than stored.
router.post("/admin/users/:id/correct-date-of-birth", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const dateOfBirth = typeof req.body?.dateOfBirth === "string" ? req.body.dateOfBirth.trim() : "";
  const age = ageInYears(dateOfBirth);
  if (age == null) { res.status(400).json({ error: "Enter a real date of birth, as YYYY-MM-DD." }); return; }
  if (age < MINIMUM_AGE) { res.status(400).json({ error: `That date is under ${MINIMUM_AGE}, so it can't correct the account.` }); return; }

  const [before] = await db.select({ ageRefusedAt: usersTable.ageRefusedAt }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!before) { res.status(404).json({ error: "User not found" }); return; }
  await db.update(usersTable).set({ dateOfBirth, ageRefusedAt: null }).where(eq(usersTable.id, id));

  // Who corrected which account, and whether it lifted a refusal; the date
  // itself is personal data and stays out of the log.
  logger.info({ adminId: req.user?.id ?? null, userId: id, liftedRefusal: before.ageRefusedAt != null }, "[age-correction] date of birth corrected by an admin");
  res.json({ corrected: true, liftedRefusal: before.ageRefusedAt != null });
});

export default router;
