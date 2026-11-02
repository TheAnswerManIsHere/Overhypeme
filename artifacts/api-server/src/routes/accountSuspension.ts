/**
 * @purpose The admin suspend and unsuspend routes (launch Phase 5, plan *Suspension*): an admin suspends an account with a reason the person never sees, never their own account and never the last administrator; unsuspending lifts it. The engine is `lib/accountSuspension.ts`.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";

import { assertNotSelfDemotion, respondToGuardError } from "../lib/adminLockoutGuard";
import { SUSPENSION_REASON_MAX, suspendAccount, unsuspendAccount } from "../lib/accountSuspension";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// POST /admin/users/:id/suspend — body { reason }.
router.post("/admin/users/:id/suspend", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) { res.status(400).json({ error: "Say why the account is suspended. Only admins see it." }); return; }
  if (reason.length > SUSPENSION_REASON_MAX) { res.status(400).json({ error: `Keep the reason under ${SUSPENSION_REASON_MAX} characters.` }); return; }
  try {
    assertNotSelfDemotion(req.user?.id, id);
    const outcome = await suspendAccount(id, { by: req.user?.id ?? null, reason });
    if (outcome === "not_found") { res.status(404).json({ error: "User not found" }); return; }
    res.json({ suspended: true, alreadySuspended: outcome === "already_suspended" });
  } catch (err) {
    if (respondToGuardError(err, res)) return;
    throw err;
  }
});

// POST /admin/users/:id/unsuspend
router.post("/admin/users/:id/unsuspend", requireAdmin, async (req: Request, res: Response) => {
  const outcome = await unsuspendAccount(String(req.params["id"] ?? ""));
  if (outcome === "not_found") { res.status(404).json({ error: "User not found" }); return; }
  res.json({ suspended: false, wasSuspended: outcome === "unsuspended" });
});

export default router;
