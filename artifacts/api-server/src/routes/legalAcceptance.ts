/**
 * @purpose The "agree to the Terms" screen's server side for an account that finished set-up before acceptance existed, or whose Terms or Privacy page has since changed (launch Phase 14, increment 4): reports the versions it must accept and whether it holds them, and records an acceptance after checking the versions the screen showed against the current ones.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { checkAcceptance, recordLegalAcceptance, requiredLegalVersions } from "../lib/legalAcceptance";

const router: IRouter = Router();

/** Only an account that finished set-up accepts here; set-up records its own. */
function requireOnboarded(req: Request, res: Response): req is Request & { user: NonNullable<Request["user"]> } {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  const state = req.user.eligibility;
  if (state !== "terms_unaccepted" && state !== "eligible") {
    res.status(403).json({ error: "This account cannot accept the Terms now.", code: "LEGAL_ACCEPTANCE_UNAVAILABLE" });
    return false;
  }
  return true;
}

// GET /users/me/legal-acceptance — what the screen asks for.
router.get("/users/me/legal-acceptance", (req: Request, res: Response) => {
  if (!requireOnboarded(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ accepted: req.user.eligibility === "eligible", required: requiredLegalVersions() });
});

// POST /users/me/legal-acceptance — body { terms, privacy }: the versions the
// screen showed. A version that is no longer current is refused, so nobody is
// recorded as agreeing to a text they did not see.
router.post("/users/me/legal-acceptance", async (req: Request, res: Response) => {
  if (!requireOnboarded(req, res)) return;
  const check = checkAcceptance(req.body);
  if (!check.ok) {
    res.status(400).json({ error: check.error, code: check.code });
    return;
  }
  const userId = req.user.id;
  await recordLegalAcceptance(db, userId);
  res.json({ accepted: true });
});

export default router;
