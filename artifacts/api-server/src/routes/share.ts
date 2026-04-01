import { Router, type IRouter, type Request, type Response } from "express";
import { sendEmail, buildShareInviteEmail } from "../lib/email";
import { getSession } from "../lib/auth";

const router: IRouter = Router();

/**
 * POST /share/invite
 * Sends a branded invite email to the specified recipient.
 * Caller may optionally be authenticated; if so we use their display name as the sender.
 */
router.post("/share/invite", async (req: Request, res: Response) => {
  const { recipientEmail, recipientName, shareUrl } = req.body as {
    recipientEmail?: string;
    recipientName?: string;
    shareUrl?: string;
  };

  if (!recipientEmail || typeof recipientEmail !== "string") {
    res.status(400).json({ error: "recipientEmail is required" });
    return;
  }
  if (!recipientName || typeof recipientName !== "string") {
    res.status(400).json({ error: "recipientName is required" });
    return;
  }
  if (!shareUrl || typeof shareUrl !== "string") {
    res.status(400).json({ error: "shareUrl is required" });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientEmail)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  // Resolve sender name from session if available
  let senderName: string | null = null;
  try {
    const sid = req.headers["authorization"]?.replace("Bearer ", "")
      ?? (req.cookies as Record<string, string>)?.sid;
    if (sid) {
      const session = await getSession(sid);
      const displayName = (session?.user as { displayName?: string })?.displayName;
      if (displayName) senderName = displayName;
    }
  } catch {
    // not critical
  }

  const payload = buildShareInviteEmail(
    recipientName.trim(),
    shareUrl,
    senderName,
  );

  await sendEmail({
    to: recipientEmail.trim(),
    ...payload,
  });

  res.json({ success: true });
});

export default router;
