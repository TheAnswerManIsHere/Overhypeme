import { useState, useCallback } from "react";
import {
  X,
  ChevronLeft,
  ImageIcon,
  Video,
  Loader2,
  Download,
  Share2,
  RefreshCw,
  Search,
  CheckCircle,
  Sparkles,
} from "lucide-react";
import { MemeBuilder } from "@/components/MemeBuilder";
import { Button } from "@/components/ui/Button";
import { VIDEO_STYLES, type VideoStyleDef } from "@/config/videoStyles";
import type { AiMemeImages } from "@/components/MemeBuilder";

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

interface SuggestedFact {
  id: number;
  text: string;
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
}

// ─── Render helper: generate a branded fact image for video ─────────────────

function renderFactImage(text: string): string {
  const W = 800;
  const H = 420;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0a0e2e");
  grad.addColorStop(0.55, "#1a237e");
  grad.addColorStop(1, "#283593");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ff6600";
  ctx.fillRect(0, 0, 12, H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", W - 24, H * 0.72);

  const fontSize = 32;
  const padding = 52;
  const maxW = W - padding * 2;
  ctx.font = `bold ${fontSize}px "Impact", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";

  const words = text.toUpperCase().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxW && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const lineH = fontSize * 1.3;
  const totalH = lines.length * lineH;
  const startY = (H - totalH) / 2 + fontSize;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
  });

  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", W - 18, H - 14);

  return canvas.toDataURL("image/jpeg", 0.85);
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
      {/* Gradient preview */}
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

      {/* Selected check */}
      {selected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#ff6b35] flex items-center justify-center">
          <CheckCircle className="w-3 h-3 text-white" />
        </div>
      )}

      {/* Label + description */}
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

interface VideoTabProps {
  factId: number;
  factText: string;
}

function VideoTab({ factId, factText }: VideoTabProps) {
  const [step, setStep] = useState<VideoStep>(2);
  const [selectedFact, setSelectedFact] = useState<SuggestedFact>({
    id: factId,
    text: factText,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SuggestedFact[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedStyleId, setSelectedStyleId] = useState("cinematic");
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  const selectedStyle = VIDEO_STYLES.find((s) => s.id === selectedStyleId) ?? VIDEO_STYLES[0]!;

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(
        `/api/facts?search=${encodeURIComponent(query)}&limit=5`,
        { credentials: "include" }
      );
      if (!res.ok) return;
      const data = await res.json() as { facts?: { id: number; text: string }[] };
      setSearchResults((data.facts ?? []).map((f) => ({ id: f.id, text: f.text })));
    } catch {
      // silent
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleGenerateVideo = async () => {
    if (videoState.status === "generating") return;

    const imageBase64 = renderFactImage(selectedFact.text);
    if (!imageBase64) return;

    setVideoState({ status: "generating" });

    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imageBase64,
          factId: selectedFact.id,
          styleId: selectedStyleId,
        }),
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
    a.download = `overhype-video-${selectedFact.id}.mp4`;
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

  const stepIndex = step - 1;
  const translateX = `translateX(-${stepIndex * 100}%)`;

  return (
    <div className="overflow-hidden">
      {/* Sliding track — all 3 steps side by side */}
      <div
        className="flex transition-transform duration-300 ease-in-out"
        style={{ transform: translateX, willChange: "transform" }}
      >
        {/* ── Step 1: Fact Selection ──────────────────────────────────────── */}
        <div className="w-full shrink-0 p-4 md:p-5 box-border">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-1">
                Step 1 of 3
              </p>
              <h3 className="text-base font-bold uppercase tracking-wide">Select a Fact</h3>
            </div>
            <StepDots current={1} total={3} />
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => void handleSearch(e.target.value)}
              placeholder="Search facts…"
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-secondary border border-border focus:border-[#ff6b35] focus:outline-none transition-colors"
            />
            {isSearching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />
            )}
          </div>

          <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-2">
            {searchQuery ? "Results" : "Current Fact"}
          </p>

          <div className="space-y-2">
            {(searchResults.length > 0 ? searchResults : [{ id: factId, text: factText }]).map((f) => (
              <button
                key={f.id}
                onClick={() => {
                  setSelectedFact(f);
                  setStep(2);
                }}
                className="w-full text-left border border-border hover:border-[#ff6b35] bg-secondary hover:bg-[#ff6b35]/5 transition-all p-3 group"
              >
                <p className="text-sm font-medium text-foreground group-hover:text-[#ff6b35] line-clamp-3 transition-colors">
                  "{f.text}"
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">Fact #{f.id}</p>
              </button>
            ))}
          </div>
        </div>

        {/* ── Step 2: Style Picker ────────────────────────────────────────── */}
        <div className="w-full shrink-0 p-4 md:p-5 box-border">
          <div className="flex items-center justify-between mb-5">
            <div>
              <button
                onClick={() => setStep(1)}
                className="flex items-center gap-1 text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors mb-1"
              >
                <ChevronLeft className="w-3 h-3" />
                Change Fact
              </button>
              <h3 className="text-base font-bold uppercase tracking-wide">Pick a Style</h3>
            </div>
            <StepDots current={2} total={3} />
          </div>

          <div className="bg-secondary border border-border p-3 mb-5">
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
              Selected Fact
            </p>
            <p className="text-xs text-foreground line-clamp-2">"{selectedFact.text}"</p>
          </div>

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
            onClick={() => setStep(3)}
            variant="primary"
            size="lg"
            className="w-full gap-2"
            style={{ background: "#ff6b35", borderColor: "#ff6b35" }}
          >
            <Sparkles className="w-4 h-4" />
            Continue with {selectedStyle.label}
          </Button>
        </div>

        {/* ── Step 3: Generate & Preview ──────────────────────────────────── */}
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

          <div className="grid grid-cols-2 gap-2.5 mb-5">
            <div className="bg-secondary border border-border p-3">
              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
                Fact
              </p>
              <p className="text-xs text-foreground line-clamp-3">"{selectedFact.text}"</p>
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
                  onClick={() => { setVideoState({ status: "idle" }); setStep(1); }}
                  variant="secondary"
                  size="sm"
                  className="gap-1.5 text-xs"
                >
                  <Video className="w-3.5 h-3.5" /> Generate New
                </Button>
              </div>
            </div>
          )}

          {videoState.status !== "done" && (
            <>
              <Button
                onClick={() => void handleGenerateVideo()}
                disabled={videoState.status === "generating"}
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
}: MemeStudioProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>(defaultTab);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-0 md:p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card border-2 border-border w-full max-w-[800px] h-full md:h-auto md:max-h-[96vh] flex flex-col shadow-2xl shadow-black/60">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-border shrink-0">
          <h2 className="text-lg font-display uppercase tracking-[0.15em] text-foreground flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#ff6b35]" />
            Meme Studio
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
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
            />
          ) : (
            <div className="p-4 md:p-5">
              <VideoTab factId={factId} factText={factText} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
