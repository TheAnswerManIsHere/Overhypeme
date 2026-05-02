import { useState, Suspense } from "react";
import { lazyWithRetry } from "@/lib/lazy-retry";
import {
  X,
  ImageIcon,
  Video,
  Loader2,
  Sparkles,
  Lock,
} from "lucide-react";
import type { AiMemeImages } from "@/types/meme";
import type { FactPexelsImages } from "@/types/pexels";
import { useAuth } from "@workspace/replit-auth-web";
import { AccessGate } from "@/components/AccessGate";
import type { VideoTabProps } from "@/components/MemeStudioVideoTab";

// ─── Lazy sub-chunks ─────────────────────────────────────────────────────────

const MemeBuilder = lazyWithRetry(() =>
  import("@/components/MemeBuilder").then((m) => ({ default: m.MemeBuilder }))
);

const VideoTab = lazyWithRetry(() => import("@/components/MemeStudioVideoTab"));

// ─── Types ──────────────────────────────────────────────────────────────────

type StudioTab = "image" | "video";

interface MemeStudioProps {
  factId: number;
  factText: string;
  rawFactText?: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  onClose: () => void;
  defaultPrivate?: boolean;
  defaultTab?: StudioTab;
  /** Pre-loaded meme image data URL to use as video source (from external "Turn Into Video" flow) */
  initialVideoImageDataUrl?: string;
}

// ─── Suspense fallback ───────────────────────────────────────────────────────

function TabLoader() {
  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
}

// ─── Tab button ──────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
  locked,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  locked?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 flex items-center justify-center gap-1.5 py-3 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-all ${
        active
          ? "border-[#ff6b35] text-[#ff6b35]"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {icon}
      {label}
      {locked && (
        <Lock className="w-3 h-3 text-amber-400 shrink-0" />
      )}
    </button>
  );
}

// ─── MemeStudio ───────────────────────────────────────────────────────────────

export function MemeStudio({
  factId,
  factText,
  rawFactText,
  pexelsImages,
  aiMemeImages,
  onClose,
  defaultPrivate,
  defaultTab = "image",
  initialVideoImageDataUrl,
}: MemeStudioProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>(defaultTab);
  const { role, isAuthenticated } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";

  const videoTabProps: VideoTabProps = {
    factId,
    factText,
    pexelsImages: pexelsImages as VideoTabProps["pexelsImages"],
    aiMemeImages,
    initialImageDataUrl: initialVideoImageDataUrl,
    defaultPrivate,
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-card">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b-2 border-border shrink-0">
        <h2 className="text-base font-display uppercase tracking-[0.15em] text-foreground flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#ff6b35]" />
          Meme Studio
        </h2>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors p-1"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex border-b-2 border-border shrink-0">
        <TabButton
          active={activeTab === "image"}
          onClick={() => setActiveTab("image")}
          icon={<ImageIcon className="w-3.5 h-3.5" />}
          label="Image"
        />
        <TabButton
          active={activeTab === "video"}
          onClick={() => setActiveTab("video")}
          icon={<Video className="w-3.5 h-3.5" />}
          label="Video"
          locked={!isLegendary}
        />
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === "image" ? (
          <Suspense fallback={<TabLoader />}>
            <MemeBuilder
              factId={factId}
              factText={factText}
              rawFactText={rawFactText}
              pexelsImages={pexelsImages}
              aiMemeImages={aiMemeImages}
              onClose={onClose}
              defaultPrivate={defaultPrivate}
              embedded
              fullScreen
            />
          </Suspense>
        ) : !isAuthenticated ? (
          <AccessGate reason="login" description="Log in to bring your face to life with AI video." />
        ) : !isLegendary ? (
          <AccessGate reason="legendary" description="Bring your face to life with AI video — animate yourself starring in any fact." />
        ) : (
          <div className="p-4 md:p-5 max-w-2xl mx-auto">
            <Suspense fallback={<TabLoader />}>
              <VideoTab {...videoTabProps} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
