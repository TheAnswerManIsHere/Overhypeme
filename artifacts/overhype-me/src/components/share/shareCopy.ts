import type { ShareIntentPlatform } from "./shareIntent";

export interface TwitterShareCopy {
  platform: "twitter";
  url: string;
  text: string;
  hashtags: string[];
  intentUrl: string;
}
export interface WebShareCopy {
  platform: "web_share";
  url: string;
  title: string;
  text: string;
}
export interface CopyLinkCopy {
  platform: "copy_link";
  url: string;
}
export interface EmailShareCopy {
  platform: "email";
  url: string;
  subject: string;
  body: string;
  intentUrl: string;
}

export type ShareCopyResponse =
  | TwitterShareCopy
  | WebShareCopy
  | CopyLinkCopy
  | EmailShareCopy;

/**
 * Fetches the pre-filled share copy for one platform from the server. The
 * server holds every template in `admin_config` so admins can edit copy
 * without a redeploy. Returns `null` on any error — callers should
 * gracefully degrade (typically: fall back to copy-link with the raw
 * permalink).
 */
export async function fetchShareCopy<T extends ShareIntentPlatform>(
  memeSlug: string,
  platform: T,
): Promise<Extract<ShareCopyResponse, { platform: T }> | null> {
  try {
    const res = await fetch(
      `/api/share-copy/${encodeURIComponent(memeSlug)}/${encodeURIComponent(platform)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as ShareCopyResponse;
    if (data.platform !== platform) return null;
    return data as Extract<ShareCopyResponse, { platform: T }>;
  } catch {
    return null;
  }
}
