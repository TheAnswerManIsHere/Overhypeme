import { Router, type IRouter, type Request, type Response } from "express";
import { sendEmail, buildShareInviteEmail } from "../lib/email";
import { getSessionId, getSession } from "../lib/auth";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

/**
 * POST /share/invite
 * Sends a branded invite email to a recipient with their personalised link.
 * No authentication required. If the caller is logged in, we use their
 * display name as the "from" line in the email.
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
  if (!emailRegex.test(recipientEmail.trim())) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  // Try to resolve sender display name from session (best-effort, not required)
  let senderName: string | null = null;
  try {
    const sid = getSessionId(req);
    if (sid) {
      const session = await getSession(sid);
      if (session?.user?.id) {
        const [dbUser] = await db
          .select({ displayName: usersTable.displayName })
          .from(usersTable)
          .where(eq(usersTable.id, session.user.id));
        if (dbUser?.displayName) senderName = dbUser.displayName;
      }
    }
  } catch {
    // not critical — fallback to "Someone"
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
