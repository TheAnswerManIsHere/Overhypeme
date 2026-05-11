import { trackEvent } from "@/lib/analytics";

export type ShareIntentPlatform = "twitter" | "web_share" | "copy_link" | "email";

/**
 * Fire-and-forget share-intent logger.
 *
 * Records that the user clicked a share button. We CANNOT observe the
 * actual share — it happens off-platform in the OS share sheet, a Twitter
 * composer, the user's mail client, or the clipboard paste action. This
 * is intent, not confirmation.
 *
 * Two writes happen for each click:
 *   1. POST /api/share-intents — canonical durable record (the source of
 *      truth for platform-distribution analytics).
 *   2. GA4 `share_intent` event — supplementary; only fires if gtag is
 *      wired up. The DB is canonical.
 *
 * Failures here MUST NOT block the user's share action. The button's
 * primary effect (opening the share sheet, copying to clipboard, etc.)
 * already happened or is about to; this is a side-channel log. We swallow
 * fetch errors silently — surfacing them to the user would be worse UX
 * than missing one row of analytics.
 */
export function logShareIntent(memeId: string, platform: ShareIntentPlatform): void {
  // GA first — synchronous, in-process. No-ops if gtag isn't loaded.
  try {
    trackEvent("share_intent", { meme_id: memeId, platform });
  } catch {
    // never let analytics surface to the caller
  }

  // DB log — fire and forget.
  try {
    void fetch("/api/share-intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memeId, platform }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {
      // swallow — see docstring
    });
  } catch {
    // swallow — see docstring
  }
}
