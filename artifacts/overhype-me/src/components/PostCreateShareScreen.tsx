import { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  CheckCircle,
  Download,
  Copy,
  Check,
  Share2,
  ExternalLink,
  Sparkles,
  Instagram,
  Music2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { GarmentPreview, PRODUCTS } from "@/components/merch/GarmentPreview";
import { useToast } from "@/hooks/use-toast";

// ── Inline brand SVG icons (lucide doesn't ship most brand marks) ────────────

function IconX() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}
function IconFacebook() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}
function IconReddit() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
    </svg>
  );
}
function IconWhatsApp() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}
function IconTelegram() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}
function IconPinterest() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.357-.629-2.747-1.378l-.747 2.853c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
    </svg>
  );
}
function IconThreads() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M17.7 11.13c-.094-.045-.19-.088-.286-.13-.166-3.06-1.84-4.81-4.65-4.83-1.49-.01-2.74.62-3.51 1.83l1.29.88c.57-.86 1.46-1.05 2.21-1.05h.03c.94.006 1.65.28 2.1.81.33.39.55.93.65 1.62-.78-.13-1.62-.17-2.52-.12-2.54.15-4.17 1.63-4.06 3.69.05 1.04.57 1.94 1.45 2.52.74.5 1.7.74 2.7.69 1.32-.07 2.36-.58 3.08-1.5.55-.71.9-1.62 1.05-2.78.62.37 1.07.86 1.32 1.46.43 1.01.46 2.66-.89 4.01-1.18 1.18-2.6 1.69-4.74 1.71-2.38-.02-4.18-.78-5.36-2.27-1.1-1.39-1.67-3.4-1.69-5.97.02-2.57.59-4.58 1.69-5.97 1.18-1.49 2.98-2.25 5.36-2.27 2.4.02 4.23.78 5.45 2.28.6.74 1.05 1.66 1.34 2.74l1.55-.41c-.36-1.32-.92-2.45-1.69-3.4C18.69 1.34 16.41.4 13.49.38h-.01C10.57.4 8.34 1.35 6.85 3.21 5.53 4.86 4.84 7.16 4.82 10v.01c.02 2.84.71 5.14 2.03 6.79 1.49 1.86 3.72 2.81 6.63 2.83h.01c2.59-.02 4.41-.7 5.92-2.21 1.97-1.97 1.91-4.43 1.26-5.94-.46-1.08-1.34-1.96-2.55-2.55h-.42zm-4.27 4.4c-1.11.06-2.26-.44-2.32-1.52-.04-.8.57-1.69 2.39-1.8.21-.01.41-.02.61-.02.66 0 1.27.06 1.83.18-.21 2.61-1.43 3.1-2.51 3.16z" />
    </svg>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function openPopup(url: string) {
  window.open(url, "_blank", "width=600,height=540,noopener,noreferrer");
}

interface PostCreateShareScreenProps {
  /**
   * Permalink slug for the meme — used for the canonical share URL and
   * /wear/:slug link. When omitted (e.g. AI video tab where the generated
   * video doesn't yet have a permalink), the share buttons fall back to
   * the raw `mediaUrl` and the merch teaser / "View permalink" CTA are
   * hidden.
   */
  permalinkSlug?: string;
  /** The image or video URL (used for downloads and Pinterest media param) */
  mediaUrl: string;
  /** Whether this is a still meme or a video meme — affects the Pinterest button and download filename */
  mediaKind: "image" | "video";
  /** Headline fact text — used as default share copy */
  factText?: string;
  /** "photo" if the user used their own photo (drives the MemePage afterglow upgrade card) */
  source?: "photo" | "other";
  /** Called when the user taps "Make Another" — should reset the builder back to its initial state */
  onMakeAnother: () => void;
  /** Optional override for the download action (e.g. canvas.toDataURL). When omitted, the media URL is fetched and downloaded. */
  onDownload?: () => void;
}

export function PostCreateShareScreen({
  permalinkSlug,
  mediaUrl,
  mediaKind,
  factText,
  source = "other",
  onMakeAnother,
  onDownload,
}: PostCreateShareScreenProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  // When we have a permalink slug we share that canonical URL; otherwise
  // (video tab, no save flow yet) we share the raw media URL.
  const publicShareUrl = useMemo(() => {
    if (permalinkSlug) {
      if (typeof window === "undefined") return `/meme/${permalinkSlug}`;
      return `${window.location.origin}/meme/${permalinkSlug}`;
    }
    return mediaUrl;
  }, [permalinkSlug, mediaUrl]);

  const wearHref = permalinkSlug ? `/wear/${permalinkSlug}?source=share-screen` : null;

  const shareText = factText
    ? `${factText} — overhype.me`
    : "Check out this overhyped fact on overhype.me";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(publicShareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Please copy the link manually.", variant: "destructive" });
    }
  };

  const handleNativeShare = async () => {
    if (!navigator.share) {
      void handleCopy();
      return;
    }
    try {
      await navigator.share({ title: "Overhype.me", text: shareText, url: publicShareUrl });
    } catch {
      // user dismissed — no-op
    }
  };

  const handleDownload = async () => {
    if (onDownload) {
      onDownload();
      return;
    }
    try {
      const res = await fetch(mediaUrl);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `overhype-${permalinkSlug ?? Date.now()}.${mediaKind === "video" ? "mp4" : "jpg"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch {
      toast({ title: "Download failed", description: "Please try right-click → Save.", variant: "destructive" });
    }
  };

  // App-only platforms (Instagram, TikTok) don't have web share intents.
  // We download the media and surface a quick copy-link toast, so the user
  // can paste it once they switch into the native app.
  const handleAppShare = async (platform: "Instagram" | "TikTok") => {
    await handleDownload();
    try {
      await navigator.clipboard.writeText(publicShareUrl);
    } catch {
      // ignore — they still have the file
    }
    toast({
      title: `Saved for ${platform}`,
      description: `${mediaKind === "video" ? "Video" : "Image"} downloaded and link copied — open ${platform} and paste.`,
    });
  };

  // Pinterest accepts a `media` URL param (only for images — the video URL
  // would just create a link pin).
  const handlePinterest = () => {
    const params = new URLSearchParams({
      url: publicShareUrl,
      description: shareText,
    });
    if (mediaKind === "image") params.set("media", mediaUrl);
    openPopup(`https://pinterest.com/pin/create/button/?${params.toString()}`);
  };

  const platformButtons = [
    {
      key: "x",
      label: "X / Twitter",
      icon: <IconX />,
      brand: "#1d9bf0",
      onClick: () =>
        openPopup(
          `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(publicShareUrl)}`,
        ),
    },
    {
      key: "facebook",
      label: "Facebook",
      icon: <IconFacebook />,
      brand: "#1877f2",
      onClick: () => openPopup(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicShareUrl)}`),
    },
    {
      key: "reddit",
      label: "Reddit",
      icon: <IconReddit />,
      brand: "#ff4500",
      onClick: () =>
        openPopup(
          `https://www.reddit.com/submit?url=${encodeURIComponent(publicShareUrl)}&title=${encodeURIComponent(shareText)}`,
        ),
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      icon: <IconWhatsApp />,
      brand: "#25d366",
      onClick: () =>
        openPopup(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${publicShareUrl}`)}`),
    },
    {
      key: "telegram",
      label: "Telegram",
      icon: <IconTelegram />,
      brand: "#0088cc",
      onClick: () =>
        openPopup(
          `https://t.me/share/url?url=${encodeURIComponent(publicShareUrl)}&text=${encodeURIComponent(shareText)}`,
        ),
    },
    {
      key: "threads",
      label: "Threads",
      icon: <IconThreads />,
      brand: "#ffffff",
      onClick: () =>
        openPopup(
          `https://www.threads.net/intent/post?text=${encodeURIComponent(`${shareText} ${publicShareUrl}`)}`,
        ),
    },
    {
      key: "pinterest",
      label: "Pinterest",
      icon: <IconPinterest />,
      brand: "#e60023",
      onClick: handlePinterest,
    },
    {
      key: "instagram",
      label: "Instagram",
      icon: <Instagram className="w-4 h-4" />,
      brand: "#e1306c",
      onClick: () => void handleAppShare("Instagram"),
    },
    {
      key: "tiktok",
      label: "TikTok",
      icon: <Music2 className="w-4 h-4" />,
      brand: "#ffffff",
      onClick: () => void handleAppShare("TikTok"),
    },
  ];

  return (
    <div className="space-y-5">
      {/* ── Success header ─────────────────────────────────────────── */}
      <div className="bg-primary/10 border-2 border-primary p-4 flex items-center gap-3 text-primary">
        <CheckCircle className="w-5 h-5 shrink-0" />
        <div className="flex-1">
          <p className="font-display uppercase tracking-wide font-bold text-sm">
            {mediaKind === "video" ? "Video Created!" : "Meme Created!"}
          </p>
          <p className="text-xs text-primary/80 font-normal mt-0.5">
            Share it anywhere — or wear it on something real.
          </p>
        </div>
      </div>

      {/* ── Per-platform share grid ────────────────────────────────── */}
      <div className="border border-border bg-secondary p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-display font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Share on
          </p>
          {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
            <button
              onClick={() => void handleNativeShare()}
              className="text-[10px] font-display font-bold uppercase tracking-[0.18em] text-primary hover:text-primary/80 inline-flex items-center gap-1"
            >
              <Share2 className="w-3 h-3" /> Quick share
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {platformButtons.map((b) => (
            <button
              key={b.key}
              onClick={b.onClick}
              className="flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-sm border border-border bg-background text-muted-foreground text-[11px] font-bold uppercase tracking-wider transition-all hover:text-foreground hover:border-foreground/40"
              style={{
                // Use the brand color as a CSS variable so the per-button
                // hover style can highlight without a stylesheet.
                ["--brand" as string]: b.brand,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = b.brand;
                e.currentTarget.style.color = b.brand;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "";
                e.currentTarget.style.color = "";
              }}
            >
              {b.icon}
              <span className="hidden sm:inline truncate">{b.label}</span>
            </button>
          ))}
        </div>

        {/* ── Copy link row ────────────────────────────────────────── */}
        <button
          onClick={() => void handleCopy()}
          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-sm border border-border bg-background hover:border-primary/40 transition-colors group"
        >
          <span className="text-xs text-muted-foreground truncate font-mono">
            {publicShareUrl.replace(/^https?:\/\//, "")}
          </span>
          <span
            className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider shrink-0 transition-colors ${
              copied ? "text-green-500" : "text-muted-foreground group-hover:text-foreground"
            }`}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" /> Copy link
              </>
            )}
          </span>
        </button>
      </div>

      {/* ── Wear-it / merch teaser ────────────────────────────────── */}
      {wearHref && (
        <Link
          href={wearHref}
          className="block group border border-border bg-card hover:border-primary/40 transition-colors overflow-hidden"
        >
          <div className="flex">
            <div className="w-24 sm:w-32 shrink-0 bg-secondary border-r border-border relative">
              {/* Tee preview — uses the same component as MemePage so the
                  visual language is consistent across the wear journey. */}
              <div className="aspect-square w-full">
                <GarmentPreview type="tee" accentColor="#0F0F11" imageUrl={mediaKind === "image" ? mediaUrl : undefined} />
              </div>
            </div>
            <div className="flex-1 p-4 flex flex-col justify-between">
              <div>
                <p className="text-[10px] font-display font-bold tracking-[0.18em] text-primary uppercase mb-1 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Wear it
                </p>
                <h3 className="font-display font-bold text-base uppercase tracking-tight leading-tight mb-1">
                  Put this on something
                </h3>
                <p className="text-xs text-muted-foreground leading-snug">
                  Tee · hoodie · mug · sticker. From $5. {PRODUCTS.length} options.
                </p>
              </div>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-display font-bold uppercase tracking-wider text-primary group-hover:gap-2 transition-all">
                Pick a thing <ExternalLink className="w-3 h-3" />
              </span>
            </div>
          </div>
        </Link>
      )}

      {/* ── Footer actions ─────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {permalinkSlug && (
          <Link href={`/meme/${permalinkSlug}?just_created=1&source=${source}`} className="flex-1 min-w-[140px]">
            <Button size="sm" variant="outline" className="w-full gap-2">
              <Share2 className="w-4 h-4" /> View permalink
            </Button>
          </Link>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="flex-1 min-w-[140px] gap-2"
          onClick={() => void handleDownload()}
        >
          <Download className="w-4 h-4" /> Download
        </Button>
        <Button size="sm" className="flex-1 min-w-[140px]" onClick={onMakeAnother}>
          Make another
        </Button>
      </div>
    </div>
  );
}
