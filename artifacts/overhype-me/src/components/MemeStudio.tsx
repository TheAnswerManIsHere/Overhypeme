import { useState, useCallback, useEffect, useRef } from "react";
import {
  X,
  ChevronLeft,
  ImageIcon,
  Video,
  Loader2,
  Download,
  Share2,
  RefreshCw,
  CheckCircle,
  Sparkles,
  Upload,
  Lock,
} from "lucide-react";
import { MemeBuilder } from "@/components/MemeBuilder";
import { Button } from "@/components/ui/Button";
import { ImageCard } from "@/components/ui/ImageCard";
import { VIDEO_STYLES, type VideoStyleDef } from "@/config/videoStyles";
import type { AiMemeImages } from "@/components/MemeBuilder";
import { AiBgPicker, type AiBgSelection } from "@/components/AiBgPicker";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";

// ─── Types ──────────────────────────────────────────────────────────────────

type StudioTab = "image" | "video";
type VideoStep = 1 | 2 | 3;

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

export type { AiMemeImages };

interface PexelsPhotoEntry {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
  src?: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male: (number | PexelsPhotoEntry)[];
  female: (number | PexelsPhotoEntry)[];
  neutral: (number | PexelsPhotoEntry)[];
}

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

// ─── Available Kling video models ────────────────────────────────────────────

const FAL_VIDEO_MODELS_ADMIN: { value: string; label: string }[] = [
  // Kling
  { value: "fal-ai/kling-video/v3/pro/image-to-video",           label: "Kling v3 Pro — 1080p, audio" },
  { value: "fal-ai/kling-video/v2.6/pro/image-to-video",         label: "Kling v2.6 Pro" },
  { value: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",   label: "Kling v2.5 Turbo Pro" },
  { value: "fal-ai/kling-video/v2.1/master/image-to-video",      label: "Kling v2.1 Master — 1080p" },
  { value: "fal-ai/kling-video/v2.1/pro/image-to-video",         label: "Kling v2.1 Pro — 1080p" },
  { value: "fal-ai/kling-video/v2.1/standard/image-to-video",    label: "Kling v2.1 Standard — default" },
  { value: "fal-ai/kling-video/v1.6/pro/image-to-video",         label: "Kling v1.6 Pro — 1080p" },
  { value: "fal-ai/kling-video/v1.6/standard/image-to-video",    label: "Kling v1.6 Standard — 720p" },
  // Seedance
  { value: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",  label: "Seedance 1.5 Pro (ByteDance)" },
  // Google Veo
  { value: "fal-ai/veo3.1/image-to-video",                       label: "Veo 3.1 (Google) — top quality" },
  { value: "fal-ai/veo3.1/fast/image-to-video",                  label: "Veo 3.1 Fast (Google)" },
  { value: "fal-ai/veo3.1/lite/image-to-video",                  label: "Veo 3.1 Lite (Google)" },
  { value: "fal-ai/veo3/image-to-video",                         label: "Veo 3 (Google)" },
  { value: "fal-ai/veo2/image-to-video",                         label: "Veo 2 (Google) — 720p" },
  // OpenAI
  { value: "fal-ai/sora-2/image-to-video",                       label: "Sora 2 (OpenAI)" },
  // Runway
  { value: "fal-ai/runway/gen4-turbo/image-to-video",            label: "Runway Gen-4 Turbo — 1080p" },
  { value: "fal-ai/runway-gen3/turbo/image-to-video",            label: "Runway Gen-3 Alpha Turbo — 720p" },
  // Luma
  { value: "fal-ai/luma-dream-machine/ray-2/image-to-video",     label: "Luma Ray 2 (Dream Machine) — 720p" },
  { value: "fal-ai/luma-dream-machine/ray-flash-2/image-to-video", label: "Luma Ray Flash 2 — fast" },
  // MiniMax / Hailuo
  { value: "fal-ai/minimax/hailuo-2.3-pro/image-to-video",       label: "Hailuo 2.3 Pro (MiniMax) — 1080p" },
  { value: "fal-ai/minimax/hailuo-2.3/image-to-video",           label: "Hailuo 2.3 Standard (MiniMax) — 768p" },
  { value: "fal-ai/minimax/hailuo-02/standard/image-to-video",   label: "Hailuo 02 Standard (MiniMax)" },
  { value: "fal-ai/minimax/video-01-live/image-to-video",        label: "MiniMax Video-01 Live" },
  { value: "fal-ai/minimax/video-01/image-to-video",             label: "MiniMax Video-01" },
  // PixVerse
  { value: "fal-ai/pixverse/v6/image-to-video",                  label: "PixVerse v6 — 1080p" },
  { value: "fal-ai/pixverse/v5.5/image-to-video",                label: "PixVerse v5.5" },
  { value: "fal-ai/pixverse/v5/image-to-video",                  label: "PixVerse v5" },
  { value: "fal-ai/pixverse/v4.5/image-to-video",                label: "PixVerse v4.5 — 720p" },
  // WAN
  { value: "fal-ai/wan/v2.7/image-to-video",                     label: "WAN 2.7 — latest" },
  { value: "fal-ai/wan/v2.2-a14b/image-to-video",                label: "WAN 2.2 (A14B)" },
  { value: "fal-ai/wan/v2.2/image-to-video",                     label: "WAN 2.2" },
  { value: "fal-ai/wan-pro/image-to-video",                      label: "WAN 2.1 Pro — 1080p" },
  { value: "fal-ai/wan-i2v",                                     label: "WAN 2.1" },
  // LTX
  { value: "fal-ai/ltx-2-19b/image-to-video",                    label: "LTX-2 19B" },
  { value: "fal-ai/ltx-video-13b-distilled/image-to-video",      label: "LTX-Video 13B Distilled" },
  // Open source
  { value: "fal-ai/hunyuan-video/image-to-video",                label: "HunyuanVideo (Tencent)" },
  { value: "fal-ai/cogvideox-5b/image-to-video",                 label: "CogVideoX-5B — open source" },
  { value: "fal-ai/stable-video",                                label: "Stable Video Diffusion — lightweight" },
];

// ─── Per-model parameter spec ─────────────────────────────────────────────────

interface ModelParamSpec {
  duration?: string[];
  aspectRatio?: string[];
  cfgScale?: { min: number; max: number; step: number; default: number };
  negativePrompt?: boolean;
  seed?: boolean;
  resolution?: string[];
  loop?: boolean;
}

function getModelParamSpec(model: string): ModelParamSpec {
  if (model.includes("/kling-video/")) {
    return { duration: ["5", "10"], aspectRatio: ["16:9", "9:16", "1:1"], cfgScale: { min: 0, max: 1, step: 0.05, default: 0.5 } };
  }
  if (model.includes("/bytedance/seedance/")) {
    return { duration: ["5", "10"], aspectRatio: ["16:9", "9:16", "1:1"], resolution: ["720p", "1080p"] };
  }
  if (model.includes("/veo3.1/")) {
    return { duration: ["5", "6", "7", "8"], aspectRatio: ["16:9", "9:16"], negativePrompt: true };
  }
  if (model.includes("/veo3/") || model.includes("/veo2/")) {
    return { aspectRatio: ["16:9", "9:16"] };
  }
  if (model.includes("/sora-2/")) {
    return { duration: ["5", "10", "15", "20"], aspectRatio: ["16:9", "1:1", "9:16"], resolution: ["480p", "720p", "1080p"] };
  }
  if (model.includes("/runway/gen4-turbo/") || model.includes("/runway-gen3/")) {
    return { duration: ["5", "10"], seed: true };
  }
  if (model.includes("/luma-dream-machine/")) {
    return { duration: ["5", "8", "9", "10"], aspectRatio: ["16:9", "9:16", "1:1", "4:3", "3:4"], loop: true };
  }
  if (model.includes("/minimax/hailuo-2.3") || model.includes("/minimax/hailuo-02")) {
    return { duration: ["5", "10"], aspectRatio: ["16:9", "9:16", "1:1"] };
  }
  if (model.includes("/minimax/video-01")) {
    return { aspectRatio: ["16:9", "9:16", "1:1"] };
  }
  if (model.includes("/pixverse/")) {
    return { duration: ["4", "8"], aspectRatio: ["16:9", "9:16", "1:1", "4:3"], negativePrompt: true, seed: true };
  }
  if (model.startsWith("fal-ai/wan") || model.includes("/wan/")) {
    return { duration: ["5"], aspectRatio: ["16:9", "9:16"], negativePrompt: true };
  }
  if (model.includes("/ltx-")) {
    return { duration: ["3", "5", "7"], aspectRatio: ["16:9"], negativePrompt: true };
  }
  if (model.includes("/hunyuan-video/")) {
    return { aspectRatio: ["16:9", "9:16"] };
  }
  return { duration: ["5", "10"], aspectRatio: ["16:9", "9:16", "1:1"] };
}

// ─── Image source types for VideoTab ─────────────────────────────────────────

type VideoImageMode = "stock" | "ai" | "upload";

interface StockPhotoEntry {
  id: number;
  photoUrl: string;
  photographerName: string;
  photographerUrl: string;
}

// ─── Video Tab wizard ────────────────────────────────────────────────────────

interface VideoTabProps {
  factId: number;
  factText: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  /** Pre-loaded meme image data URL passed from MemeBuilder's "Turn Into Video" button */
  initialImageDataUrl?: string;
}

function VideoTab({ factId, factText, pexelsImages, aiMemeImages, initialImageDataUrl }: VideoTabProps) {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const isPremium = role === "premium" || role === "admin";
  const { pronouns } = usePersonName();

  // Start at step 1 (background selection) unless we already have a pre-loaded image
  const [step, setStep] = useState<VideoStep>(initialImageDataUrl ? 2 : 1);
  const [selectedStyleId, setSelectedStyleId] = useState("cinematic");
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  // ── Background image state ────────────────────────────────────────────────
  const [imageMode, setImageMode] = useState<VideoImageMode>("stock");

  // Selected background image URL (URL or base64 data URL)
  const [selectedBgUrl, setSelectedBgUrl] = useState<string | null>(initialImageDataUrl ?? null);
  // Human-readable label for the selected background
  const [selectedBgLabel, setSelectedBgLabel] = useState<string | null>(initialImageDataUrl ? "From meme builder" : null);

  // Stock photos
  const [prefetchedPhotos, setPrefetchedPhotos] = useState<PexelsPhotoEntry[]>([]);
  const [selectedStockIndex, setSelectedStockIndex] = useState<number | null>(null);

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
  const [uploadGallery, setUploadGallery] = useState<Array<{ objectPath: string; width: number; height: number }>>([]);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);

  // ── Admin controls ─────────────────────────────────────────────────────────
  const [selectedModel, setSelectedModel] = useState(FAL_VIDEO_MODELS_ADMIN[0]!.value);
  const [motionPrompt, setMotionPrompt] = useState("");
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  // Admin per-model params (reset when model changes)
  const [adminDuration, setAdminDuration] = useState("5");
  const [adminAspectRatio, setAdminAspectRatio] = useState("16:9");
  const [adminCfgScale, setAdminCfgScale] = useState(0.5);
  const [adminNegativePrompt, setAdminNegativePrompt] = useState("");
  const [adminSeed, setAdminSeed] = useState("");
  const [adminResolution, setAdminResolution] = useState("");
  const [adminLoop, setAdminLoop] = useState(false);

  const selectedStyle = VIDEO_STYLES.find((s) => s.id === selectedStyleId) ?? VIDEO_STYLES[0]!;

  // ── Load prefetched Pexels photos on mount ────────────────────────────────
  useEffect(() => {
    if (!pexelsImages) return;
    const raw = pexelsImages.neutral ?? pexelsImages.male ?? pexelsImages.female ?? [];
    const mapped = raw.map((entry) =>
      typeof entry === "number"
        ? { id: entry, url: `https://images.pexels.com/photos/${entry}/pexels-photo-${entry}.jpeg?auto=compress&cs=tinysrgb&w=940&h=500&fit=crop&dpr=1` }
        : entry
    );
    setPrefetchedPhotos(mapped);
    if (mapped.length > 0 && selectedStockIndex === null) {
      setSelectedStockIndex(0);
      const first = mapped[0]!;
      const photoUrl = first.src?.large ?? first.url;
      setSelectedBgUrl(photoUrl);
      setSelectedBgLabel("Stock photo");
    }
  }, [pexelsImages]);

  // ── Load upload gallery for premium users ─────────────────────────────────
  useEffect(() => {
    if (!isPremium || imageMode !== "upload") return;
    setIsLoadingGallery(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { uploads?: Array<{ objectPath: string; width: number; height: number }> }) => {
        setUploadGallery(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => setIsLoadingGallery(false));
  }, [isPremium, imageMode]);

  // ── Auto-generate motion prompt when admin reaches step 3 ─────────────────
  const generatePromptForImage = useCallback(async (imageUrl: string) => {
    if (!isAdmin) return;
    setIsGeneratingPrompt(true);
    try {
      const body: { imageBase64?: string; imageUrl?: string } = {};
      if (imageUrl.startsWith("data:")) {
        body.imageBase64 = imageUrl;
      } else {
        const absoluteUrl = imageUrl.startsWith("/") ? `${window.location.origin}${imageUrl}` : imageUrl;
        body.imageUrl = absoluteUrl;
      }
      const res = await fetch("/api/videos/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { prompt?: string };
        if (data.prompt) setMotionPrompt(data.prompt);
      }
    } catch {
      // leave prompt empty — admin can type manually
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [isAdmin]);

  // Reset per-model params when the model changes
  useEffect(() => {
    if (!isAdmin) return;
    const spec = getModelParamSpec(selectedModel);
    setAdminDuration(spec.duration?.[0] ?? "5");
    setAdminAspectRatio(spec.aspectRatio?.[0] ?? "16:9");
    setAdminCfgScale(spec.cfgScale?.default ?? 0.5);
    setAdminNegativePrompt("");
    setAdminSeed("");
    setAdminResolution(spec.resolution?.[0] ?? "");
    setAdminLoop(false);
  }, [selectedModel, isAdmin]);

  const goToStep3 = useCallback(() => {
    setStep(3);
    if (isAdmin && selectedBgUrl && !motionPrompt) {
      void generatePromptForImage(selectedBgUrl);
    }
  }, [isAdmin, selectedBgUrl, motionPrompt, generatePromptForImage]);

  // ── Generate video ─────────────────────────────────────────────────────────
  const handleGenerateVideo = async () => {
    if (videoState.status === "generating" || !selectedBgUrl) return;

    setVideoState({ status: "generating" });

    try {
      const body: Record<string, unknown> = {
        factId,
        styleId: selectedStyleId,
      };

      if (selectedBgUrl.startsWith("data:")) {
        body.imageBase64 = selectedBgUrl;
      } else {
        body.imageUrl = selectedBgUrl.startsWith("/") ? `${window.location.origin}${selectedBgUrl}` : selectedBgUrl;
      }

      if (isAdmin) {
        if (motionPrompt.trim()) body.motionPrompt = motionPrompt.trim();
        body.videoModel = selectedModel;
        const spec = getModelParamSpec(selectedModel);
        body.adminDuration = adminDuration;
        body.adminAspectRatio = adminAspectRatio;
        if (spec.cfgScale) body.adminCfgScale = adminCfgScale;
        if (spec.negativePrompt && adminNegativePrompt.trim()) body.adminNegativePrompt = adminNegativePrompt.trim();
        if (spec.seed && adminSeed.trim()) {
          const seedNum = parseInt(adminSeed.trim(), 10);
          if (!isNaN(seedNum)) body.adminSeed = seedNum;
        }
        if (spec.resolution && adminResolution) body.adminResolution = adminResolution;
        if (spec.loop) body.adminLoop = adminLoop;
      }

      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await res.json() as { videoUrl?: string; error?: string };

      if (res.status === 429) {
        setVideoState({
          status: "error",
          message: data.error ?? "Rate limit exceeded. You can generate up to 3 videos per 24 hours.",
        });
        return;
      }

      if (!res.ok || !data.videoUrl) {
        setVideoState({
          status: "error",
          message: data.error ?? "Video generation failed. Please try again.",
        });
        return;
      }

      setVideoState({ status: "done", url: data.videoUrl });
    } catch {
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

  const handleShare = async () => {
    if (videoState.status !== "done") return;
    if (navigator.share) {
      try {
        await navigator.share({ url: videoState.url, title: "Check out this overhyped fact!" });
      } catch {
        // user cancelled
      }
    } else {
      void navigator.clipboard.writeText(videoState.url);
    }
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

  return (
    <div className="overflow-hidden">
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

          {/* Image mode tabs */}
          <div className="flex border-b border-border mb-4">
            {(["stock", "ai", "upload"] as VideoImageMode[]).map((mode) => {
              const labels: Record<VideoImageMode, string> = { stock: "Stock Photo", ai: "AI Generated", upload: "Upload" };
              const needsPremium = mode !== "stock" && !isPremium;
              return (
                <button
                  key={mode}
                  onClick={() => setImageMode(mode)}
                  className={`relative flex-1 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-all ${
                    imageMode === mode
                      ? "border-[#ff6b35] text-[#ff6b35]"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {labels[mode]}
                  {needsPremium && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1 py-0.5 rounded-sm">
                      <Lock className="w-2 h-2" />PRO
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Stock photo mode */}
          {imageMode === "stock" && (
            <div className="space-y-3">
              {prefetchedPhotos.length > 0 ? (
                <>
                  <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Select a background image
                  </p>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                    {prefetchedPhotos.map((photo, i) => (
                      <ImageCard
                        key={photo.id}
                        src={photo.src?.large ?? photo.src?.small ?? photo.url}
                        alt={`Option ${i + 1}`}
                        aspectRatio="aspect-video"
                        selected={selectedStockIndex === i}
                        onSelect={() => {
                          setSelectedStockIndex(i);
                          const photoUrl = photo.src?.large ?? photo.url;
                          setSelectedBgUrl(photoUrl);
                          setSelectedBgLabel("Stock photo");
                        }}
                        compact
                        actions={["openFull"]}
                      />
                    ))}
                  </div>
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
              isPremium={isPremium}
              isAdmin={isAdmin}
              onSelect={(sel: AiBgSelection | null) => {
                setSelectedBgUrl(sel?.url ?? null);
                setSelectedBgLabel(sel ? (sel.label ?? "AI background") : null);
              }}
              showStylePicker
            />
          )}

          {/* Upload mode */}
          {imageMode === "upload" && (
            <div className="space-y-3">
              {!isPremium ? (
                <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
                  <Lock className="w-6 h-6 text-amber-400 mx-auto" />
                  <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">Legendary Feature</p>
                  <p className="text-xs text-muted-foreground">Upload your own photos with a Legendary membership.</p>
                </div>
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
                      <div className="grid gap-1.5 max-h-48 overflow-y-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}>
                        {uploadGallery.map((entry) => {
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
            {VIDEO_STYLES.map((style) => (
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
            Continue with {selectedStyle.label}
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
                  background: `linear-gradient(135deg, ${selectedStyle.gradientFrom} 0%, ${selectedStyle.gradientTo} 100%)`,
                }}
              />
              <p className="text-xs font-bold text-foreground">{selectedStyle.label}</p>
            </div>
          </div>

          {/* Admin controls */}
          {isAdmin && (() => {
            const spec = getModelParamSpec(selectedModel);
            const effectivePrompt = motionPrompt.trim() || `(${selectedStyle.label} style motion prompt)`;
            const falPreviewInput: Record<string, unknown> = {
              image_url: selectedBgUrl ? "(background image url)" : "(no image selected)",
              prompt: effectivePrompt,
              duration: adminDuration,
              aspect_ratio: adminAspectRatio,
            };
            if (spec.cfgScale) falPreviewInput.cfg_scale = adminCfgScale;
            if (spec.negativePrompt && adminNegativePrompt.trim()) falPreviewInput.negative_prompt = adminNegativePrompt.trim();
            if (spec.seed && adminSeed.trim()) { const n = parseInt(adminSeed.trim(), 10); if (!isNaN(n)) falPreviewInput.seed = n; }
            if (spec.resolution && adminResolution) falPreviewInput.resolution = adminResolution;
            if (spec.loop) falPreviewInput.loop = adminLoop;

            return (
              <div className="border border-amber-500/30 bg-amber-500/5 rounded-sm p-3 mb-4 space-y-3">
                <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Admin Controls</p>

                {/* Model selector */}
                <div className="space-y-1">
                  <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Video Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors"
                  >
                    {FAL_VIDEO_MODELS_ADMIN.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* Per-model params */}
                <div className="grid grid-cols-2 gap-2">
                  {spec.duration && (
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Duration</label>
                      <select
                        value={adminDuration}
                        onChange={(e) => setAdminDuration(e.target.value)}
                        className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors"
                      >
                        {spec.duration.map((d) => (
                          <option key={d} value={d}>{d}s</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {spec.aspectRatio && (
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Aspect Ratio</label>
                      <select
                        value={adminAspectRatio}
                        onChange={(e) => setAdminAspectRatio(e.target.value)}
                        className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors"
                      >
                        {spec.aspectRatio.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {spec.resolution && (
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Resolution</label>
                      <select
                        value={adminResolution}
                        onChange={(e) => setAdminResolution(e.target.value)}
                        className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors"
                      >
                        {spec.resolution.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {spec.cfgScale && (
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        CFG Scale: {adminCfgScale.toFixed(2)}
                      </label>
                      <input
                        type="range"
                        min={spec.cfgScale.min}
                        max={spec.cfgScale.max}
                        step={spec.cfgScale.step}
                        value={adminCfgScale}
                        onChange={(e) => setAdminCfgScale(parseFloat(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}
                  {spec.seed && (
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Seed</label>
                      <input
                        type="number"
                        min={0}
                        value={adminSeed}
                        onChange={(e) => setAdminSeed(e.target.value)}
                        placeholder="random"
                        className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-muted-foreground/40"
                      />
                    </div>
                  )}
                  {spec.loop && (
                    <div className="flex items-center gap-2 pt-4">
                      <input
                        id="adminLoop"
                        type="checkbox"
                        checked={adminLoop}
                        onChange={(e) => setAdminLoop(e.target.checked)}
                        className="accent-amber-500"
                      />
                      <label htmlFor="adminLoop" className="text-[10px] font-display uppercase tracking-widest text-muted-foreground cursor-pointer">
                        Loop
                      </label>
                    </div>
                  )}
                </div>

                {spec.negativePrompt && (
                  <div className="space-y-0.5">
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Negative Prompt</label>
                    <input
                      type="text"
                      value={adminNegativePrompt}
                      onChange={(e) => setAdminNegativePrompt(e.target.value)}
                      placeholder="Things to avoid…"
                      className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-muted-foreground/40"
                    />
                  </div>
                )}

                {/* Motion prompt */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Motion Prompt</label>
                    {isGeneratingPrompt && (
                      <div className="flex items-center gap-1 text-[10px] text-amber-500">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Analyzing image…
                      </div>
                    )}
                    {!isGeneratingPrompt && selectedBgUrl && (
                      <button
                        onClick={() => { setMotionPrompt(""); void generatePromptForImage(selectedBgUrl); }}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                      >
                        <RefreshCw className="w-2.5 h-2.5" />
                        Regenerate
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    value={motionPrompt}
                    onChange={(e) => setMotionPrompt(e.target.value)}
                    placeholder={isGeneratingPrompt ? "Analyzing image to generate prompt…" : "Enter a motion prompt or wait for auto-generation…"}
                    className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 resize-y focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-muted-foreground/40"
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    If empty, the <strong>{selectedStyle.label}</strong> style prompt is used automatically.
                  </p>
                </div>

                {/* fal.ai call preview */}
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-amber-500/80 uppercase tracking-wider">fal.ai Call Preview</p>
                  <pre className="text-[9px] leading-relaxed bg-black/50 border border-amber-500/20 p-2 rounded-sm overflow-auto font-mono text-amber-200/70 max-h-48 whitespace-pre-wrap break-all">
{`fal.subscribe("${selectedModel}", {
  input: ${JSON.stringify(falPreviewInput, null, 4)}
})`}
                  </pre>
                </div>
              </div>
            );
          })()}

          {videoState.status === "generating" && (
            <div className="flex items-center gap-3 px-4 py-3 bg-[#ff6b35]/10 border border-[#ff6b35]/30 text-sm text-[#ff6b35] mb-4">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Generating your video… this takes 30–120 seconds</span>
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
            <div className="space-y-3 mb-4">
              <p className="text-xs font-display uppercase tracking-widest text-[#ff6b35]">Your Video</p>
              <div className="border-2 border-border overflow-hidden">
                <video src={videoState.url} controls autoPlay className="w-full" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={handleDownload} variant="secondary" className="gap-2">
                  <Download className="w-4 h-4" /> Download
                </Button>
                <Button onClick={() => void handleShare()} variant="secondary" className="gap-2">
                  <Share2 className="w-4 h-4" /> Share
                </Button>
              </div>
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
                  onClick={() => { setVideoState({ status: "idle" }); setStep(1); setSelectedBgUrl(null); setSelectedBgLabel(null); setMotionPrompt(""); }}
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

// ─── Tab button ──────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 flex items-center justify-center gap-2 py-3 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-all ${
        active
          ? "border-[#ff6b35] text-[#ff6b35]"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {icon}
      {label}
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
  const [videoImageDataUrl, setVideoImageDataUrl] = useState<string | undefined>(initialVideoImageDataUrl);

  const handleMakeVideo = (dataUrl: string) => {
    setVideoImageDataUrl(dataUrl);
    setActiveTab("video");
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
        />
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === "image" ? (
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
            onMakeVideo={handleMakeVideo}
          />
        ) : (
          <div className="p-4 md:p-5 max-w-2xl mx-auto">
            <VideoTab
              factId={factId}
              factText={factText}
              pexelsImages={pexelsImages}
              aiMemeImages={aiMemeImages}
              initialImageDataUrl={videoImageDataUrl}
            />
          </div>
        )}
      </div>
    </div>
  );
}
