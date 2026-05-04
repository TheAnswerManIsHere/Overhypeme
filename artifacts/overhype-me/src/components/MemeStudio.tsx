import { useState, useMemo, Suspense } from "react";
import { lazyWithRetry } from "@/lib/lazy-retry";
import {
  X,
  Loader2,
  Sparkles,
  Lock,
  ImageIcon,
  Wand2,
  Video,
  ChevronRight,
  ChevronLeft,
  User as UserIcon,
  Camera,
  Palette,
  Stars,
  Home,
  Trophy,
  Layers,
  Library as LibraryIcon,
} from "lucide-react";
import { Link } from "wouter";
import type { AiMemeImages } from "@/types/meme";
import type { FactPexelsImages } from "@/types/pexels";
import { useAuth } from "@workspace/replit-auth-web";
import { AccessGate } from "@/components/AccessGate";
import { cn } from "@/lib/utils";
import type { VideoTabProps } from "@/components/MemeStudioVideoTab";

// ─── Lazy sub-chunks ─────────────────────────────────────────────────────────

const MemeBuilder = lazyWithRetry(() =>
  import("@/components/MemeBuilder").then((m) => ({ default: m.MemeBuilder }))
);

const VideoTab = lazyWithRetry(() => import("@/components/MemeStudioVideoTab"));

const MemeMagicVideo = lazyWithRetry(() =>
  import("@/components/MemeMagicVideo").then((m) => ({
    default: m.MemeMagicVideo,
  }))
);

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Studio paths — each is a distinct entry into the meme/video flow. We keep
 * the legacy `image` and `video` values as aliases so external openers
 * (FactDetail's `defaultTab`) keep working without a flag day.
 */
export type StudioPath =
  | "hub"
  | "ai-gallery"
  | "photo-image"
  | "stock-image"
  | "gradient-image"
  | "magic-video"
  | "manual-video";

type LegacyTab = "image" | "video";

interface MemeStudioProps {
  factId: number;
  factText: string;
  rawFactText?: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  onClose: () => void;
  defaultPrivate?: boolean;
  /**
   * Legacy entry alias — `image` opens the hub on the image side and `video`
   * lands the user directly on the Manual Video path. New callers should use
   * `defaultPath` instead.
   */
  defaultTab?: LegacyTab;
  /** Direct path entry — bypasses the hub when set. */
  defaultPath?: StudioPath;
  /** Pre-loaded meme image data URL to use as video source */
  initialVideoImageDataUrl?: string;
}

// ─── Suspense fallback ───────────────────────────────────────────────────────

function PathLoader() {
  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
}

// ─── Hub Card primitive ─────────────────────────────────────────────────────

function PathCard({
  icon,
  title,
  subtitle,
  badge,
  locked,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left border-2 transition-all p-4 flex items-center gap-3",
        "border-border bg-card hover:border-primary hover:bg-primary/5",
        locked && "opacity-90"
      )}
    >
      <div
        className={cn(
          "shrink-0 w-12 h-12 flex items-center justify-center border-2 transition-colors",
          "border-border group-hover:border-primary text-foreground group-hover:text-primary"
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold uppercase tracking-wider text-foreground truncate">
            {title}
          </p>
          {badge && (
            <span className="text-[9px] font-display uppercase tracking-widest text-primary bg-primary/10 border border-primary/30 px-1.5 py-0.5">
              {badge}
            </span>
          )}
          {locked && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
          {subtitle}
        </p>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors" />
    </button>
  );
}

// ─── Studio Hub entry ───────────────────────────────────────────────────────

function StudioHub({
  isLegendary,
  onPick,
}: {
  isLegendary: boolean;
  onPick: (p: StudioPath) => void;
}) {
  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-5">
      <header className="space-y-1">
        <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground">
          Studio
        </p>
        <h2 className="text-lg font-bold uppercase tracking-wide flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Make something with this fact
        </h2>
        <p className="text-xs text-muted-foreground">
          Pick a path. You can always change your mind from the back arrow.
        </p>
      </header>

      {/* Image paths */}
      <section className="space-y-2">
        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Image
        </p>
        <div className="grid gap-2">
          {/* Default path order is photo-first for free users; the AI path is
              re-ordered to the top further down for Legendary. */}
          {!isLegendary && (
            <PathCard
              icon={<UserIcon className="w-5 h-5" />}
              title="Photo Editor"
              subtitle="Use your photo (or upload one) and slap text on it."
              onClick={() => onPick("photo-image")}
            />
          )}
          <PathCard
            icon={<Stars className="w-5 h-5" />}
            title="AI Gallery → Image"
            subtitle="Pick or generate an AI scene of you, then add text."
            badge={!isLegendary ? "Legendary" : undefined}
            locked={!isLegendary}
            onClick={() => onPick("ai-gallery")}
          />
          {isLegendary && (
            <PathCard
              icon={<UserIcon className="w-5 h-5" />}
              title="Photo Editor"
              subtitle="Use your photo (or upload one) and slap text on it."
              onClick={() => onPick("photo-image")}
            />
          )}
          <PathCard
            icon={<Camera className="w-5 h-5" />}
            title="Stock Photo"
            subtitle="Pick from curated stock backgrounds matched to this fact."
            onClick={() => onPick("stock-image")}
          />
          <PathCard
            icon={<Palette className="w-5 h-5" />}
            title="Gradient"
            subtitle="Bold abstract background — fastest path to a meme."
            onClick={() => onPick("gradient-image")}
          />
        </div>
      </section>

      {/* Video paths */}
      <section className="space-y-2">
        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Video
        </p>
        <div className="grid gap-2">
          <PathCard
            icon={<Wand2 className="w-5 h-5" />}
            title="Magic Video"
            subtitle="One tap. We pick the best AI scene of you and animate it."
            badge={!isLegendary ? "Legendary" : "One tap"}
            locked={!isLegendary}
            onClick={() => onPick("magic-video")}
          />
          <PathCard
            icon={<Video className="w-5 h-5" />}
            title="Manual Video"
            subtitle="Pick the source, the style, then generate. Full control."
            badge={!isLegendary ? "Legendary" : undefined}
            locked={!isLegendary}
            onClick={() => onPick("manual-video")}
          />
        </div>
      </section>
    </div>
  );
}

// ─── Desktop left rail ──────────────────────────────────────────────────────

function DesktopRail({
  current,
  onPick,
  onClose,
}: {
  current: StudioPath;
  onPick: (p: StudioPath) => void;
  onClose: () => void;
}) {
  return (
    <aside className="hidden lg:flex w-56 shrink-0 flex-col bg-card border-r-2 border-border">
      <div className="px-4 py-3 border-b-2 border-border flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-xs font-display uppercase tracking-[0.15em] text-foreground">
          Studio
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5">
        <RailItem
          icon={<Home className="w-4 h-4" />}
          label="Studio Hub"
          active={current === "hub"}
          onClick={() => onPick("hub")}
        />
        <RailHeader>Image</RailHeader>
        <RailItem
          icon={<Stars className="w-4 h-4" />}
          label="AI Gallery"
          active={current === "ai-gallery"}
          onClick={() => onPick("ai-gallery")}
        />
        <RailItem
          icon={<UserIcon className="w-4 h-4" />}
          label="Photo Editor"
          active={current === "photo-image"}
          onClick={() => onPick("photo-image")}
        />
        <RailItem
          icon={<Camera className="w-4 h-4" />}
          label="Stock Photo"
          active={current === "stock-image"}
          onClick={() => onPick("stock-image")}
        />
        <RailItem
          icon={<Palette className="w-4 h-4" />}
          label="Gradient"
          active={current === "gradient-image"}
          onClick={() => onPick("gradient-image")}
        />
        <RailHeader>Video</RailHeader>
        <RailItem
          icon={<Wand2 className="w-4 h-4" />}
          label="Magic Video"
          active={current === "magic-video"}
          onClick={() => onPick("magic-video")}
        />
        <RailItem
          icon={<Video className="w-4 h-4" />}
          label="Manual Video"
          active={current === "manual-video"}
          onClick={() => onPick("manual-video")}
        />
        <RailHeader>App</RailHeader>
        <RailItem
          icon={<LibraryIcon className="w-4 h-4" />}
          label="Library"
          asLink
          href="/profile"
        />
        <RailItem
          icon={<Trophy className="w-4 h-4" />}
          label="Top Facts"
          asLink
          href="/top-facts"
        />
      </nav>

      <div className="px-4 py-3 border-t-2 border-border">
        <button
          onClick={onClose}
          className="w-full flex items-center justify-center gap-2 text-xs font-display uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="w-3 h-3" />
          Close Studio
        </button>
      </div>
    </aside>
  );
}

function RailHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-3 pb-1 text-[9px] font-display uppercase tracking-[0.2em] text-muted-foreground/60">
      {children}
    </p>
  );
}

function RailItem({
  icon,
  label,
  active,
  onClick,
  asLink,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  asLink?: boolean;
  href?: string;
}) {
  const inner = (
    <span
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors",
        active
          ? "text-primary bg-primary/10 border-l-2 border-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary border-l-2 border-transparent"
      )}
    >
      {icon}
      {label}
    </span>
  );
  if (asLink && href) {
    return <Link href={href}>{inner}</Link>;
  }
  return (
    <button onClick={onClick} className="w-full text-left block">
      {inner}
    </button>
  );
}

// ─── MemeStudio shell ───────────────────────────────────────────────────────

export function MemeStudio({
  factId,
  factText,
  rawFactText,
  pexelsImages,
  aiMemeImages,
  onClose,
  defaultPrivate,
  defaultTab,
  defaultPath,
  initialVideoImageDataUrl,
}: MemeStudioProps) {
  const { role, isAuthenticated } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";

  // Resolve the initial path. When an external opener supplies a pre-loaded
  // meme image for video, jump straight to manual-video so the existing
  // image flows into VideoTab as before.
  const initialPath = useMemo<StudioPath>(() => {
    if (initialVideoImageDataUrl) return "manual-video";
    if (defaultPath) return defaultPath;
    if (defaultTab === "video") return "manual-video";
    return "hub";
  }, [initialVideoImageDataUrl, defaultPath, defaultTab]);

  const [path, setPath] = useState<StudioPath>(initialPath);

  const videoTabBaseProps: Omit<VideoTabProps, "initialPathMode"> = {
    factId,
    factText,
    pexelsImages: pexelsImages as VideoTabProps["pexelsImages"],
    aiMemeImages,
    initialImageDataUrl: initialVideoImageDataUrl,
    defaultPrivate,
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-card">
      {/* ── Desktop left rail (≥1024px) ── */}
      <DesktopRail current={path} onPick={setPath} onClose={onClose} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-3 border-b-2 border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {path !== "hub" && (
              <button
                onClick={() => setPath("hub")}
                className="lg:hidden flex items-center gap-1 text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="w-3 h-3" />
                Studio
              </button>
            )}
            <h2 className="text-base font-display uppercase tracking-[0.15em] text-foreground flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">{titleFor(path)}</span>
              <span className="sm:hidden">{shortTitleFor(path)}</span>
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Path content ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <PathView
            path={path}
            isAuthenticated={isAuthenticated}
            isLegendary={isLegendary}
            onPick={setPath}
            onClose={onClose}
            // pass-throughs
            factId={factId}
            factText={factText}
            rawFactText={rawFactText}
            pexelsImages={pexelsImages}
            aiMemeImages={aiMemeImages}
            defaultPrivate={defaultPrivate}
            videoTabBaseProps={videoTabBaseProps}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Path view router ───────────────────────────────────────────────────────

interface PathViewProps {
  path: StudioPath;
  isAuthenticated: boolean;
  isLegendary: boolean;
  onPick: (p: StudioPath) => void;
  onClose: () => void;
  factId: number;
  factText: string;
  rawFactText?: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  defaultPrivate?: boolean;
  videoTabBaseProps: Omit<VideoTabProps, "initialPathMode">;
}

function PathView({
  path,
  isAuthenticated,
  isLegendary,
  onPick,
  onClose,
  factId,
  factText,
  rawFactText,
  pexelsImages,
  aiMemeImages,
  defaultPrivate,
  videoTabBaseProps,
}: PathViewProps) {
  if (path === "hub") {
    return <StudioHub isLegendary={isLegendary} onPick={onPick} />;
  }

  // ── Image paths ──
  if (
    path === "ai-gallery" ||
    path === "photo-image" ||
    path === "stock-image" ||
    path === "gradient-image"
  ) {
    // Paywall: AI gallery is Legendary-only at the source level; the
    // MemeBuilder will also enforce this internally, but we surface a
    // friendlier full-screen gate at the path entry point.
    if (path === "ai-gallery" && !isAuthenticated) {
      return (
        <div className="p-5 max-w-2xl mx-auto">
          <AccessGate
            reason="login"
            description="Log in to generate AI scenes of you for this fact."
          />
        </div>
      );
    }
    if (path === "ai-gallery" && !isLegendary) {
      return (
        <div className="p-5 max-w-2xl mx-auto">
          <AccessGate
            reason="legendary"
            description="The AI Gallery is a Legendary feature — generate cinematic AI scenes starring you."
          />
        </div>
      );
    }

    const initialPathMode = pathToImageMode(path);
    return (
      <Suspense fallback={<PathLoader />}>
        <MemeBuilder
          factId={factId}
          factText={factText}
          rawFactText={rawFactText}
          pexelsImages={pexelsImages}
          aiMemeImages={aiMemeImages}
          onClose={onClose}
          defaultPrivate={defaultPrivate}
          embedded
          initialPathMode={initialPathMode}
        />
      </Suspense>
    );
  }

  // ── Magic Video ──
  if (path === "magic-video") {
    return (
      <Suspense fallback={<PathLoader />}>
        <MemeMagicVideo
          factId={factId}
          factText={factText}
          aiMemeImages={aiMemeImages}
          onBack={() => onPick("hub")}
          onClose={onClose}
        />
      </Suspense>
    );
  }

  // ── Manual Video ──
  if (path === "manual-video") {
    if (!isAuthenticated) {
      return (
        <div className="p-5 max-w-2xl mx-auto">
          <AccessGate
            reason="login"
            description="Log in to bring your face to life with AI video."
          />
        </div>
      );
    }
    if (!isLegendary) {
      return (
        <div className="p-5 max-w-2xl mx-auto">
          <AccessGate
            reason="legendary"
            description="Bring your face to life with AI video — animate yourself starring in any fact."
          />
        </div>
      );
    }
    return (
      <div className="p-4 md:p-5 max-w-2xl mx-auto">
        <Suspense fallback={<PathLoader />}>
          <VideoTab {...videoTabBaseProps} />
        </Suspense>
      </div>
    );
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pathToImageMode(
  p: StudioPath
): "identity" | "stock" | "gradient" | "ai" | "upload" | undefined {
  switch (p) {
    case "ai-gallery":
      return "ai";
    case "photo-image":
      return "identity";
    case "stock-image":
      return "stock";
    case "gradient-image":
      return "gradient";
    default:
      return undefined;
  }
}

function titleFor(p: StudioPath): string {
  switch (p) {
    case "hub":
      return "Studio";
    case "ai-gallery":
      return "AI Gallery → Image";
    case "photo-image":
      return "Photo Editor";
    case "stock-image":
      return "Stock Photo";
    case "gradient-image":
      return "Gradient";
    case "magic-video":
      return "Magic Video";
    case "manual-video":
      return "Manual Video";
  }
}

function shortTitleFor(p: StudioPath): string {
  switch (p) {
    case "hub":
      return "Studio";
    case "ai-gallery":
      return "AI Gallery";
    case "photo-image":
      return "Photo";
    case "stock-image":
      return "Stock";
    case "gradient-image":
      return "Gradient";
    case "magic-video":
      return "Magic";
    case "manual-video":
      return "Video";
  }
}

// Suppress unused-import warnings for icons that are only used in JSX strings
// when bundlers tree-shake. (Layers/ImageIcon retained for potential future
// hub variants; harmless when unused.)
void ImageIcon;
void Layers;
