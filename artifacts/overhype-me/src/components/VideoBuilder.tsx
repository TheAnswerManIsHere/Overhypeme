import { useEffect, useState } from "react";
import { X, Video, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

interface VideoBuilderProps {
  factId: number;
  factText: string;
  onClose: () => void;
}

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

export function VideoBuilder({ factId, factText, onClose }: VideoBuilderProps) {
  const [imageBase64, setImageBase64] = useState<string>("");
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  useEffect(() => {
    const b64 = renderFactImage(factText);
    setImageBase64(b64);
  }, [factText]);

  const handleGenerateVideo = async () => {
    if (!imageBase64 || videoState.status === "generating") return;
    setVideoState({ status: "generating" });
    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageBase64, factId }),
      });
      const body = await res.json() as { videoUrl?: string; error?: string };
      if (!res.ok || !body.videoUrl) {
        setVideoState({ status: "error", message: body.error ?? "Video generation failed. Please try again." });
        return;
      }
      setVideoState({ status: "done", url: body.videoUrl });
    } catch {
      setVideoState({ status: "error", message: "Network error. Please check your connection and try again." });
    }
  };

  const handleDownloadVideo = () => {
    if (videoState.status !== "done") return;
    const a = document.createElement("a");
    a.href = videoState.url;
    a.download = `overhype-video-${factId}.mp4`;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <Video className="w-5 h-5 text-primary" />
          <h2 className="font-display font-bold uppercase tracking-wider text-lg">AI Video Generator</h2>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-sm hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

          {/* Preview */}
          <div className="space-y-2">
            <p className="text-xs font-display uppercase tracking-widest text-muted-foreground">Preview Image</p>
            {imageBase64 ? (
              <img
                src={imageBase64}
                alt="Video preview"
                className="w-full rounded-sm border-2 border-border"
              />
            ) : (
              <div className="w-full aspect-video bg-muted rounded-sm animate-pulse" />
            )}
            <p className="text-xs text-muted-foreground">
              This image will be animated into a short AI-generated video.
            </p>
          </div>

          {/* Status: generating */}
          {videoState.status === "generating" && (
            <div className="flex items-center gap-3 px-4 py-3 bg-primary/10 border border-primary/30 rounded-sm text-sm text-primary">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Generating your video… this takes 30–120 seconds</span>
            </div>
          )}

          {/* Status: error */}
          {videoState.status === "error" && (
            <div className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-sm text-sm text-destructive">
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

          {/* Status: done — show video + download */}
          {videoState.status === "done" && (
            <div className="space-y-3">
              <p className="text-xs font-display uppercase tracking-widest text-primary">Your Video</p>
              <div className="rounded-sm overflow-hidden border-2 border-border">
                <video src={videoState.url} controls autoPlay className="w-full" />
              </div>
              <Button onClick={handleDownloadVideo} variant="secondary" className="gap-2 w-full">
                <Download className="w-4 h-4" /> Download Video
              </Button>
            </div>
          )}

          {/* Generate / Regenerate */}
          <Button
            onClick={handleGenerateVideo}
            disabled={videoState.status === "generating" || !imageBase64}
            variant="primary"
            size="lg"
            className="gap-2 w-full"
          >
            {videoState.status === "generating" ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Generating Video…</>
            ) : (
              <><Video className="w-4 h-4" />{videoState.status === "done" ? "Regenerate Video" : "Generate Video"}</>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            AI video generation typically takes 30–120 seconds.
          </p>
        </div>
      </div>
    </div>
  );
}
