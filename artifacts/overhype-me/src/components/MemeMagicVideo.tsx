import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Sparkles,
  Loader2,
  Wand2,
  Download,
  Share2,
  RefreshCw,
  Lock,
  AlertTriangle,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AccessGate } from "@/components/AccessGate";
import { useAuth } from "@workspace/replit-auth-web";
import { usePersonName } from "@/hooks/use-person-name";
import { useVideoStyles } from "@/hooks/use-video-styles";
import type { AiMemeImages } from "@/types/meme";

export interface MemeMagicVideoProps {
  factId: number;
  factText: string;
  aiMemeImages?: AiMemeImages | null;
  onBack: () => void;
  onClose: () => void;
}

type Stage =
  | { status: "idle" }
  | { status: "preparing-image" }
  | { status: "generating-video"; videoElapsed: number; videoProgress: number }
  | { status: "done"; videoUrl: string; imageUrl: string }
  | { status: "error"; message: string };

/**
 * MemeMagicVideo — one-tap "Magic Video" path from the Studio Hub.
 *
 * The user picks a video style and presses one button: we auto-source an AI
 * background (or fall back to the user's profile photo when no AI image is
 * available) and chain into the existing /api/videos/generate endpoint. No
 * manual background picking, no text editing — the lowest-friction path to a
 * shareable video for Legendary users.
 */
export function MemeMagicVideo({
  factId,
  factText,
  aiMemeImages,
  onBack,
  onClose,
}: MemeMagicVideoProps) {
  const { isAuthenticated, role, user } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";
  const profileImageUrl = user?.profileImageUrl ?? null;
  const { pronouns } = usePersonName();
  const { styles: videoStyles } = useVideoStyles();

  const [stage, setStage] = useState<Stage>({ status: "idle" });
  const [selectedStyleId, setSelectedStyleId] = useState("cinematic");
  const videoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pick the AI background that matches the user's pronouns. Falls back to
  // neutral, then any other gendered set, then the user's profile photo.
  const sourceImageUrl = useMemo<{ url: string; label: string } | null>(() => {
    const p = (pronouns ?? "").toLowerCase();
    const gender: "male" | "female" | "neutral" =
      p.startsWith("he") ? "male" : p.startsWith("she") ? "female" : "neutral";

    const aiList =
      aiMemeImages?.[gender] ??
      aiMemeImages?.neutral ??
      aiMemeImages?.male ??
      aiMemeImages?.female ??
      [];
    const firstAi = aiList.find((x): x is string => typeof x === "string" && x.length > 0);
    if (firstAi) {
      const cb = `&cb=${Date.now()}`;
      return {
        url: `/api/memes/ai/${factId}/image?gender=${gender}&imageIndex=0&raw=true${cb}`,
        label: "AI scene",
      };
    }
    if (profileImageUrl) {
      return { url: profileImageUrl, label: "Your photo" };
    }
    return null;
  }, [aiMemeImages, profileImageUrl, pronouns, factId]);

  useEffect(() => {
    return () => {
      if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!sourceImageUrl) {
      setStage({
        status: "error",
        message:
          "No source image available yet. Open the AI Gallery to generate a scene first, or add a profile photo.",
      });
      return;
    }

    setStage({ status: "preparing-image" });

    // Kick straight into /api/videos/generate with the chosen image.
    setStage({ status: "generating-video", videoElapsed: 0, videoProgress: 0 });
    const start = Date.now();
    if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    videoTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      let progress: number;
      if (elapsed <= 17) progress = (elapsed / 17) * 80;
      else {
        const extra = elapsed - 17;
        progress = 80 + 19 * (1 - Math.exp(-extra / 60));
      }
      setStage({
        status: "generating-video",
        videoElapsed: Math.floor(elapsed),
        videoProgress: Math.min(progress, 99),
      });
    }, 250);

    try {
      const body: Record<string, unknown> = {
        factId,
        styleId: selectedStyleId,
        renderedFactText: factText,
        isPrivate: false,
      };
      if (sourceImageUrl.url.startsWith("data:")) {
        body.imageBase64 = sourceImageUrl.url;
      } else if (sourceImageUrl.url.startsWith("/")) {
        body.imageUrl = `${window.location.origin}${sourceImageUrl.url}`;
      } else {
        body.imageUrl = sourceImageUrl.url;
      }

      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { videoUrl?: string; error?: string };

      if (videoTimerRef.current) {
        clearInterval(videoTimerRef.current);
        videoTimerRef.current = null;
      }

      if (res.status === 429) {
        setStage({
          status: "error",
          message:
            data.error ??
            "Rate limit exceeded. You can generate up to 3 videos per 24 hours.",
        });
        return;
      }
      if (!res.ok || !data.videoUrl) {
        setStage({
          status: "error",
          message: data.error ?? "Video generation failed. Please try again.",
        });
        return;
      }
      setStage({
        status: "done",
        videoUrl: data.videoUrl,
        imageUrl: sourceImageUrl.url,
      });
    } catch {
      if (videoTimerRef.current) {
        clearInterval(videoTimerRef.current);
        videoTimerRef.current = null;
      }
      setStage({
        status: "error",
        message:
          "Network error. Please check your connection and try again.",
      });
    }
  }, [factId, factText, selectedStyleId, sourceImageUrl]);

  const handleDownload = () => {
    if (stage.status !== "done") return;
    const a = document.createElement("a");
    a.href = stage.videoUrl;
    a.download = `overhype-magic-${factId}.mp4`;
    a.click();
  };

  const handleShare = async () => {
    if (stage.status !== "done") return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          url: stage.videoUrl,
          title: "Check out this overhyped fact!",
        });
      } catch {
        // user cancelled
      }
    } else if (typeof navigator !== "undefined") {
      void navigator.clipboard.writeText(stage.videoUrl);
    }
  };

  // ── Auth / paywall gating ──────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div className="p-4 md:p-5 max-w-2xl mx-auto">
        <BackBar onBack={onBack} />
        <AccessGate
          reason="login"
          description="Log in to bring your face to life with AI video."
        />
      </div>
    );
  }
  if (!isLegendary) {
    return (
      <div className="p-4 md:p-5 max-w-2xl mx-auto">
        <BackBar onBack={onBack} />
        <AccessGate
          reason="legendary"
          description="Magic Video is a Legendary feature — one tap from your face to a 1080p AI video."
        />
      </div>
    );
  }

  // ── Generation states ──────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-5 max-w-2xl mx-auto space-y-5">
      <BackBar onBack={onBack} />

      <div>
        <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-1">
          Magic Video · One tap
        </p>
        <h3 className="text-base font-bold uppercase tracking-wide flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" />
          Make a video instantly
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          We&apos;ll grab the best AI scene of you for this fact and animate it
          in your chosen style. No fiddling.
        </p>
      </div>

      {/* Style picker */}
      <div>
        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
          Style
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {videoStyles.slice(0, 6).map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedStyleId(s.id)}
              disabled={stage.status === "preparing-image" || stage.status === "generating-video"}
              className={`relative text-left border-2 transition-all overflow-hidden disabled:opacity-50 ${
                selectedStyleId === s.id
                  ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]"
                  : "border-border hover:border-primary/50"
              }`}
            >
              <div
                className="w-full h-14"
                style={{
                  background: `linear-gradient(135deg, ${s.gradientFrom} 0%, ${s.gradientTo} 100%)`,
                }}
              />
              <div className="p-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-foreground truncate">
                  {s.label}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Source preview */}
      {sourceImageUrl ? (
        <div className="bg-secondary border border-border p-3 flex items-center gap-3">
          <img
            src={sourceImageUrl.url}
            alt="Magic Video source"
            className="w-20 h-20 object-cover border border-border shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-0.5">
              Source
            </p>
            <p className="text-xs text-foreground">{sourceImageUrl.label}</p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              Auto-picked. Want a specific look?{" "}
              <button
                onClick={onBack}
                className="underline hover:text-foreground"
              >
                Use the AI Gallery
              </button>
              .
            </p>
          </div>
        </div>
      ) : (
        <div className="border-2 border-dashed border-amber-400/40 bg-amber-400/5 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="text-xs text-foreground space-y-1">
            <p className="font-bold">No source image yet.</p>
            <p className="text-muted-foreground">
              Open the AI Gallery first to generate a scene of you for this
              fact, or add a profile photo from your account.
            </p>
          </div>
        </div>
      )}

      {/* Action / progress */}
      {stage.status === "idle" && (
        <Button
          onClick={() => void handleGenerate()}
          disabled={!sourceImageUrl}
          variant="primary"
          size="lg"
          className="w-full gap-2"
        >
          <Sparkles className="w-4 h-4" />
          {sourceImageUrl ? "Make Magic Video" : "Need a source image"}
        </Button>
      )}

      {(stage.status === "preparing-image" ||
        stage.status === "generating-video") && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="font-bold uppercase tracking-wider text-xs">
              {stage.status === "preparing-image"
                ? "Preparing image…"
                : `Animating · ${stage.videoElapsed}s`}
            </span>
          </div>
          <div className="h-1.5 bg-border rounded overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{
                width:
                  stage.status === "generating-video"
                    ? `${stage.videoProgress}%`
                    : "10%",
              }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Magic Video typically takes 30–90 seconds depending on the model.
          </p>
        </div>
      )}

      {stage.status === "error" && (
        <div className="border-2 border-dashed border-red-400/40 bg-red-400/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-red-400">
            <Lock className="w-4 h-4" />
            <p className="text-xs font-bold uppercase tracking-wider">
              Couldn&apos;t make video
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{stage.message}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setStage({ status: "idle" })}
            className="gap-2"
          >
            <RefreshCw className="w-3 h-3" />
            Try again
          </Button>
        </div>
      )}

      {stage.status === "done" && (
        <div className="space-y-3">
          <video
            src={stage.videoUrl}
            controls
            playsInline
            className="w-full bg-black border border-border"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              className="gap-2"
              onClick={() => void handleShare()}
            >
              <Share2 className="w-4 h-4" /> Share
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="gap-2"
              onClick={handleDownload}
            >
              <Download className="w-4 h-4" /> Download
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => setStage({ status: "idle" })}
            >
              <Wand2 className="w-4 h-4" /> Make another
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onClose}
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-1 text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors mb-3"
    >
      <ChevronLeft className="w-3 h-3" />
      Studio
    </button>
  );
}

export default MemeMagicVideo;
