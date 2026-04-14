const ZAZZLE_AFFILIATE_ID =
  (import.meta.env.VITE_ZAZZLE_AFFILIATE_ID as string | undefined) ??
  "238499514566968751";

/** True when running in the Replit dev environment (mTLS proxy — not reachable by Zazzle). */
function isDevOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host.endsWith(".replit.dev");
  } catch {
    return false;
  }
}

export function buildZazzleUrl(text: string, imageUrl?: string): string {
  const base = `https://www.zazzle.com/api/create/at-${ZAZZLE_AFFILIATE_ID}`;
  const params = new URLSearchParams({
    rf: ZAZZLE_AFFILIATE_ID,
    ax: "DesignBlast",
    ed: "true",
    t_text: text.slice(0, 160),
  });
  // Dev domains use mTLS — Zazzle's servers can't reach them. Skip the image
  // URL in dev so Zazzle opens cleanly. On the deployed app this works normally.
  if (imageUrl && !isDevOrigin(imageUrl)) params.set("t_image0_iid", imageUrl);
  return `${base}?${params}`;
}

export function trackAffiliateClick(
  sourceType: "fact" | "meme",
  sourceId: string | number,
  destination: "zazzle",
  text: string,
  imageUrl?: string,
): void {
  void fetch("/api/affiliate/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      sourceType,
      sourceId: String(sourceId),
      destination,
      text,
      imageUrl,
    }),
  }).catch(() => {});
}
