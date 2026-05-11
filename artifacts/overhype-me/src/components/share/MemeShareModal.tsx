import { useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Share2, Link as LinkIcon, Mail } from "lucide-react";
import { useWebShareSupport } from "./useWebShareSupport";
import { logShareIntent } from "./shareIntent";
import { fetchShareCopy } from "./shareCopy";

/**
 * Phase-6 meme share modal — mobile-first, three buttons.
 *
 * The product is overwhelmingly mobile-consumed by a US-centric audience.
 * Web Share API is the primary share path on mobile, not a fallback —
 * tapping "Share" opens the native OS share sheet, exposing iMessage,
 * Mail, WhatsApp, Messenger, AirDrop, Notes, and every messaging app the
 * user has installed. Desktop browsers without Web Share API get an Email
 * fallback (mailto:), which works everywhere and requires no API
 * integration.
 *
 * Architecturally distinct from the existing fact-share modal:
 * fact-sharing rewrites the URL with the recipient's name so they see the
 * fact rendered with their own name. Meme sharing pushes a canonical
 * artifact — the image is pre-rendered with the creator's name baked in —
 * so the recipient sees the same thing the creator did. No name swap.
 *
 * Pre-filled copy and intent URLs come from /api/share-copy/:memeId/:platform
 * (server-side; editable in admin_config without a redeploy). The component
 * itself owns zero copy.
 */

// X / Twitter glyph. Inline to avoid a lucide-react brand-icon dependency
// (lucide deliberately dropped brand glyphs).
function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

export interface MemeShareModalProps {
  open: boolean;
  onClose: () => void;
  /** Permalink slug (the value in /m/:slug). Used as memeId in API calls. */
  slug: string;
  /**
   * Fallback permalink used when the share-copy fetch fails — typically the
   * value `${window.location.origin}/m/${slug}`. Kept as a prop so server-
   * rendered / preview environments can override.
   */
  fallbackPermalink: string;
}

interface ShareButtonProps {
  testId: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

function ShareButton({ testId, label, icon, onClick }: ShareButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={[
        // Generous 56-pt-equivalent touch target; large by design — see brief.
        "group flex w-full items-center gap-4 rounded-lg border-2 border-border bg-secondary",
        "px-5 py-4 text-left transition-all duration-200",
        "hover:border-primary hover:bg-primary/5 hover:text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "active:scale-[0.99]",
      ].join(" ")}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-background text-foreground group-hover:bg-primary/10 group-hover:text-primary">
        {icon}
      </span>
      <span className="font-display text-lg uppercase tracking-wide">{label}</span>
    </button>
  );
}

export function MemeShareModal({ open, onClose, slug, fallbackPermalink }: MemeShareModalProps) {
  const { toast } = useToast();
  const webShareSupported = useWebShareSupport();

  const handleWebShare = useCallback(async () => {
    const copy = await fetchShareCopy(slug, "web_share");
    const payload = copy
      ? { title: copy.title, text: copy.text, url: copy.url }
      : { title: "overhype.me", text: "Where legends are made up.", url: fallbackPermalink };
    try {
      await navigator.share(payload);
      logShareIntent(slug, "web_share");
      onClose();
    } catch (err) {
      // AbortError = user dismissed the share sheet without picking an app.
      // Silent — that's a deliberate user action, not an error.
      if (err instanceof Error && err.name === "AbortError") return;
      toast({
        title: "Couldn't share",
        description: "Try Copy Link instead.",
        variant: "destructive",
      });
    }
  }, [slug, fallbackPermalink, toast, onClose]);

  const handleTwitter = useCallback(async () => {
    const copy = await fetchShareCopy(slug, "twitter");
    // Server-built intent URL is correctly encoded; fall back to a minimal
    // composer if the fetch failed entirely.
    const url = copy?.intentUrl
      ?? `https://twitter.com/intent/tweet?url=${encodeURIComponent(fallbackPermalink)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    logShareIntent(slug, "twitter");
    onClose();
  }, [slug, fallbackPermalink, onClose]);

  const handleCopyLink = useCallback(async () => {
    const copy = await fetchShareCopy(slug, "copy_link");
    const link = copy?.url ?? fallbackPermalink;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        // Legacy fallback for environments without the Clipboard API.
        // Vanishingly rare in our 2026 target matrix; documented in code.
        const ta = document.createElement("textarea");
        ta.value = link;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: "Link copied", description: "Paste it anywhere." });
      logShareIntent(slug, "copy_link");
      onClose();
    } catch {
      toast({
        title: "Couldn't copy link",
        description: "Long-press the address bar to copy manually.",
        variant: "destructive",
      });
    }
  }, [slug, fallbackPermalink, toast, onClose]);

  const handleEmail = useCallback(async () => {
    const copy = await fetchShareCopy(slug, "email");
    const url = copy?.intentUrl
      ?? `mailto:?subject=${encodeURIComponent("Check this out on overhype.me")}&body=${encodeURIComponent(fallbackPermalink)}`;
    window.location.href = url;
    logShareIntent(slug, "email");
    onClose();
  }, [slug, fallbackPermalink, onClose]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        // Behavior: Radix Dialog already handles backdrop-click, Escape, and
        // focus trapping. The X close button is rendered by DialogContent.
        // Mobile swipe-down isn't first-class in Radix Dialog — backdrop
        // tap and the top-right X cover the typical mobile dismiss flows
        // (the bottom-aligned class below makes the modal feel like a
        // bottom sheet so the backdrop is the entire upper half).
        className="sm:max-w-md gap-6"
        data-testid="meme-share-modal"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-3xl uppercase tracking-wide text-primary">
            Share this meme
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3" role="group" aria-label="Share options">
          {webShareSupported === null ? (
            // First paint while the runtime probe resolves. Render a neutral
            // skeleton so the wrong button set never flashes — the probe
            // settles within one paint cycle.
            <>
              <ShareButtonSkeleton />
              <ShareButtonSkeleton />
              <ShareButtonSkeleton />
            </>
          ) : webShareSupported ? (
            <ShareButton
              testId="share-modal-web-share"
              label="Share"
              icon={<Share2 className="h-5 w-5" />}
              onClick={handleWebShare}
            />
          ) : (
            <ShareButton
              testId="share-modal-email"
              label="Email"
              icon={<Mail className="h-5 w-5" />}
              onClick={handleEmail}
            />
          )}

          <ShareButton
            testId="share-modal-twitter"
            label="Twitter / X"
            icon={<IconX className="h-5 w-5" />}
            onClick={handleTwitter}
          />

          <ShareButton
            testId="share-modal-copy-link"
            label="Copy Link"
            icon={<LinkIcon className="h-5 w-5" />}
            onClick={handleCopyLink}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareButtonSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="h-[68px] w-full animate-pulse rounded-lg border-2 border-border bg-secondary/50"
    />
  );
}

export default MemeShareModal;
