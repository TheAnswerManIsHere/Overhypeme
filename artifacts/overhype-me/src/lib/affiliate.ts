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
      returnUrl: window.location.href,
    }),
  }).catch(() => {});
}
