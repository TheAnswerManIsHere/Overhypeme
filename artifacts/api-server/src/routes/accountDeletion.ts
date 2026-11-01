/**
 * @purpose The self-service account deletion routes (launch Phase 5, plan S14, David's answers 2 and 7): request deletion after re-authenticating — the password for an account that has one, a sign-in from the last ten minutes for a Google- or Apple-only account — read the pending request, and keep the account. The admin deletion panel reads every request in progress here, and an admin can keep an account on its owner's behalf. Every transition is the engine's (`lib/accountDeletion.ts`); these routes only authenticate, rate-limit and answer.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { acceptAccountDeletion, cancelAccountDeletion, listDeletionRequestsForAdmin, pendingDeletion } from "../lib/accountDeletion";
import { respondToGuardError } from "../lib/adminLockoutGuard";
import { getSession } from "../lib/auth";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

/** How recent a provider sign-in must be to stand in for a password (David's answer 2: "it should be HARD to do without really meaning to"). */
export const FRESH_SIGN_IN_MS = 10 * 60 * 1000;

/** Per account: deleting and keeping are rare acts; a burst is a mistake or a script. */
const DELETION_RATE = { limit: 5, windowMs: 60 * 60 * 1000 };

async function rateLimited(req: Request, res: Response, endpoint: string): Promise<boolean> {
  const result = await checkSharedRateLimit({ endpoint, userId: req.user!.id }, DELETION_RATE);
  if (result.allowed) return false;
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
  res.status(429).json({ error: "Too many attempts. Please try again later." });
  return true;
}

// GET /users/me/deletion — the pending request, for the "Keep my account" screen.
router.get("/users/me/deletion", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const pending = await pendingDeletion(req.user.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(pending
    ? { pending: true, requestedAt: pending.requestedAt.toISOString(), purgeAfter: pending.purgeAfter.toISOString(), cancellable: pending.stage !== "purging" }
    : { pending: false });
});

// POST /users/me/deletion — body { password? }. Schedules the account's
// deletion 14 days out; signs it out everywhere and hides its content now.
router.post("/users/me/deletion", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = req.user.id;
  if (await rateLimited(req, res, "users.deletion.request")) return;

  const [user] = await db
    .select({ passwordHash: usersTable.passwordHash, googleLinked: usersTable.googleLinked, appleLinked: usersTable.appleLinked })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (user.passwordHash) {
    if (!password || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: "That password is not right.", code: "REAUTH_FAILED" });
      return;
    }
  } else {
    // No password to ask for: a sign-in this recent is the proof.
    const session = req.authSessionId ? await getSession(req.authSessionId) : null;
    const signedInAt = session?.signedInAt ?? 0;
    if (Date.now() - signedInAt > FRESH_SIGN_IN_MS) {
      res.status(401).json({
        error: "Sign in again to confirm it's you, then delete your account.",
        code: "REAUTH_REQUIRED",
        providers: [user.googleLinked ? "google" : null, user.appleLinked ? "apple" : null].filter(Boolean),
      });
      return;
    }
  }

  try {
    const outcome = await acceptAccountDeletion(userId, { requestedBy: "self" });
    if (outcome.status === "not_found") { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json({ scheduled: true, purgeAfter: outcome.purgeAfter.toISOString(), alreadyPending: outcome.status === "already_pending" });
  } catch (err) {
    if (respondToGuardError(err, res)) return;
    throw err;
  }
});

// POST /users/me/deletion/cancel — "Keep my account": the one write a pending deletion allows.
router.post("/users/me/deletion/cancel", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (await rateLimited(req, res, "users.deletion.cancel")) return;
  const outcome = await cancelAccountDeletion(req.user.id);
  if (outcome === "cancelled") { res.json({ cancelled: true }); return; }
  if (outcome === "too_late") {
    res.status(409).json({ error: "This account is already being deleted and can no longer be kept.", code: "DELETION_IN_PROGRESS" });
    return;
  }
  res.status(404).json({ error: "This account has no deletion pending." });
});

// ── The admin deletion panel (plan, Admin/User UX Impact) ─────────────
// "Purge now" is the admin hard delete (`DELETE /admin/users/:id?hard=true`),
// which brings a pending request's date forward and runs the engine; on a
// purge that failed part-way it is also the retry.

// GET /admin/account-deletions — every request in progress, and every kept
// account whose billing clean-up is unfinished.
router.get("/admin/account-deletions", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await listDeletionRequestsForAdmin();
  res.setHeader("Cache-Control", "no-store");
  res.json({ requests: rows });
});

// POST /admin/users/:id/deletion/cancel — keep the account on its owner's
// behalf (they are emailed, as when they keep it themselves).
router.post("/admin/users/:id/deletion/cancel", requireAdmin, async (req: Request, res: Response) => {
  const outcome = await cancelAccountDeletion(String(req.params["id"] ?? ""));
  if (outcome === "cancelled") { res.json({ cancelled: true }); return; }
  if (outcome === "too_late") {
    res.status(409).json({ error: "This account is already being deleted and can no longer be kept.", code: "DELETION_IN_PROGRESS" });
    return;
  }
  res.status(404).json({ error: "This account has no deletion pending." });
});

export default router;
