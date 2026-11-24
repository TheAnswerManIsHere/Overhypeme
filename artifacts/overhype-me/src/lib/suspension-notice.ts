/**
 * @purpose The admin's result line after a suspend or unsuspend (Issue #1110, Q7): says whether the change happened and what became of the member's email — queued (a job exists, not a claim it was delivered), not queued and why, or not owed because nothing changed.
 * @subsystem accounts-auth
 */

/** The `notice` field the suspend and unsuspend routes return (`routes/accountSuspension.ts`). */
export type SuspensionNotice =
  | { status: "queued" }
  | { status: "not_queued"; why: "no_address" | "email_unavailable" | "failed" }
  | { status: "not_owed" };

const NOT_QUEUED_WHY: Record<Extract<SuspensionNotice, { status: "not_queued" }>["why"], string> = {
  no_address: "the account has no email address",
  email_unavailable: "email isn't set up on this server",
  failed: "queueing it failed — see the server log",
};

export function suspensionResultMessage(
  action: "suspend" | "unsuspend",
  data: { alreadySuspended?: boolean; wasSuspended?: boolean; notice?: SuspensionNotice },
): string {
  const changed = action === "suspend" ? !data.alreadySuspended : data.wasSuspended !== false;
  if (!changed) {
    return action === "suspend"
      ? "Already suspended — no new email."
      : "Wasn't suspended — no new email.";
  }
  const done = action === "suspend"
    ? "Suspended. They were signed out everywhere and can't sign in until you unsuspend them."
    : "Unsuspended. They can sign in again.";
  const notice = data.notice;
  if (notice?.status === "queued") return `${done} The email to them is queued.`;
  if (notice?.status === "not_queued") return `${done} No email was queued: ${NOT_QUEUED_WHY[notice.why]}.`;
  return done;
}
