/**
 * @purpose Asks the server to send another verification email and says truthfully whether it did (#1109 D8): every resend button used to claim the email was sent whatever the server answered, including while the site was paused.
 * @subsystem accounts
 */
import { isReadOnlyRefusal, READ_ONLY_REFUSED_FULL } from "@/lib/readOnlyNotice";

export interface ResendResult {
  sent: boolean;
  /** What to tell the visitor: the confirmation, or why nothing was sent. */
  message: string;
}

export const RESEND_SENT_MESSAGE = "A new verification email has been sent. Please check your inbox.";
const RESEND_FAILED_MESSAGE = "We couldn't send the email. Please try again in a moment.";

export async function resendVerification(): Promise<ResendResult> {
  try {
    const res = await fetch("/api/auth/resend-verification", { method: "POST", credentials: "include" });
    if (res.ok) return { sent: true, message: RESEND_SENT_MESSAGE };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (isReadOnlyRefusal(res, body)) return { sent: false, message: READ_ONLY_REFUSED_FULL };
    return { sent: false, message: typeof body?.error === "string" && body.error ? body.error : RESEND_FAILED_MESSAGE };
  } catch {
    return { sent: false, message: RESEND_FAILED_MESSAGE };
  }
}
