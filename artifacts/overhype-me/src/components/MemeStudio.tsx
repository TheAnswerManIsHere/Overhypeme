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
  Globe,
} from "lucide-react";
import { MemeBuilder } from "@/components/MemeBuilder";
import { Button } from "@/components/ui/Button";
import { ImageCard } from "@/components/ui/ImageCard";
import type { VideoStyleDef } from "@/config/videoStyles";
import { useVideoStyles } from "@/hooks/use-video-styles";
import type { AiMemeImages } from "@/components/MemeBuilder";
import { AiBgPicker, type AiBgSelection } from "@/components/AiBgPicker";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { cn } from "@/lib/utils";
import { AccessGate } from "@/components/AccessGate";

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

// ─── Available Kling video models ────────────────────────────────────────────

const FAL_VIDEO_MODELS_ADMIN: { value: string; label: string }[] = [
  // xAI
  { value: "xai/grok-imagine-video/image-to-video",              label: "Grok Imagine Video (xAI)" },
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
  { value: "bytedance/seedance-2.0/image-to-video",              label: "Seedance 2.0 (ByteDance) — native audio" },
  { value: "bytedance/seedance-2.0/fast/image-to-video",         label: "Seedance 2.0 Fast (ByteDance)" },
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
  durationRange?: { min: number; max: number; step: number; default: number };
  aspectRatio?: string[];
  cfgScale?: { min: number; max: number; step: number; default: number };
  guidanceScale?: { min: number; max: number; step: number; default: number };
  negativePrompt?: boolean;
  seed?: boolean;
  resolution?: string[];
  loop?: boolean;
  generateAudio?: boolean;
  autoFix?: boolean;
  safetyTolerance?: string[];
  promptOptimizer?: boolean;
  style?: string[];
  enableSafetyChecker?: boolean;
  cameraFixed?: boolean;
  motionBucketId?: { min: number; max: number; step: number; default: number };
  condAug?: { min: number; max: number; step: number; default: number };
  fps?: { min: number; max: number; step: number; default: number };
  numFrames?: { min: number; max: number; step: number; default: number };
  numInferenceSteps?: { min: number; max: number; step: number; default: number };
  generateAudioSwitch?: boolean;
  generateMultiClipSwitch?: boolean;
  thinkingType?: string[];
}

function getModelParamSpec(model: string): ModelParamSpec {
  // ── Kling ───────────────────────────────────────────────────────────────────
  if (model.includes("/kling-video/")) {
    return {
      duration: ["5", "10"],
      cfgScale: { min: 0, max: 1, step: 0.05, default: 0.5 },
      negativePrompt: true,
      seed: true,
    };
  }

  // ── Seedance 2.0 (Pro + Fast) ───────────────────────────────────────────────
  // API: duration string enum auto/4–15, aspect auto/21:9/16:9/4:3/1:1/3:4/9:16,
  //      resolution 480p/720p, generate_audio true by default, seed supported.
  if (model.includes("seedance-2.0")) {
    return {
      duration: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      aspectRatio: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      resolution: ["480p", "720p"],
      seed: true,
      generateAudio: true,
    };
  }

  // ── Seedance v1.5 Pro ───────────────────────────────────────────────────────
  if (model.includes("/bytedance/seedance/")) {
    return {
      duration: ["4", "5", "6", "7", "8", "9", "10", "11", "12"],
      aspectRatio: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "auto"],
      resolution: ["480p", "720p", "1080p"],
      seed: true,
      generateAudio: true,
      enableSafetyChecker: true,
      cameraFixed: true,
    };
  }

  // ── Veo 3.1 Lite / Fast: 4s, 6s, 8s; no 4k ─────────────────────────────────
  if (model.includes("/veo3.1/lite/") || model.includes("/veo3.1/fast/")) {
    return {
      duration: ["4", "6", "8"],
      aspectRatio: ["auto", "16:9", "9:16"],
      negativePrompt: true,
      seed: true,
      resolution: ["720p", "1080p"],
      generateAudio: true,
      autoFix: true,
      safetyTolerance: ["1", "2", "3", "4", "5", "6"],
    };
  }

  // ── Veo 3.1 full: 4s, 6s, 8s; supports 4k ───────────────────────────────────
  if (model.includes("/veo3.1/")) {
    return {
      duration: ["4", "6", "8"],
      aspectRatio: ["auto", "16:9", "9:16"],
      negativePrompt: true,
      seed: true,
      resolution: ["720p", "1080p", "4k"],
      generateAudio: true,
      autoFix: true,
      safetyTolerance: ["1", "2", "3", "4", "5", "6"],
    };
  }

  // ── Veo 3 (I2V) ────────────────────────────────────────────────────────────
  if (model.includes("/veo3/")) {
    return {
      duration: ["4", "6", "8"],
      aspectRatio: ["auto", "16:9", "9:16"],
      negativePrompt: true,
      seed: true,
      resolution: ["720p", "1080p"],
      generateAudio: true,
      autoFix: true,
      safetyTolerance: ["1", "2", "3", "4", "5", "6"],
    };
  }

  // ── Veo 2: duration only (5–8), no aspect ratio ─────────────────────────────
  if (model.includes("/veo2/")) {
    return {
      duration: ["5", "6", "7", "8"],
    };
  }

  // ── Sora 2: integer durations 4/8/12/16/20, aspect, resolution ──────────────
  if (model.includes("/sora-2/")) {
    return {
      duration: ["4", "8", "12", "16", "20"],
      aspectRatio: ["auto", "16:9", "9:16"],
      resolution: ["auto", "720p"],
    };
  }

  // ── Runway Gen-4 Turbo / Gen-3 Alpha Turbo ─────────────────────────────────
  if (model.includes("/runway/gen4-turbo/") || model.includes("/runway-gen3/")) {
    return {
      duration: ["5", "10"],
      seed: true,
    };
  }

  // ── Luma Ray 2 / Flash 2 ────────────────────────────────────────────────────
  if (model.includes("/luma-dream-machine/")) {
    return {
      duration: ["5s", "9s"],
      aspectRatio: ["16:9", "9:16", "4:3", "3:4", "21:9", "9:21"],
      resolution: ["540p", "720p", "1080p"],
      loop: true,
    };
  }

  // ── Hailuo 2.3 / Hailuo 02 ─────────────────────────────────────────────────
  if (model.includes("/minimax/hailuo-2.3") || model.includes("/minimax/hailuo-02")) {
    return {
      duration: ["6", "10"],
      resolution: ["512P", "768P"],
      promptOptimizer: true,
    };
  }

  // ── MiniMax Video-01 / Video-01-Live ────────────────────────────────────────
  if (model.includes("/minimax/video-01")) {
    return {
      promptOptimizer: true,
    };
  }

  // ── PixVerse v6: duration is integer slider 1–15 ────────────────────────────
  if (model.includes("/pixverse/v6/")) {
    return {
      durationRange: { min: 1, max: 15, step: 1, default: 8 },
      resolution: ["360p", "540p", "720p", "1080p"],
      negativePrompt: true,
      seed: true,
      style: ["anime", "3d_animation", "clay", "comic", "cyberpunk"],
      generateAudioSwitch: true,
      generateMultiClipSwitch: true,
      thinkingType: ["auto", "enabled", "disabled"],
    };
  }

  // ── PixVerse v4.5 / v5 / v5.5 ──────────────────────────────────────────────
  if (model.includes("/pixverse/")) {
    return {
      duration: ["5", "8"],
      resolution: ["360p", "540p", "720p", "1080p"],
      negativePrompt: true,
      seed: true,
      style: ["anime", "3d_animation", "clay", "comic", "cyberpunk"],
    };
  }

  // ── WAN Pro / WAN i2v: minimal params ──────────────────────────────────────
  if (model.includes("wan-pro") || model === "fal-ai/wan-i2v") {
    return {
      negativePrompt: true,
      seed: true,
      enableSafetyChecker: true,
    };
  }

  // ── WAN 2.7 / 2.2: duration 2–15, resolution, negPrompt, seed ──────────────
  if (model.startsWith("fal-ai/wan") || model.includes("/wan/")) {
    return {
      duration: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      resolution: ["720p", "1080p"],
      negativePrompt: true,
      seed: true,
      enableSafetyChecker: true,
    };
  }

  // ── LTX-2 19B: numFrames, generateAudio, fps, guidanceScale ────────────────
  if (model.includes("ltx-2-19b")) {
    return {
      numFrames: { min: 9, max: 481, step: 8, default: 121 },
      generateAudio: true,
      fps: { min: 1, max: 60, step: 1, default: 30 },
      guidanceScale: { min: 1, max: 20, step: 0.5, default: 3.0 },
    };
  }

  // ── LTX-Video 13B Distilled ─────────────────────────────────────────────────
  if (model.includes("/ltx-")) {
    return {
      numFrames: { min: 9, max: 1441, step: 8, default: 121 },
      aspectRatio: ["9:16", "1:1", "16:9", "auto"],
      resolution: ["480p", "720p"],
      negativePrompt: true,
      seed: true,
    };
  }

  // ── Grok Imagine Video (xAI) ────────────────────────────────────────────────
  if (model.includes("grok-imagine-video")) {
    return {
      durationRange: { min: 1, max: 15, step: 1, default: 6 },
      aspectRatio: ["auto", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
      resolution: ["480p", "720p"],
    };
  }

  // ── HunyuanVideo ────────────────────────────────────────────────────────────
  if (model.includes("/hunyuan-video/")) {
    return {
      aspectRatio: ["16:9", "9:16"],
    };
  }

  // ── CogVideoX-5B ────────────────────────────────────────────────────────────
  if (model.includes("cogvideox")) {
    return {
      negativePrompt: true,
      seed: true,
      guidanceScale: { min: 1, max: 20, step: 0.5, default: 6.0 },
      numInferenceSteps: { min: 1, max: 50, step: 1, default: 50 },
    };
  }

  // ── Stable Video Diffusion ──────────────────────────────────────────────────
  if (model.includes("stable-video")) {
    return {
      seed: true,
      motionBucketId: { min: 1, max: 255, step: 1, default: 127 },
      condAug: { min: 0, max: 10, step: 0.01, default: 0.02 },
      fps: { min: 10, max: 100, step: 1, default: 25 },
    };
  }

  // ── Default ─────────────────────────────────────────────────────────────────
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
  defaultPrivate?: boolean;
}

function VideoTab({ factId, factText, pexelsImages, aiMemeImages, initialImageDataUrl, defaultPrivate }: VideoTabProps) {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const isLegendary = role === "legendary" || role === "admin";
  const { pronouns } = usePersonName();
  const { styles: videoStyles } = useVideoStyles();

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

  // ── Video generation progress ───────────────────────────────────────────────
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoElapsed, setVideoElapsed] = useState(0);
  const videoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Admin controls ─────────────────────────────────────────────────────────
  const [selectedModel, setSelectedModel] = useState(FAL_VIDEO_MODELS_ADMIN[0]!.value);

  // Initialise selectedModel + global defaults from admin config so MemeStudio
  // reflects whatever the admin config panel has set as the global defaults.
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/config", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((rows: Array<{ key: string; value: string }> | null) => {
        if (!rows) return;
        const get = (k: string) => rows.find(r => r.key === k)?.value ?? "";
        const cfgModel    = get("video_model");
        const cfgDuration = get("video_duration");
        const cfgAR       = get("video_aspect_ratio");
        const cfgRes      = get("video_resolution");
        if (cfgModel && FAL_VIDEO_MODELS_ADMIN.some(m => m.value === cfgModel)) {
          setSelectedModel(cfgModel);
        }
        if (cfgDuration) setAdminConfigDuration(cfgDuration);
        if (cfgAR)       setAdminConfigAspectRatio(cfgAR);
        if (cfgRes)      setAdminConfigResolution(cfgRes);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const [motionPrompt, setMotionPrompt] = useState("");
  const [isVideoPrivate, setIsVideoPrivate] = useState(defaultPrivate ?? false);

  // Admin config panel defaults (seeded from /api/admin/config on load)
  const [adminConfigDuration, setAdminConfigDuration] = useState("5");
  const [adminConfigAspectRatio, setAdminConfigAspectRatio] = useState("auto");
  const [adminConfigResolution, setAdminConfigResolution] = useState("720p");

  // Admin per-model params (reset when model changes)
  const [adminDuration, setAdminDuration] = useState("5");
  const [adminDurationInt, setAdminDurationInt] = useState(8); // for durationRange models (PixVerse v6)
  const [adminAspectRatio, setAdminAspectRatio] = useState("16:9");
  const [adminCfgScale, setAdminCfgScale] = useState(0.5);
  const [adminNegativePrompt, setAdminNegativePrompt] = useState("");
  const [adminSeed, setAdminSeed] = useState("");
  const [adminResolution, setAdminResolution] = useState("");
  const [adminLoop, setAdminLoop] = useState(false);
  // Extended admin params
  const [adminGenerateAudio, setAdminGenerateAudio] = useState(true);
  const [adminAutoFix, setAdminAutoFix] = useState(false);
  const [adminSafetyTolerance, setAdminSafetyTolerance] = useState("4");
  const [adminPromptOptimizer, setAdminPromptOptimizer] = useState(true);
  const [adminStyle, setAdminStyle] = useState("");
  const [adminEnableSafetyChecker, setAdminEnableSafetyChecker] = useState(true);
  const [adminCameraFixed, setAdminCameraFixed] = useState(false);
  const [adminMotionBucketId, setAdminMotionBucketId] = useState(127);
  const [adminCondAug, setAdminCondAug] = useState(0.02);
  const [adminFps, setAdminFps] = useState(25);
  const [adminNumFrames, setAdminNumFrames] = useState(121);
  const [adminGuidanceScale, setAdminGuidanceScale] = useState(6.0);
  const [adminNumInferenceSteps, setAdminNumInferenceSteps] = useState(50);
  const [adminGenerateAudioSwitch, setAdminGenerateAudioSwitch] = useState(false);
  const [adminGenerateMultiClipSwitch, setAdminGenerateMultiClipSwitch] = useState(false);
  const [adminThinkingType, setAdminThinkingType] = useState("auto");

  const selectedStyle = videoStyles.find((s) => s.id === selectedStyleId) ?? videoStyles[0];

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
    if (!isLegendary || imageMode !== "upload") return;
    setIsLoadingGallery(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { uploads?: Array<{ objectPath: string; width: number; height: number }> }) => {
        setUploadGallery(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => setIsLoadingGallery(false));
  }, [isLegendary, imageMode]);

  // ── Auto-populate motion prompt when entering step 3 ──────────────────────
  useEffect(() => {
    if (step === 3) {
      const style = videoStyles.find(s => s.id === selectedStyleId);
      if (style) setMotionPrompt(style.motionPrompt);
    }
  }, [step, selectedStyleId]);

  // ── Clean up video progress timer on unmount ───────────────────────────────
  useEffect(() => {
    return () => {
      if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    };
  }, []);

  // Reset per-model params when the model changes.
  // Duration / aspect ratio / resolution are initialised from the global admin
  // config values (fetched on mount) if those values are valid for the selected
  // model. This way the override screen reflects the admin config panel defaults
  // rather than always falling back to the spec's first option.
  useEffect(() => {
    if (!isAdmin) return;
    const spec = getModelParamSpec(selectedModel);

    // Duration: prefer the admin config value when valid for this model
    if (spec.duration) {
      const cfgDur = adminConfigDuration;
      setAdminDuration(spec.duration.includes(cfgDur) ? cfgDur : (spec.duration[0] ?? "5"));
    } else if (spec.durationRange) {
      const num = parseInt(adminConfigDuration, 10);
      const clamped = !isNaN(num)
        ? Math.max(spec.durationRange.min, Math.min(spec.durationRange.max, num))
        : spec.durationRange.default;
      setAdminDurationInt(clamped);
    }

    // Aspect ratio: prefer the admin config value when valid for this model
    if (spec.aspectRatio) {
      const cfgAR = adminConfigAspectRatio;
      setAdminAspectRatio(spec.aspectRatio.includes(cfgAR) ? cfgAR : (spec.aspectRatio[0] ?? "16:9"));
    }

    // Resolution: prefer the admin config value when valid for this model
    if (spec.resolution) {
      const cfgRes = adminConfigResolution;
      setAdminResolution(spec.resolution.includes(cfgRes) ? cfgRes : (spec.resolution[0] ?? ""));
    } else {
      setAdminResolution("");
    }

    setAdminCfgScale(spec.cfgScale?.default ?? 0.5);
    setAdminNegativePrompt("");
    setAdminSeed("");
    setAdminLoop(false);
    setAdminGenerateAudio(true);
    setAdminAutoFix(false);
    setAdminSafetyTolerance(spec.safetyTolerance?.[3] ?? "4");
    setAdminPromptOptimizer(true);
    setAdminStyle("");
    setAdminEnableSafetyChecker(true);
    setAdminCameraFixed(false);
    setAdminMotionBucketId(spec.motionBucketId?.default ?? 127);
    setAdminCondAug(spec.condAug?.default ?? 0.02);
    setAdminFps(spec.fps?.default ?? 25);
    setAdminNumFrames(spec.numFrames?.default ?? 121);
    setAdminGuidanceScale(spec.guidanceScale?.default ?? 6.0);
    setAdminNumInferenceSteps(spec.numInferenceSteps?.default ?? 50);
    setAdminGenerateAudioSwitch(false);
    setAdminGenerateMultiClipSwitch(false);
    setAdminThinkingType(spec.thinkingType?.[0] ?? "auto");
  // adminConfigDuration/AR/Resolution are intentionally NOT deps — they're used
  // as initial values when the model changes, not reactive inputs. Adding them
  // would cause a reset every time the user edits a config field.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, isAdmin]);

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

      if (isAdmin) {
        if (motionPrompt.trim()) body.motionPrompt = motionPrompt.trim();
        body.videoModel = selectedModel;
        const spec = getModelParamSpec(selectedModel);
        // Duration: use integer string for durationRange models, else regular duration
        if (spec.durationRange) {
          body.adminDuration = String(adminDurationInt);
        } else if (spec.duration) {
          body.adminDuration = adminDuration;
        }
        if (spec.aspectRatio) body.adminAspectRatio = adminAspectRatio;
        if (spec.cfgScale) body.adminCfgScale = adminCfgScale;
        if (spec.negativePrompt && adminNegativePrompt.trim()) body.adminNegativePrompt = adminNegativePrompt.trim();
        if (spec.seed && adminSeed.trim()) {
          const seedNum = parseInt(adminSeed.trim(), 10);
          if (!isNaN(seedNum)) body.adminSeed = seedNum;
        }
        if (spec.resolution && adminResolution) body.adminResolution = adminResolution;
        if (spec.loop) body.adminLoop = adminLoop;
        // Extended params
        if (spec.generateAudio !== undefined) body.adminGenerateAudio = adminGenerateAudio;
        if (spec.autoFix !== undefined) body.adminAutoFix = adminAutoFix;
        if (spec.safetyTolerance) body.adminSafetyTolerance = adminSafetyTolerance;
        if (spec.promptOptimizer !== undefined) body.adminPromptOptimizer = adminPromptOptimizer;
        if (spec.style && adminStyle) body.adminStyle = adminStyle;
        if (spec.enableSafetyChecker !== undefined) body.adminEnableSafetyChecker = adminEnableSafetyChecker;
        if (spec.cameraFixed !== undefined) body.adminCameraFixed = adminCameraFixed;
        if (spec.motionBucketId) body.adminMotionBucketId = adminMotionBucketId;
        if (spec.condAug) body.adminCondAug = adminCondAug;
        if (spec.fps) body.adminFps = adminFps;
        if (spec.numFrames) body.adminNumFrames = adminNumFrames;
        if (spec.guidanceScale) body.adminGuidanceScale = adminGuidanceScale;
        if (spec.numInferenceSteps) body.adminNumInferenceSteps = adminNumInferenceSteps;
        if (spec.generateAudioSwitch !== undefined) body.adminGenerateAudioSwitch = adminGenerateAudioSwitch;
        if (spec.generateMultiClipSwitch !== undefined) body.adminGenerateMultiClipSwitch = adminGenerateMultiClipSwitch;
        if (spec.thinkingType) body.adminThinkingType = adminThinkingType;
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

          {/* Image mode tabs */}
          <div className="flex border-b border-border mb-4">
            {(["stock", "ai", "upload"] as VideoImageMode[]).map((mode) => {
              const labels: Record<VideoImageMode, string> = { stock: "Stock Photo", ai: "AI Generated", upload: "Upload" };
              const needsPremium = mode !== "stock" && !isLegendary;
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
              isPremium={isLegendary}
              isAdmin={isAdmin}
              onSelect={(sel: AiBgSelection | null) => {
                setSelectedBgUrl(sel?.url ?? null);
                setSelectedBgLabel(sel ? (sel.label ?? "AI background") : null);
              }}
              showStylePicker
              onGoToUpload={() => setImageMode("upload")}
            />
          )}

          {/* Upload mode */}
          {imageMode === "upload" && (
            <div className="space-y-3">
              {!isLegendary ? (
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

          {/* Admin controls */}
          {isAdmin && (() => {
            const spec = getModelParamSpec(selectedModel);
            const selectCls = "w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors";
            const inputCls = "w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-muted-foreground/40";
            const labelCls = "text-[10px] font-display uppercase tracking-widest text-muted-foreground";
            const checkboxRowCls = "flex items-center gap-1.5";

            // Build fal preview input (mirrors backend buildFalInput + voiceover cue logic)
            const basePrompt = motionPrompt.trim() || `(${selectedStyle?.label ?? "cinematic"} style motion prompt)`;
            const effectivePrompt = factText.trim()
              ? `${basePrompt}\nVoiceover should say, "${factText.trim()}"`
              : basePrompt;
            const falPreviewInput: Record<string, unknown> = {
              image_url: selectedBgUrl ? "(background image url)" : "(no image selected)",
              prompt: effectivePrompt,
            };
            if (spec.duration) falPreviewInput.duration = adminDuration;
            if (spec.durationRange) falPreviewInput.duration = adminDurationInt;
            if (spec.aspectRatio) falPreviewInput.aspect_ratio = adminAspectRatio;
            if (spec.cfgScale) falPreviewInput.cfg_scale = adminCfgScale;
            if (spec.negativePrompt && adminNegativePrompt.trim()) falPreviewInput.negative_prompt = adminNegativePrompt.trim();
            if (spec.seed && adminSeed.trim()) { const n = parseInt(adminSeed.trim(), 10); if (!isNaN(n)) falPreviewInput.seed = n; }
            if (spec.resolution && adminResolution) falPreviewInput.resolution = adminResolution;
            if (spec.loop) falPreviewInput.loop = adminLoop;
            if (spec.generateAudio !== undefined) falPreviewInput.generate_audio = adminGenerateAudio;
            if (spec.autoFix !== undefined) falPreviewInput.auto_fix = adminAutoFix;
            if (spec.safetyTolerance) falPreviewInput.safety_tolerance = adminSafetyTolerance;
            if (spec.promptOptimizer !== undefined) falPreviewInput.prompt_optimizer = adminPromptOptimizer;
            if (spec.style && adminStyle) falPreviewInput.style = adminStyle;
            if (spec.enableSafetyChecker !== undefined) falPreviewInput.enable_safety_checker = adminEnableSafetyChecker;
            if (spec.cameraFixed !== undefined) falPreviewInput.camera_fixed = adminCameraFixed;
            if (spec.motionBucketId) falPreviewInput.motion_bucket_id = adminMotionBucketId;
            if (spec.condAug) falPreviewInput.cond_aug = adminCondAug;
            if (spec.fps) falPreviewInput.fps = adminFps;
            if (spec.numFrames) falPreviewInput.num_frames = adminNumFrames;
            if (spec.guidanceScale) falPreviewInput.guidance_scale = adminGuidanceScale;
            if (spec.numInferenceSteps) falPreviewInput.num_inference_steps = adminNumInferenceSteps;
            if (spec.generateAudioSwitch !== undefined) falPreviewInput.generate_audio_switch = adminGenerateAudioSwitch;
            if (spec.generateMultiClipSwitch !== undefined) falPreviewInput.generate_multi_clip_switch = adminGenerateMultiClipSwitch;
            if (spec.thinkingType) falPreviewInput.thinking_type = adminThinkingType;

            return (
              <div className="border border-amber-500/30 bg-amber-500/5 rounded-sm p-3 mb-4 space-y-3">
                <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Admin Controls</p>

                {/* Model selector */}
                <div className="space-y-1">
                  <label className={labelCls}>Video Model</label>
                  <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className={selectCls}>
                    {FAL_VIDEO_MODELS_ADMIN.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* Per-model params — 2-column grid */}
                <div className="grid grid-cols-2 gap-2">
                  {/* Duration dropdown */}
                  {spec.duration && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Duration</label>
                      <select value={adminDuration} onChange={(e) => setAdminDuration(e.target.value)} className={selectCls}>
                        {spec.duration.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Duration range slider (PixVerse v6) */}
                  {spec.durationRange && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Duration: {adminDurationInt}s</label>
                      <input
                        type="range"
                        min={spec.durationRange.min}
                        max={spec.durationRange.max}
                        step={spec.durationRange.step}
                        value={adminDurationInt}
                        onChange={(e) => setAdminDurationInt(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Aspect Ratio */}
                  {spec.aspectRatio && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Aspect Ratio</label>
                      <select value={adminAspectRatio} onChange={(e) => setAdminAspectRatio(e.target.value)} className={selectCls}>
                        {spec.aspectRatio.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Resolution */}
                  {spec.resolution && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Resolution</label>
                      <select value={adminResolution} onChange={(e) => setAdminResolution(e.target.value)} className={selectCls}>
                        {spec.resolution.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Safety Tolerance (Veo) */}
                  {spec.safetyTolerance && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Safety Tolerance</label>
                      <select value={adminSafetyTolerance} onChange={(e) => setAdminSafetyTolerance(e.target.value)} className={selectCls}>
                        {spec.safetyTolerance.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Style (PixVerse) */}
                  {spec.style && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Style</label>
                      <select value={adminStyle} onChange={(e) => setAdminStyle(e.target.value)} className={selectCls}>
                        <option value="">— none —</option>
                        {spec.style.map((s) => (
                          <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Thinking Type (PixVerse v6) */}
                  {spec.thinkingType && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Thinking Type</label>
                      <select value={adminThinkingType} onChange={(e) => setAdminThinkingType(e.target.value)} className={selectCls}>
                        {spec.thinkingType.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* CFG Scale (Kling) */}
                  {spec.cfgScale && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>CFG Scale: {adminCfgScale.toFixed(2)}</label>
                      <input
                        type="range" min={spec.cfgScale.min} max={spec.cfgScale.max} step={spec.cfgScale.step}
                        value={adminCfgScale} onChange={(e) => setAdminCfgScale(parseFloat(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Guidance Scale (LTX-2, CogVideoX) */}
                  {spec.guidanceScale && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Guidance Scale: {adminGuidanceScale.toFixed(1)}</label>
                      <input
                        type="range" min={spec.guidanceScale.min} max={spec.guidanceScale.max} step={spec.guidanceScale.step}
                        value={adminGuidanceScale} onChange={(e) => setAdminGuidanceScale(parseFloat(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Num Frames (LTX) */}
                  {spec.numFrames && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Frames: {adminNumFrames}</label>
                      <input
                        type="range" min={spec.numFrames.min} max={spec.numFrames.max} step={spec.numFrames.step}
                        value={adminNumFrames} onChange={(e) => setAdminNumFrames(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Num Inference Steps (CogVideoX) */}
                  {spec.numInferenceSteps && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Steps: {adminNumInferenceSteps}</label>
                      <input
                        type="range" min={spec.numInferenceSteps.min} max={spec.numInferenceSteps.max} step={spec.numInferenceSteps.step}
                        value={adminNumInferenceSteps} onChange={(e) => setAdminNumInferenceSteps(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Motion Bucket ID (Stable Video) */}
                  {spec.motionBucketId && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Motion Bucket: {adminMotionBucketId}</label>
                      <input
                        type="range" min={spec.motionBucketId.min} max={spec.motionBucketId.max} step={spec.motionBucketId.step}
                        value={adminMotionBucketId} onChange={(e) => setAdminMotionBucketId(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Cond Aug (Stable Video) */}
                  {spec.condAug && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Cond Aug: {adminCondAug.toFixed(2)}</label>
                      <input
                        type="range" min={spec.condAug.min} max={spec.condAug.max} step={spec.condAug.step}
                        value={adminCondAug} onChange={(e) => setAdminCondAug(parseFloat(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* FPS (LTX-2, Stable Video) */}
                  {spec.fps && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>FPS: {adminFps}</label>
                      <input
                        type="range" min={spec.fps.min} max={spec.fps.max} step={spec.fps.step}
                        value={adminFps} onChange={(e) => setAdminFps(parseInt(e.target.value, 10))}
                        className="w-full accent-amber-500"
                      />
                    </div>
                  )}

                  {/* Seed */}
                  {spec.seed && (
                    <div className="space-y-0.5">
                      <label className={labelCls}>Seed</label>
                      <input
                        type="number" min={0} value={adminSeed} onChange={(e) => setAdminSeed(e.target.value)}
                        placeholder="random" className={inputCls}
                      />
                    </div>
                  )}
                </div>

                {/* Checkboxes row */}
                {(spec.loop || spec.generateAudio !== undefined || spec.autoFix !== undefined || spec.promptOptimizer !== undefined ||
                  spec.enableSafetyChecker !== undefined || spec.cameraFixed !== undefined ||
                  spec.generateAudioSwitch !== undefined || spec.generateMultiClipSwitch !== undefined) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {spec.loop && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminLoop} onChange={(e) => setAdminLoop(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Loop</span>
                      </label>
                    )}
                    {spec.generateAudio !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminGenerateAudio} onChange={(e) => setAdminGenerateAudio(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Generate Audio</span>
                      </label>
                    )}
                    {spec.autoFix !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminAutoFix} onChange={(e) => setAdminAutoFix(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Auto Fix</span>
                      </label>
                    )}
                    {spec.promptOptimizer !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminPromptOptimizer} onChange={(e) => setAdminPromptOptimizer(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Prompt Optimizer</span>
                      </label>
                    )}
                    {spec.enableSafetyChecker !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminEnableSafetyChecker} onChange={(e) => setAdminEnableSafetyChecker(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Safety Checker</span>
                      </label>
                    )}
                    {spec.cameraFixed !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminCameraFixed} onChange={(e) => setAdminCameraFixed(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Camera Fixed</span>
                      </label>
                    )}
                    {spec.generateAudioSwitch !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminGenerateAudioSwitch} onChange={(e) => setAdminGenerateAudioSwitch(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Gen Audio</span>
                      </label>
                    )}
                    {spec.generateMultiClipSwitch !== undefined && (
                      <label className={checkboxRowCls}>
                        <input type="checkbox" checked={adminGenerateMultiClipSwitch} onChange={(e) => setAdminGenerateMultiClipSwitch(e.target.checked)} className="accent-amber-500" />
                        <span className={labelCls}>Multi-Clip</span>
                      </label>
                    )}
                  </div>
                )}

                {/* Negative Prompt */}
                {spec.negativePrompt && (
                  <div className="space-y-0.5">
                    <label className={labelCls}>Negative Prompt</label>
                    <input
                      type="text" value={adminNegativePrompt} onChange={(e) => setAdminNegativePrompt(e.target.value)}
                      placeholder="Things to avoid…" className={inputCls}
                    />
                  </div>
                )}

                {/* Motion prompt */}
                <div className="space-y-1">
                  <label className={labelCls}>Motion Prompt</label>
                  <textarea
                    rows={3}
                    value={motionPrompt}
                    onChange={(e) => setMotionPrompt(e.target.value)}
                    placeholder="Enter a custom motion prompt…"
                    className="w-full bg-background border border-border text-foreground text-xs rounded-sm px-2 py-1.5 resize-y focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-muted-foreground/40"
                  />
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
              {/* Public / Private toggle */}
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
  const { role, isAuthenticated } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";
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
          />
        ) : !isAuthenticated ? (
          <AccessGate reason="login" description="Log in to access Video Generation." />
        ) : !isLegendary ? (
          <AccessGate reason="legendary" description="Video generation is exclusive to Legendary members. Upgrade to unlock AI-powered video creation." />
        ) : (
          <div className="p-4 md:p-5 max-w-2xl mx-auto">
            <VideoTab
              factId={factId}
              factText={factText}
              pexelsImages={pexelsImages}
              aiMemeImages={aiMemeImages}
              initialImageDataUrl={initialVideoImageDataUrl}
              defaultPrivate={defaultPrivate}
            />
          </div>
        )}
      </div>
    </div>
  );
}
