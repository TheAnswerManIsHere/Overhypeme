import { Suspense } from "react";
import { useLocation } from "wouter";
import { lazyWithRetry } from "@/lib/lazy-retry";
import { useAuth } from "@workspace/replit-auth-web";
import { roleToIdentity } from "@/components/meme-builder/integration/studioAdapter";
import type {
  BuilderResult,
  EntryFlow,
  Mode,
} from "@/components/meme-builder/types";
import { upgradeDestination } from "@/pages/memePage/upgradeDestination";
import { usePersonName } from "@/hooks/use-person-name";
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
  initialName,
  initialPronouns,
}: BuilderOverlayProps) {
  const [, setLocation] = useLocation();
  const { user, role, entitlements } = useAuth();
  const tier = roleToIdentity(role);
  const { name: guestName, pronouns: guestPronouns } = usePersonName();

  if (!open) return null;

  const handleComplete = (result: BuilderResult) => {
    if (result.kind === "saved" && result.permalinkUrl) {
      onClose();
      setLocation(result.permalinkUrl);
      return;
    }
    if (result.kind === "upgrade-required") {
      const dest = upgradeDestination(result.targetTier, window.location.pathname + window.location.search);
      if (dest.fullPage) window.location.href = dest.href;
      else setLocation(dest.href);
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
        <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading builder…</div>}>
          <div className="max-w-3xl mx-auto">
            <MemeBuilder
              mode={mode}
              factId={String(factId)}
              factText={factText}
              viewerContext={{
                tier,
                entitlements,
                userId: user?.id,
                name: user?.displayName ?? (tier === "unregistered" ? guestName : undefined),
                pronouns: user?.pronouns ?? (tier === "unregistered" ? guestPronouns : undefined),
                hasLibraryImages: tier !== "unregistered",
              }}
              entryFlow={entryFlow}
              initialName={initialName ?? (tier === "unregistered" ? guestName : undefined)}
              initialPronouns={initialPronouns ?? (tier === "unregistered" ? guestPronouns : undefined)}
              onComplete={handleComplete}
              onCancel={onClose}
            />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
