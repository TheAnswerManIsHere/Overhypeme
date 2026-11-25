/**
 * @purpose The admin view of an account's credits (launch Phase 7, plan PLAN_PHASE7_IMAGE_OFFERING.md §1): its balance and ledger, and an adjustment with a required note, attributed to the admin on the ledger row itself.
 * @subsystem membership
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ADMIN_ADJUSTMENT_MAX,
  ADMIN_ADJUSTMENT_NOTE_MAX,
  CreditAdjustmentError,
  applyAdminAdjustment,
  creditBalance,
  creditEntries,
} from "../lib/credits/ledger";
import { logger } from "../lib/logger";
import { adminLabel, requireAdmin } from "./admin";

const router: IRouter = Router();

const adjustmentBody = z.object({
  credits: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= ADMIN_ADJUSTMENT_MAX, {
    message: `Credits must be a whole number between -${ADMIN_ADJUSTMENT_MAX} and ${ADMIN_ADJUSTMENT_MAX}, and not zero.`,
  }),
  note: z.string().trim().min(1, "A note saying why is required.").max(ADMIN_ADJUSTMENT_NOTE_MAX),
  requestId: z.string().uuid(),
});

router.get("/admin/users/:id/credits", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  const [[user], balance, entries] = await Promise.all([
    db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1),
    creditBalance(id),
    creditEntries(id),
  ]);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ balance, entries });
});

router.post("/admin/users/:id/credits", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  const parsed = adjustmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid adjustment" }); return; }
  const label = adminLabel(req.user!);
  if (!label) { res.status(400).json({ error: "Your account has no name or email to attribute the adjustment to." }); return; }
  try {
    const result = await applyAdminAdjustment({
      userId: id,
      credits: parsed.data.credits,
      note: parsed.data.note,
      requestId: parsed.data.requestId,
      admin: { id: req.user!.id, label },
    });
    res.json(result);
  } catch (err) {
    if (err instanceof CreditAdjustmentError) {
      const status = err.code === "user_not_found" ? 404 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    logger.error({ err, userId: id }, "[credits] admin adjustment failed");
    res.status(500).json({ error: "The adjustment could not be saved." });
  }
});

export default router;
