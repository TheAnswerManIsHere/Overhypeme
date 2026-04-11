const ZAZZLE_AFFILIATE_ID =
  (import.meta.env.VITE_ZAZZLE_AFFILIATE_ID as string | undefined) ??
  "238527546099265388";

export function buildZazzleUrl(text: string, imageUrl?: string): string {
  const base = `https://www.zazzle.com/api/create/at-${ZAZZLE_AFFILIATE_ID}`;
  const params = new URLSearchParams({
    rf: ZAZZLE_AFFILIATE_ID,
    ax: "DesignBlast",
    sr: "250",
    ed: "true",
    t_text: text.slice(0, 160),
  });
  if (imageUrl) params.set("t_image0_iid", imageUrl);
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
