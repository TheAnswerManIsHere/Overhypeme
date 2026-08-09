/**
 * MBFO-2 stub of the cross-app "Go Legendary" upgrade modal.
 *
 * MBFO-5 WIRE-UP: the body, value-prop list, and CTA are placeholders. The
 * final version will embed Stripe Checkout (Stripe Embedded Checkout) instead
 * of redirecting to /pricing.
 *
 * Used by:
 *   - Wizard Step 1 video card (free / unregistered)
 *   - Wizard Step 2 AI source tab (free / unregistered)  — MBFO-3
 *   - Phase-5 detail-page upsells                          — MBFO-5
 *
 * Context drives the headline; the body is constant.
 */

import { Crown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/Button";

export type UpgradeModalContext =
  | "video-card"
  | "ai-tab"
  | "private-meme"
  | "detail-upsell";

interface Props {
  open: boolean;
  onClose: () => void;
  context: UpgradeModalContext;
  /** Optional override for the headline. Defaults to a context-aware string. */
  headline?: string;
}

/**
 * Module-level navigation seam — tests stub this instead of fighting jsdom's
 * non-configurable `window.location.assign`. MBFO-5 will replace the impl
 * with Stripe Embedded Checkout.
 */
export const upgradeNavigation = {
  go(path: string) {
    window.location.assign(path);
  },
};

function navigateToUpgrade() {
  upgradeNavigation.go("/pricing");
}

const CONTEXT_HEADLINES: Record<UpgradeModalContext, string> = {
  "video-card": "Go Legendary to make videos.",
  "ai-tab": "Go Legendary to stylize with AI.",
  "private-meme": "Go Legendary to keep memes private.",
  "detail-upsell": "Go Legendary to unlock the full kit.",
};

const VALUE_PROPS = [
  "AI-stylized images that put your face in the meme",
  "Video memes — your likeness, in motion, with captions",
  "Higher monthly generation budget",
  "First access to new engines and styles",
];

export function UnifiedUpgradeModal({ open, onClose, context, headline }: Props) {
  const title = headline ?? CONTEXT_HEADLINES[context];

  const handleUpgrade = () => {
    // MBFO-5 WIRE-UP: replace with Stripe Embedded Checkout in-modal.
    navigateToUpgrade();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-testid="unified-upgrade-modal">
        <DialogHeader>
          <div className="flex items-center justify-center gap-2 text-[#ff6b35]">
            <Crown className="w-6 h-6" aria-hidden="true" />
            <span className="font-mono text-xs uppercase tracking-widest">Legendary</span>
          </div>
          <DialogTitle className="font-display text-3xl uppercase text-center">
            {title}
          </DialogTitle>
          <DialogDescription className="text-center">
            Where legends are made up.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-sm text-white/80">
          {VALUE_PROPS.map((prop) => (
            <li key={prop} className="flex items-start gap-2">
              <span className="text-[#ff6b35] mt-0.5" aria-hidden="true">★</span>
              <span>{prop}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2 pt-2">
          <Button
            type="button"
            onClick={handleUpgrade}
            data-testid="unified-upgrade-cta"
          >
            Go Legendary
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
