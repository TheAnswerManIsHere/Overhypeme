import { useState, useCallback, useEffect, useRef } from "react";
import {
  X,
  ChevronLeft,
  Video,
  Loader2,
  RefreshCw,
  CheckCircle,
  Sparkles,
  Upload,
  Lock,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VideoStyleDef } from "@/config/videoStyles";
import { useVideoStyles } from "@/hooks/use-video-styles";
import type { AiMemeImages } from "@/types/meme";
import type { PexelsPhotoEntry, FactPexelsImages } from "@/types/pexels";
import { AiBgPicker, type AiBgSelection } from "@/components/AiBgPicker";
import { Button } from "@/components/ui/Button";
import { ImageCard } from "@/components/ui/ImageCard";
import { AdminMediaInfo, AdminMediaInfoForUrl, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";
import { PostCreateShareScreen } from "@/components/PostCreateShareScreen";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { AccessGate } from "@/components/AccessGate";

// ─── Types ──────────────────────────────────────────────────────────────────

type VideoStep = 1 | 2 | 3;

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

type VideoImageMode = "stock" | "ai" | "upload" | "identity";

interface StockPhotoEntry {
  id: number;
  photoUrl: string;
  photographerName: string;
  photographerUrl: string;
}

export interface VideoTabProps {
  factId: number;
  factText: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  /** Pre-loaded meme image data URL passed from MemeBuilder's "Turn Into Video" button */
  initialImageDataUrl?: string;
  defaultPrivate?: boolean;
  /**
   * Studio Hub path mode — pre-selects the background source and HIDES the
   * mode-tab strip in step 1. Used when entered via the Studio Hub "Manual
   * Video" path so the user lands directly on the chosen source.
   */
  initialPathMode?: VideoImageMode;
}

// ─── Step indicator ─────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: VideoStep; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all ${
            i + 1 === current
              ? "w-4 h-2 bg-[#ff6b35]"
              : i + 1 < current
              ? "w-2 h-2 bg-[#ff6b35]/60"
              : "w-2 h-2 bg-border"
          }`}
        />
      ))}
    </div>
  );
}

// ─── Style Card ─────────────────────────────────────────────────────────────

function StyleCard({
  style,
  selected,
  onClick,
}: {
  style: VideoStyleDef;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative text-left border-2 transition-all overflow-hidden group ${
        selected
          ? "border-[#ff6b35] shadow-[0_0_0_1px_#ff6b35]"
          : "border-border hover:border-[#ff6b35]/50"
      }`}
    >
      {style.previewGifPath ? (
        <img
          src={`/api/video-styles/${style.id}/preview-gif`}
          alt={`${style.label} preview`}
          className="w-full h-16 sm:h-20 object-cover"
        />
      ) : (
        <div
          className="w-full h-16 sm:h-20 transition-opacity"
          style={{
            background: `linear-gradient(135deg, ${style.gradientFrom} 0%, ${style.gradientTo} 100%)`,
          }}
        >
          <div className="w-full h-full flex items-center justify-center opacity-30">
            <Video className="w-6 h-6 text-white" />
          </div>
        </div>
      )}

      {selected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#ff6b35] flex items-center justify-center">
          <CheckCircle className="w-3 h-3 text-white" />
        </div>
      )}

      <div className="p-2.5 space-y-0.5">
        <p className={`text-xs font-bold uppercase tracking-wider ${selected ? "text-[#ff6b35]" : "text-foreground"}`}>
          {style.label}
        </p>
        <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">
          {style.description}
        </p>
      </div>
    </button>
  );
}


// ─── Video Tab wizard ────────────────────────────────────────────────────────

function VideoTab({ factId, factText, pexelsImages, aiMemeImages, initialImageDataUrl, defaultPrivate, initialPathMode }: VideoTabProps) {
  const { role, user, can } = useAuth();
  const isAdmin = role === "admin";
  // Told, not derived, and split into the TWO entitlements this tab actually
  // consults. "Upload your own photo as a video source" needs nothing beyond
  // being in this already-video_generation-gated tab; "AI Generated" mode
  // additionally needs meme_ai_background, since it renders AiBgPicker, which
  // is a capability an operator can grant or revoke independently of video
  // access. One `isLegendary` boolean covering both meant a grid change to
  // either entitlement couldn't move this screen.
  const canVideo = can("video_generation");
  const canAiBackground = can("meme_ai_background");
  // Independently configurable from video_generation — round 5 of PR #425's
  // review found this toggle rendered unconditionally while the server-side
  // gate (videos.ts) only checked video_generation, letting anyone with video
  // access get the private-visibility perk for free. Matches the image
  // path's `canSetPrivate` gate in MemeBuilder.tsx.
  const canSetPrivate = can("meme_private_visibility");
  const profileImageUrl = user?.profileImageUrl ?? null;
  const { pronouns } = usePersonName();
  const { styles: videoStyles } = useVideoStyles();

  // Start at step 1 (background selection) unless we already have a pre-loaded image
  const [step, setStep] = useState<VideoStep>(initialImageDataUrl ? 2 : 1);
  const [selectedStyleId, setSelectedStyleId] = useState("cinematic");
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });
  const [videoDims, setVideoDims] = useState<{ width: number; height: number } | null>(null);

  // ── Background image state ────────────────────────────────────────────────
  // Default to "identity" so the video creator opens with the "use my face"
  // path. When a profile photo is missing the identity panel renders the
  // inline "add your photo" prompt; when an initialImageDataUrl is supplied
  // (e.g. continuing from an existing photo meme) we honor that and start in
  // stock mode so the preselected image renders immediately.
  const [imageMode, setImageMode] = useState<VideoImageMode>(
    initialPathMode ?? (initialImageDataUrl ? "stock" : "identity")
  );
  // Track explicit tab interactions so future automatic mode promotions
  // won't override a deliberate user choice.
  const userPickedVideoModeRef = useRef(false);
  const [thumbSize, setThumbSize] = useState(40); // 0–100 slider value
  const thumbPx = Math.round(70 + (thumbSize / 100) * (290 - 70)); // 70px–290px

  // Selected background image URL (URL or base64 data URL)
  // Pre-fill with the user's profile photo when defaulting to identity mode.
  const [selectedBgUrl, setSelectedBgUrl] = useState<string | null>(
    initialImageDataUrl ?? (profileImageUrl ? profileImageUrl : null)
  );
  // Human-readable label for the selected background
  const [selectedBgLabel, setSelectedBgLabel] = useState<string | null>(
    initialImageDataUrl ? "From meme builder" : (profileImageUrl ? "Your photo" : null)
  );

  // Stock photos
  const [prefetchedPhotos, setPrefetchedPhotos] = useState<PexelsPhotoEntry[]>([]);
  const [selectedStockIndex, setSelectedStockIndex] = useState<number | null>(null);
  const [isLoadingMorePhotos, setIsLoadingMorePhotos] = useState(false);
  const [hasMorePhotos, setHasMorePhotos] = useState(false);

  // Display limits (from public config)
  const [bgStockLimit, setBgStockLimit] = useState(20);
  const [bgUploadLimit, setBgUploadLimit] = useState(20);
  useEffect(() => {
    fetch("/api/config")
      .then(r => r.ok ? r.json() : {})
      .then((cfg: Record<string, number | string | boolean>) => {
        const s = cfg["bg_display_limit_stock"];
        if (typeof s === "number" && s > 0) setBgStockLimit(s);
        const u = cfg["bg_display_limit_upload"];
        if (typeof u === "number" && u > 0) setBgUploadLimit(u);
      })
      .catch(() => {});
  }, []);

  // AI background selection (via AiBgPicker)
  // factIsGendered: true when the fact has male/female images (not abstract)
  const factIsGendered = (aiMemeImages?.male?.filter(Boolean).length ?? 0) > 0 || (aiMemeImages?.female?.filter(Boolean).length ?? 0) > 0;
  // aiGender: derive from the user's actual pronouns, same logic as MemeBuilder
  const aiGender = ((): "male" | "female" | "neutral" => {
    if (!factIsGendered) return "neutral";
    const p = (pronouns ?? "").toLowerCase();
    if (p.startsWith("he")) return "male";
    if (p.startsWith("she")) return "female";
    return "neutral";
  })();

  // Upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [uploadGallery, setUploadGallery] = useState<Array<{ objectPath: string; width: number; height: number; fileSizeBytes: number }>>([]);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);

  // ── Video generation progress ───────────────────────────────────────────────
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoElapsed, setVideoElapsed] = useState(0);
  const videoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Admin override controls were removed alongside the engine management
  // refactor: /admin/engines is now the canonical surface for picking
  // engines, tuning defaults, and running synthetic test calls (the Test
  // button there hits fal directly without going through this tab). The
  // legacy admin block here was a parallel hardcoded list of ~50 fal
  // endpoints + ~25 useState hooks + ~330 lines of UI that duplicated
  // that work. When the legacy MemeStudio retires at MBFO-5 the whole
  // component goes too.
  const [isVideoPrivate, setIsVideoPrivate] = useState(defaultPrivate ?? false);

  const selectedStyle = videoStyles.find((s) => s.id === selectedStyleId) ?? videoStyles[0];

  // ── Load prefetched Pexels photos on mount ────────────────────────────────
  // This effect ONLY populates the photo list; it intentionally does NOT
  // auto-select a stock photo, because doing so would silently override an
  // identity-mode selection (the user could be on the "You" tab while the
  // effective background was a stock photo). Selection is handled by the
  // mode-sync effect below, which is mode-aware.
  useEffect(() => {
    if (!pexelsImages) return;
    const raw = pexelsImages.neutral ?? pexelsImages.male ?? pexelsImages.female ?? [];
    const mapped = raw.map((entry) =>
      typeof entry === "number"
        ? { id: entry, url: `https://images.pexels.com/photos/${entry}/pexels-photo-${entry}.jpeg?auto=compress&cs=tinysrgb&w=940&h=500&fit=crop&dpr=1` }
        : entry
    );
    setPrefetchedPhotos(mapped);
    setHasMorePhotos(mapped.length > 0);
  }, [pexelsImages]);

  // ── Mode-aware default background selection ───────────────────────────────
  // Whenever imageMode (or the inputs that feed each mode) changes, force the
  // selected background to match the mode so the preview never lies about
  // what will actually render. Skipped when we have an initialImageDataUrl —
  // that path provides its own preselected source the user is editing.
  useEffect(() => {
    if (initialImageDataUrl) return;
    if (imageMode === "identity" && profileImageUrl) {
      setSelectedBgUrl(profileImageUrl);
      setSelectedBgLabel("Your photo");
      return;
    }
    if (imageMode === "stock" && prefetchedPhotos.length > 0 && selectedStockIndex === null) {
      const first = prefetchedPhotos[0]!;
      setSelectedStockIndex(0);
      setSelectedBgUrl(first.url);
      setSelectedBgLabel("Stock photo");
    }
  }, [imageMode, profileImageUrl, prefetchedPhotos, selectedStockIndex, initialImageDataUrl]);

  const loadMorePhotos = useCallback(async () => {
    if (isLoadingMorePhotos) return;
    const gender = pexelsImages?.neutral ? "neutral" : pexelsImages?.male ? "male" : "female";
    setIsLoadingMorePhotos(true);
    try {
      const res = await fetch(`/api/facts/${factId}/pexels-images?gender=${gender}&offset=${prefetchedPhotos.length}`);
      if (!res.ok) throw new Error("Failed to load more photos");
      const data = await res.json() as { photos: PexelsPhotoEntry[]; hasMore: boolean };
      setPrefetchedPhotos(prev => [...prev, ...data.photos]);
      setHasMorePhotos(data.hasMore);
    } catch {
      // silently fail — user can retry
    } finally {
      setIsLoadingMorePhotos(false);
    }
  }, [factId, isLoadingMorePhotos, pexelsImages, prefetchedPhotos.length]);

  // ── Load upload gallery for premium users ─────────────────────────────────
  useEffect(() => {
    if (!canVideo || imageMode !== "upload") return;
    setIsLoadingGallery(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { uploads?: Array<{ objectPath: string; width: number; height: number; fileSizeBytes: number }> }) => {
        setUploadGallery(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => setIsLoadingGallery(false));
  }, [canVideo, imageMode]);


  // ── Clean up video progress timer on unmount ───────────────────────────────
  useEffect(() => {
    return () => {
      if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    };
  }, []);


  const goToStep3 = useCallback(() => {
    setStep(3);
  }, []);

  // ── Generate video ─────────────────────────────────────────────────────────
  const handleGenerateVideo = async () => {
    if (videoState.status === "generating" || !selectedBgUrl) return;

    setVideoState({ status: "generating" });
    setVideoProgress(0);
    setVideoElapsed(0);
    const videoStartTime = Date.now();
    if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    videoTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - videoStartTime) / 1000;
      setVideoElapsed(Math.floor(elapsed));
      let progress: number;
      if (elapsed <= 17) progress = (elapsed / 17) * 80;
      else { const extra = elapsed - 17; progress = 80 + 19 * (1 - Math.exp(-extra / 60)); }
      setVideoProgress(Math.min(progress, 99));
    }, 250);

    try {
      const body: Record<string, unknown> = {
        factId,
        styleId: selectedStyleId,
        renderedFactText: factText,
        isPrivate: isVideoPrivate,
      };

      if (selectedBgUrl.startsWith("data:")) {
        body.imageBase64 = selectedBgUrl;
      } else {
        body.imageUrl = selectedBgUrl.startsWith("/") ? `${window.location.origin}${selectedBgUrl}` : selectedBgUrl;
      }


      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await res.json() as { videoUrl?: string; error?: string };

      if (res.status === 429) {
        if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null; }
        setVideoProgress(0);
        setVideoState({
          status: "error",
          message: data.error ?? "Rate limit exceeded. You can generate up to 3 videos per 24 hours.",
        });
        return;
      }

      if (!res.ok || !data.videoUrl) {
        if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null; }
        setVideoProgress(0);
        setVideoState({
          status: "error",
          message: data.error ?? "Video generation failed. Please try again.",
        });
        return;
      }

      if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null; }
      setVideoProgress(100);
      setVideoState({ status: "done", url: data.videoUrl });
    } catch {
      if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null; }
      setVideoProgress(0);
      setVideoState({
        status: "error",
        message: "Network error. Please check your connection and try again.",
      });
    }
  };

  const handleDownload = () => {
    if (videoState.status !== "done") return;
    const a = document.createElement("a");
    a.href = videoState.url;
    a.download = `overhype-video-${factId}.mp4`;
    a.click();
  };

  // ── Upload handler ─────────────────────────────────────────────────────────
  const handleFileUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setIsUploadingFile(true);
    try {
      const localUrl = URL.createObjectURL(file);
      setSelectedBgUrl(localUrl);
      setSelectedBgLabel(file.name);
    } finally {
      setIsUploadingFile(false);
    }
  }, []);


  const stepIndex = step - 1;
  const translateX = `translateX(-${stepIndex * 100}%)`;

  // Scroll the nearest scrollable ancestor to top whenever the step changes
  const sliderRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    let parent = el.parentElement;
    while (parent) {
      const { overflow, overflowY } = window.getComputedStyle(parent);
      if (/(auto|scroll)/.test(overflow + overflowY)) {
        parent.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      parent = parent.parentElement;
    }
  }, [step]);

  return (
    <div ref={sliderRef} className="overflow-hidden">
      <div
        className="flex transition-transform duration-300 ease-in-out"
        style={{ transform: translateX, willChange: "transform" }}
      >

        {/* ── Step 1: Background Selection ──────────────────────────────────── */}
        <div className="w-full shrink-0 p-4 md:p-5 box-border">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-1">
                Step 1 of 3
              </p>
              <h3 className="text-base font-bold uppercase tracking-wide">Choose Background</h3>
            </div>
            <StepDots current={1} total={3} />
          </div>

          {/* Image mode tabs — hidden when entered via Studio Hub path */}
          {!initialPathMode && (
            <div className="flex border-b border-border mb-4 overflow-x-auto">
              {(["identity", "stock", "ai", "upload"] as VideoImageMode[]).map((mode) => {
                const labels: Record<VideoImageMode, string> = { identity: "You", stock: "Stock Photo", ai: "AI Generated", upload: "Upload" };
                // "identity" + "stock" are free. "upload" needs only video
                // access (this whole tab is already video_generation-gated).
                // "ai" additionally needs meme_ai_background — a capability
                // AiBgPicker itself gates, independent of video access.
                const needsPremium =
                  mode === "ai" ? !canAiBackground : mode === "upload" ? !canVideo : false;
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      userPickedVideoModeRef.current = true;
                      setImageMode(mode);
                      if (mode === "identity" && profileImageUrl) {
                        setSelectedBgUrl(profileImageUrl);
                        setSelectedBgLabel("Your photo");
                      }
                    }}
                    className={`relative flex-1 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-all ${
                      imageMode === mode
                        ? "border-[#ff6b35] text-[#ff6b35]"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                    }`}
                  >
                    {labels[mode]}
                    {needsPremium && (
                      <Lock className="ml-1.5 w-3 h-3 text-amber-400 shrink-0 inline-block align-middle" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Thumbnail size slider */}
          <div className="flex items-center gap-2 py-1 mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>
            <input
              type="range"
              min={0}
              max={100}
              value={thumbSize}
              onChange={e => setThumbSize(Number(e.target.value))}
              className="flex-1 h-1 accent-primary cursor-pointer"
              aria-label="Thumbnail size"
            />
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </div>

          {/* Stock photo mode */}
          {imageMode === "stock" && (
            <div className="space-y-3">
              {prefetchedPhotos.length > 0 ? (
                <>
                  <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Select a background image
                  </p>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                    {prefetchedPhotos.slice(0, bgStockLimit).map((photo, i) => (
                      <ImageCard
                        key={photo.id}
                        src={photo.url}
                        alt={`Option ${i + 1}`}
                        aspectRatio="aspect-video"
                        selected={selectedStockIndex === i}
                        onSelect={() => {
                          setSelectedStockIndex(i);
                          const photoUrl = photo.url;
                          setSelectedBgUrl(photoUrl);
                          setSelectedBgLabel("Stock photo");
                        }}
                        compact
                        actions={["openFull"]}
                        footer={<AdminMediaInfoForUrl url={photo.url} mimeType={getMimeTypeFromUrl(photo.url)} />}
                      />
                    ))}
                  </div>
                  {hasMorePhotos && (
                    <button
                      onClick={() => void loadMorePhotos()}
                      disabled={isLoadingMorePhotos}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground border border-dashed border-border hover:border-border/80 rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoadingMorePhotos
                        ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading…</>
                        : <><RefreshCw className="w-3 h-3" /> Load more photos</>
                      }
                    </button>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Loading photos…
                </div>
              )}
            </div>
          )}

          {/* AI Generated mode */}
          {imageMode === "ai" && (
            <AiBgPicker
              factId={factId}
              initialImages={aiMemeImages ?? null}
              aiGender={aiGender}
              isGendered={factIsGendered}
              canGenerate={canAiBackground}
              isAdmin={isAdmin}
              onSelect={(sel: AiBgSelection | null) => {
                setSelectedBgUrl(sel?.url ?? null);
                setSelectedBgLabel(sel ? (sel.label ?? "AI background") : null);
              }}
              showStylePicker
              onGoToUpload={() => setImageMode("upload")}
              profileImageUrl={profileImageUrl}
            />
          )}

          {/* Identity (your-photo) mode — free for every signed-in user */}
          {imageMode === "identity" && (
            profileImageUrl ? (
              <div className="bg-secondary border border-border p-3 flex items-center gap-3">
                <img
                  src={profileImageUrl}
                  alt="Your profile photo"
                  className="w-20 h-20 object-cover border border-border shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-0.5">
                    Your photo
                  </p>
                  <p className="text-xs text-foreground">
                    Free for registered users — your face will star in the video.
                  </p>
                </div>
              </div>
            ) : (
              <div className="border-2 border-dashed border-border bg-muted/20 p-5 text-center space-y-2">
                <p className="text-sm font-bold text-foreground uppercase tracking-wider">
                  No profile photo yet
                </p>
                <p className="text-xs text-muted-foreground">
                  Add a profile photo from the meme builder&apos;s &ldquo;You&rdquo; tab and we&apos;ll reuse it everywhere.
                </p>
              </div>
            )
          )}

          {/* Upload mode */}
          {imageMode === "upload" && (
            <div className="space-y-3">
              {!canVideo ? (
                <AccessGate reason="legendary" size="sm" description="Upload your own photos with a Legendary membership." />
              ) : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFileUpload(file);
                      e.target.value = "";
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploadingFile}
                    className="w-full border-2 border-dashed border-border hover:border-[#ff6b35] transition-colors p-6 text-center flex flex-col items-center gap-2"
                  >
                    {isUploadingFile
                      ? <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      : <Upload className="w-6 h-6 text-muted-foreground" />
                    }
                    <p className="text-xs text-muted-foreground">
                      {isUploadingFile ? "Processing…" : "Drop an image or click to browse"}
                    </p>
                  </button>

                  {/* Gallery from existing uploads */}
                  {isLoadingGallery ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : uploadGallery.length > 0 && (
                    <>
                      <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        My Uploads
                      </p>
                      <div className="grid gap-1.5 max-h-48 overflow-y-auto" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                        {uploadGallery.slice(0, bgUploadLimit).map((entry) => {
                          const url = `/api/storage${entry.objectPath}`;
                          const isSelected = selectedBgUrl === url;
                          return (
                            <ImageCard
                              key={entry.objectPath}
                              src={url}
                              alt={`${entry.width}×${entry.height}px`}
                              aspectRatio="aspect-video"
                              isAuthProtected
                              selected={isSelected}
                              onSelect={() => {
                                setSelectedBgUrl(isSelected ? null : url);
                                setSelectedBgLabel(isSelected ? null : "Uploaded image");
                              }}
                              compact
                              actions={["openFull"]}
                              footer={<AdminMediaInfo fileName={getFileNameFromUrl(entry.objectPath)} fileSizeBytes={entry.fileSizeBytes} mimeType={getMimeTypeFromUrl(entry.objectPath)} width={entry.width} height={entry.height} />}
                            />
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Continue button */}
          <div className="mt-5">
            <Button
              onClick={() => setStep(2)}
              disabled={!selectedBgUrl}
              variant="primary"
              size="lg"
              className="w-full gap-2"
              style={{ background: "#ff6b35", borderColor: "#ff6b35" }}
            >
              <Sparkles className="w-4 h-4" />
              {selectedBgUrl ? "Continue with this Background" : "Select a background to continue"}
            </Button>
          </div>
        </div>

        {/* ── Step 2: Style Picker ─────────────────────────────────────────── */}
        <div className="w-full shrink-0 p-4 md:p-5 box-border">
          <div className="flex items-center justify-between mb-5">
            <div>
              <button
                onClick={() => setStep(1)}
                className="flex items-center gap-1 text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors mb-1"
              >
                <ChevronLeft className="w-3 h-3" />
                Change Background
              </button>
              <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-1">
                Step 2 of 3
              </p>
              <h3 className="text-base font-bold uppercase tracking-wide">Pick a Style</h3>
            </div>
            <StepDots current={2} total={3} />
          </div>

          {/* Background preview */}
          {selectedBgUrl && (
            <div className="bg-secondary border border-border p-3 mb-5 flex items-center gap-3">
              <img
                src={selectedBgUrl}
                alt="Selected background"
                className="w-16 h-10 object-cover border border-border shrink-0"
              />
              <div className="min-w-0">
                <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-0.5">
                  Background
                </p>
                <p className="text-xs text-foreground truncate">{selectedBgLabel ?? "Selected image"}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-6">
            {videoStyles.map((style) => (
              <StyleCard
                key={style.id}
                style={style}
                selected={selectedStyleId === style.id}
                onClick={() => setSelectedStyleId(style.id)}
              />
            ))}
          </div>

          <Button
            onClick={goToStep3}
            variant="primary"
            size="lg"
            className="w-full gap-2"
            style={{ background: "#ff6b35", borderColor: "#ff6b35" }}
          >
            <Sparkles className="w-4 h-4" />
            Continue with {selectedStyle?.label ?? "…"}
          </Button>
        </div>

        {/* ── Step 3: Generate & Preview ───────────────────────────────────── */}
        <div className="w-full shrink-0 p-4 md:p-5 box-border">
          <div className="flex items-center justify-between mb-5">
            <div>
              <button
                onClick={() => {
                  setVideoState({ status: "idle" });
                  setStep(2);
                }}
                className="flex items-center gap-1 text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors mb-1"
              >
                <ChevronLeft className="w-3 h-3" />
                Change Style
              </button>
              <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-1">
                Step 3 of 3
              </p>
              <h3 className="text-base font-bold uppercase tracking-wide">Generate & Preview</h3>
            </div>
            <StepDots current={3} total={3} />
          </div>

          {/* Background + style summary */}
          <div className="grid grid-cols-2 gap-2.5 mb-5">
            <div className="bg-secondary border border-border p-3">
              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1.5">
                Background
              </p>
              {selectedBgUrl && (
                <img
                  src={selectedBgUrl}
                  alt="Background"
                  className="w-full h-auto max-h-48 object-contain border border-border"
                />
              )}
              {selectedBgLabel && (
                <p className="text-[10px] text-muted-foreground mt-1 truncate">{selectedBgLabel}</p>
              )}
            </div>
            <div className="bg-secondary border border-border p-3">
              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
                Style
              </p>
              <div
                className="w-full h-8 mb-1.5 rounded-sm"
                style={{
                  background: selectedStyle
                    ? `linear-gradient(135deg, ${selectedStyle.gradientFrom} 0%, ${selectedStyle.gradientTo} 100%)`
                    : undefined,
                }}
              />
              <p className="text-xs font-bold text-foreground">{selectedStyle?.label ?? ""}</p>
            </div>
          </div>


          {videoState.status === "generating" && (
            <div className="space-y-1.5 mb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[#ff6b35]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-xs font-display font-bold uppercase tracking-wider">Generating…</span>
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">{videoElapsed}s</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-[#ff6b35]/15 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    videoProgress >= 100 ? "bg-green-500" : "bg-[#ff6b35]"
                  }`}
                  style={{ width: `${videoProgress}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground/60">
                Typically ~17 seconds for Grok — up to 2 minutes for other models.
              </p>
            </div>
          )}

          {videoState.status === "error" && (
            <div className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 text-sm text-destructive mb-4">
              <X className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>{videoState.message}</p>
                <button
                  onClick={() => setVideoState({ status: "idle" })}
                  className="mt-1 text-xs underline hover:no-underline"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {videoState.status === "done" && (
            <div className="space-y-4 mb-4">
              <p className="text-xs font-display uppercase tracking-widest text-[#ff6b35]">Your Video</p>
              <div className="border-2 border-border overflow-hidden">
                <video
                  src={videoState.url}
                  controls
                  autoPlay
                  className="w-full"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setVideoDims({ width: v.videoWidth, height: v.videoHeight });
                  }}
                />
                <AdminMediaInfo
                  fileName={getFileNameFromUrl(videoState.url)}
                  mimeType={getMimeTypeFromUrl(videoState.url)}
                  width={videoDims?.width}
                  height={videoDims?.height}
                />
              </div>

              {/* Polished share screen — per-platform share buttons + copy
                  link. Video tab has no permalink slug yet so the merch
                  teaser and "View permalink" CTA hide automatically. */}
              <PostCreateShareScreen
                mediaUrl={videoState.url}
                mediaKind="video"
                factText={factText}
                onDownload={handleDownload}
                onMakeAnother={() => {
                  setVideoState({ status: "idle" });
                  setStep(2);
                }}
              />

              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() => { setVideoState({ status: "idle" }); setStep(2); }}
                  variant="secondary"
                  size="sm"
                  className="gap-1.5 text-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Try Another Style
                </Button>
                <Button
                  onClick={() => { setVideoState({ status: "idle" }); setStep(1); setSelectedBgUrl(null); setSelectedBgLabel(null); }}
                  variant="secondary"
                  size="sm"
                  className="gap-1.5 text-xs"
                >
                  <Video className="w-3.5 h-3.5" /> New Background
                </Button>
              </div>
            </div>
          )}

          {videoState.status !== "done" && (
            <>
              {/* Public / Private toggle (premium) */}
              {canSetPrivate && (
                <div className="flex items-center gap-3 mb-4 p-3 bg-secondary border border-border rounded-sm">
                  <button
                    onClick={() => setIsVideoPrivate(false)}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-display font-bold uppercase tracking-wider rounded-sm transition-colors",
                      !isVideoPrivate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Globe className="w-3.5 h-3.5" /> Public
                  </button>
                  <button
                    onClick={() => setIsVideoPrivate(true)}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-display font-bold uppercase tracking-wider rounded-sm transition-colors",
                      isVideoPrivate ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Lock className="w-3.5 h-3.5" /> Private
                  </button>
                </div>
              )}
              <Button
                onClick={() => void handleGenerateVideo()}
                disabled={videoState.status === "generating" || !selectedBgUrl}
                variant="primary"
                size="lg"
                className="gap-2 w-full mb-2"
                style={{ background: "#ff6b35", borderColor: "#ff6b35" }}
              >
                {videoState.status === "generating" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating Video…
                  </>
                ) : (
                  <>
                    <Video className="w-4 h-4" />
                    Generate Video
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                AI video generation typically takes 30–120 seconds. Up to 3 videos per 24 hours.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default VideoTab;
