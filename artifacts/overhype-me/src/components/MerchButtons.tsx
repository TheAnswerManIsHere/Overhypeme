import { ShoppingBag, ExternalLink, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import { trackAffiliateClick } from "@/lib/affiliate";
import { useAuth } from "@workspace/replit-auth-web";

interface MerchButtonsProps {
  sourceType: "fact" | "meme";
  sourceId: string | number;
  text: string;
  imageUrl?: string;
}

export function MerchButtons({ sourceType, sourceId, text, imageUrl }: MerchButtonsProps) {
  const { role } = useAuth();
  const isRealAdmin = role === "admin";
  const isMeme = sourceType === "meme";

  const href = isMeme
    ? `/api/memes/${sourceId}/zazzle-redirect?returnUrl=${encodeURIComponent(window.location.href)}`
    : undefined;

  const rawHref = isMeme && isRealAdmin
    ? `/api/memes/${sourceId}/zazzle-redirect-raw?returnUrl=${encodeURIComponent(window.location.href)}`
    : undefined;

  const [adminPreviewUrl, setAdminPreviewUrl] = useState<string | null>(null);
  const [adminRawPreviewUrl, setAdminRawPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isRealAdmin) return;
    const returnUrl = window.location.href;
    if (isMeme) {
      const previewHref = `/api/memes/${sourceId}/zazzle-redirect?preview=true&returnUrl=${encodeURIComponent(returnUrl)}`;
      fetch(previewHref, { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data: { url?: string } | null) => { if (data?.url) setAdminPreviewUrl(data.url); })
        .catch(() => {});

      const rawPreviewHref = `/api/memes/${sourceId}/zazzle-redirect-raw?preview=true&returnUrl=${encodeURIComponent(returnUrl)}`;
      fetch(rawPreviewHref, { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data: { url?: string } | null) => { if (data?.url) setAdminRawPreviewUrl(data.url); })
        .catch(() => {});
    } else {
      const params = new URLSearchParams({ returnUrl });
      if (imageUrl) params.set("imageUrl", imageUrl);
      fetch(`/api/affiliate/zazzle-url?${params}`, { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data: { url?: string } | null) => { if (data?.url) setAdminPreviewUrl(data.url); })
        .catch(() => {});
    }
  }, [isRealAdmin, isMeme, sourceId, imageUrl]);

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    trackEvent("affiliate_click", { destination: "zazzle", source_type: sourceType });

    if (isMeme) {
      trackAffiliateClick(sourceType, sourceId, "zazzle", text, imageUrl);
      return;
    }

    e.preventDefault();

    const popup = window.open("about:blank", "_blank", "noreferrer");

    fetch("/api/affiliate/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        sourceType,
        sourceId: String(sourceId),
        destination: "zazzle",
        text,
        imageUrl,
        returnUrl: window.location.href,
      }),
    })
      .then((r) => r.json())
      .then((data: { url?: string }) => {
        if (data.url && popup) {
          popup.location.href = data.url;
        } else if (data.url) {
          window.location.assign(data.url);
        } else {
          popup?.close();
        }
      })
      .catch(() => {
        popup?.close();
      });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShoppingBag className="w-3.5 h-3.5" />
          <span>Make merch:</span>
        </div>
        <a
          href={href ?? "#"}
          target={isMeme ? "_blank" : undefined}
          rel="noreferrer"
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground font-medium transition-colors"
        >
          <ExternalLink className="w-3 h-3" />
          Zazzle
        </a>
        {isRealAdmin && isMeme && rawHref && (
          <a
            href={rawHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border border-dashed border-amber-400 dark:border-amber-700 bg-transparent text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 font-medium transition-colors"
            title="Admin debug: skips the regenerate-and-republish step and hands Zazzle the meme's normal image URL"
          >
            <ExternalLink className="w-3 h-3" />
            Zazzle (raw)
          </a>
        )}
      </div>
      {isRealAdmin && adminPreviewUrl && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 max-w-full">
          <Link2 className="w-3 h-3 mt-0.5 shrink-0" />
          <a
            href={adminPreviewUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all hover:underline font-mono leading-tight"
            title="Admin debug: fully constructed Zazzle URL"
          >
            {adminPreviewUrl}
          </a>
        </div>
      )}
      {isRealAdmin && isMeme && adminRawPreviewUrl && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-dashed border-amber-300 dark:border-amber-800 rounded px-2 py-1 max-w-full">
          <Link2 className="w-3 h-3 mt-0.5 shrink-0" />
          <a
            href={adminRawPreviewUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all hover:underline font-mono leading-tight"
            title="Admin debug: fully constructed Zazzle URL (raw — uses meme's normal image URL, no re-export)"
          >
            {adminRawPreviewUrl}
          </a>
        </div>
      )}
    </div>
  );
}
