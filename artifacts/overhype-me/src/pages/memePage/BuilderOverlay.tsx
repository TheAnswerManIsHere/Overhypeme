import { Suspense, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { lazyWithRetry } from "@/lib/lazy-retry";
import { useAuth } from "@workspace/replit-auth-web";
import {
  roleToTier,
  extractObjectPath,
} from "@/components/meme-builder/integration/studioAdapter";
import type {
  BuilderResult,
  EntryFlow,
  Mode,
} from "@/components/meme-builder/types";
import { X } from "lucide-react";

const MemeBuilder = lazyWithRetry(() =>
  import("@/components/meme-builder/MemeBuilder").then((m) => ({ default: m.MemeBuilder }))
);

export interface BuilderOverlayProps {
  open: boolean;
  onClose: () => void;
  factId: string | number;
  /** Tokenized fact template, e.g. `"{NAME} fought a bear and won."` */
  factText: string;
  mode: Mode;
  entryFlow: EntryFlow;
  initialStockImageId?: string;
  initialName?: string;
  initialPronouns?: string;
}

export function BuilderOverlay({
  open,
  onClose,
  factId,
  factText,
  mode,
  entryFlow,
  initialStockImageId,
  initialName,
  initialPronouns,
}: BuilderOverlayProps) {
  const [, setLocation] = useLocation();
  const { user, role } = useAuth();
  const tier = roleToTier(role);
  const primaryImageObjectPath = extractObjectPath(user?.profileImageUrl);
  const [showUploadNudge, setShowUploadNudge] = useState(false);

  // The "free user with no photo" case opens the builder in stock mode but
  // surfaces a nudge to upload a photo. We compute the nudge once at open
  // time so it doesn't re-trigger on builder state changes.
  useEffect(() => {
    if (!open) return;
    setShowUploadNudge(
      mode === "stock"
      && tier !== "unregistered"
      && !primaryImageObjectPath
      && entryFlow === "remix",
    );
  }, [open, mode, tier, primaryImageObjectPath, entryFlow]);

  if (!open) return null;

  const handleComplete = (result: BuilderResult) => {
    if (result.kind === "saved" && result.permalinkUrl) {
      setLocation(result.permalinkUrl);
      return;
    }
    if (result.kind === "signup-required") {
      // The Phase-3 builder already persists the pendingState to
      // sessionStorage. Send the user to login; on return, the studio's
      // resume path will rehydrate.
      window.location.href = `/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    if (result.kind === "upgrade-required") {
      setLocation("/pricing");
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-card">
      <div className="flex items-center justify-between px-5 py-3 border-b-2 border-border shrink-0">
        <h2 className="text-base font-display uppercase tracking-[0.15em] text-foreground">
          Make this fact about you
        </h2>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors p-1"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {showUploadNudge && (
          <div className="mb-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-foreground max-w-3xl mx-auto">
            <span className="font-bold uppercase tracking-wider text-primary mr-2">Tip</span>
            Want your photo in this? Add one in your profile and we&apos;ll use it next time.
          </div>
        )}
        <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading builder…</div>}>
          <div className="max-w-3xl mx-auto">
            <MemeBuilder
              mode={mode}
              factId={String(factId)}
              factText={factText}
              viewerContext={{
                tier,
                userId: user?.id,
                name: user?.displayName ?? undefined,
                pronouns: user?.pronouns ?? undefined,
                primaryImageObjectPath,
                hasLibraryImages: tier !== "unregistered",
              }}
              entryFlow={entryFlow}
              initialStockImageId={initialStockImageId}
              initialName={initialName}
              initialPronouns={initialPronouns}
              onComplete={handleComplete}
              onCancel={onClose}
            />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
