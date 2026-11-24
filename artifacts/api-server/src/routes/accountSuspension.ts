/**
 * @purpose The admin suspend and unsuspend routes (launch Phase 5, plan *Suspension*): an admin suspends an account with a reason the person never sees, never their own account and never the last administrator; unsuspending lifts it. Each real transition queues one notice to the member (Issue #1110, Q7) after the change commits, carrying the admin's optional note to the member and never the reason. The engine is `lib/accountSuspension.ts`.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";

import { db } from "@workspace/db";
import { assertNotSelfDemotion, respondToGuardError } from "../lib/adminLockoutGuard";
import { SUSPENSION_REASON_MAX, suspendAccount, unsuspendAccount, type SuspensionRecipient } from "../lib/accountSuspension";
import {
  SUSPENSION_MEMBER_NOTE_MAX,
  buildAccountReinstatedEmail,
  buildAccountSuspendedEmail,
  isEnabled,
  sendEmail,
  type EmailPayload,
} from "../lib/email";
import { logger } from "../lib/logger";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

/**
 * What became of a transition's notice, reported to the admin (plan design
 * items 2 and 5): `queued` means a job exists, never that it was delivered;
 * `not_queued` names why nothing was queued; `not_owed` is a repeated request
 * that changed nothing. When nothing was queued there is no job to retry, and
 * repeating the action does not resend: it is no longer a transition.
 */
export type SuspensionNotice =
  | { status: "queued" }
  | { status: "not_queued"; why: "no_address" | "email_unavailable" | "failed" }
  | { status: "not_owed" };

// With no transport `sendEmail` only logs and returns, which would read as
// queued (the support route's lesson, Codex PR #1071 round 2), so it is checked first.
let deliveryAvailable: () => boolean = isEnabled;
let send: typeof sendEmail = sendEmail;

/** Test seam: the email layer's answers are fixed when it loads (null restores each). */
export function __setSuspensionNoticeSeamsForTests(seams: { deliveryAvailable?: (() => boolean) | null; send?: typeof sendEmail | null }): void {
  if ("deliveryAvailable" in seams) deliveryAvailable = seams.deliveryAvailable ?? isEnabled;
  if ("send" in seams) send = seams.send ?? sendEmail;
}

async function queueNotice(
  recipient: SuspensionRecipient | null,
  kind: "account_suspended" | "account_reinstated",
  message: Pick<EmailPayload, "subject" | "text" | "html">,
): Promise<SuspensionNotice> {
  if (!recipient) return { status: "not_owed" };
  if (!recipient.email) return { status: "not_queued", why: "no_address" };
  if (!deliveryAvailable()) return { status: "not_queued", why: "email_unavailable" };
  try {
    // `db` opts in to the outbox insert, as the support route does: with a
    // test key the insert is otherwise skipped and nothing would be queued.
    await send({ to: recipient.email, kind, ...message }, db);
    return { status: "queued" };
  } catch (err) {
    logger.warn({ err, kind }, "[accountSuspension] notice could not be queued; the account change stands");
    return { status: "not_queued", why: "failed" };
  }
}

// POST /admin/users/:id/suspend — body { reason, memberNote? }.
router.post("/admin/users/:id/suspend", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const memberNote = typeof req.body?.memberNote === "string" ? req.body.memberNote.trim() : "";
  if (!reason) { res.status(400).json({ error: "Say why the account is suspended. Only admins see it." }); return; }
  if (reason.length > SUSPENSION_REASON_MAX) { res.status(400).json({ error: `Keep the reason under ${SUSPENSION_REASON_MAX} characters.` }); return; }
  if (memberNote.length > SUSPENSION_MEMBER_NOTE_MAX) { res.status(400).json({ error: `Keep the note to the member under ${SUSPENSION_MEMBER_NOTE_MAX} characters.` }); return; }
  let result: Awaited<ReturnType<typeof suspendAccount>>;
  try {
    assertNotSelfDemotion(req.user?.id, id);
    result = await suspendAccount(id, { by: req.user?.id ?? null, reason });
  } catch (err) {
    if (respondToGuardError(err, res)) return;
    throw err;
  }
  if (result.outcome === "not_found") { res.status(404).json({ error: "User not found" }); return; }
  // After the commit: nothing here can undo the suspension or revive a session.
  const notice = await queueNotice(
    result.recipient,
    "account_suspended",
    buildAccountSuspendedEmail(getSiteBaseUrl(), { memberNote: memberNote || null, firstName: result.recipient?.firstName ?? null }),
  );
  res.json({ suspended: true, alreadySuspended: result.outcome === "already_suspended", notice });
});

// POST /admin/users/:id/unsuspend
router.post("/admin/users/:id/unsuspend", requireAdmin, async (req: Request, res: Response) => {
  const result = await unsuspendAccount(String(req.params["id"] ?? ""));
  if (result.outcome === "not_found") { res.status(404).json({ error: "User not found" }); return; }
  const notice = await queueNotice(
    result.recipient,
    "account_reinstated",
    buildAccountReinstatedEmail(getSiteBaseUrl(), { firstName: result.recipient?.firstName ?? null }),
  );
  res.json({ suspended: false, wasSuspended: result.outcome === "unsuspended", notice });
});

export default router;
