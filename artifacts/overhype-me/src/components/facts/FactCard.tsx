import { useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ThumbsUp, ThumbsDown, MessageSquare, Video, Loader2, X } from "lucide-react";
import { FactSummary } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

function renderFactToBase64(text: string): string {
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

export function FactCard({ fact, rank, showRank = false }: { fact: FactSummary, rank?: number, showRank?: boolean }) {
  const { rateFact } = useAppMutations();
  const { isAuthenticated, login } = useAuth();
  const { name, pronouns } = usePersonName();
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) { login(); return; }
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId: fact.id, data: { rating: newRating } });
  };

  const handleGenerateVideo = async () => {
    if (videoState.status === "generating") return;
    setVideoState({ status: "generating" });

    const renderedText = renderFact(fact.text, name, pronouns);
    const imageBase64 = renderFactToBase64(renderedText);

    if (!imageBase64) {
      setVideoState({ status: "error", message: "Could not render meme image for video generation." });
      return;
    }

    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageBase64, factId: fact.id }),
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      className="relative group block bg-card border-2 border-border hover:border-primary/50 rounded-sm shadow-xl transition-all duration-300 overflow-hidden"
    >
      {/* Decorative corner accents */}
      <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 -translate-y-1 z-10" />
      <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary opacity-0 group-hover:opacity-100 transition-opacity -translate-x-1 translate-y-1 z-10" />

      {showRank && rank && (
        <div className="absolute -top-4 -left-4 w-10 h-10 bg-primary text-primary-foreground font-display font-bold text-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.4)] rotate-[-5deg] z-10">
          #{rank}
        </div>
      )}

      <div className="relative z-10 p-6 sm:p-8">
        <Link href={`/facts/${fact.id}`} className="block mb-6">
          <h3 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground leading-tight">
            "{renderFact(fact.text, name, pronouns)}"
          </h3>
        </Link>

        <div className="flex flex-wrap gap-2 mb-8">
          {fact.hashtags.map(tag => (
            <Link key={tag} href={`/search?q=%23${tag}`} className="text-xs font-bold font-display tracking-wider text-muted-foreground hover:text-primary transition-colors bg-secondary px-3 py-1 rounded-sm uppercase">
              #{tag}
            </Link>
          ))}
        </div>

        {/* Video player */}
        {videoState.status === "done" && (
          <div className="mb-4 rounded-sm overflow-hidden border border-border">
            <video
              src={videoState.url}
              controls
              autoPlay
              className="w-full"
            />
            <div className="flex justify-end px-2 py-1 bg-muted/30">
              <button
                onClick={() => setVideoState({ status: "idle" })}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                <X className="w-3 h-3" /> Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Generating state message */}
        {videoState.status === "generating" && (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-primary/10 border border-primary/30 rounded-sm text-sm text-primary">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Generating your video… this takes 30–120 seconds</span>
          </div>
        )}

        {/* Error state */}
        {videoState.status === "error" && (
          <div className="mb-4 flex items-start gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-sm text-sm text-destructive">
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

        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleRate("up")}
              disabled={rateFact.isPending}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-sm transition-colors font-bold text-sm",
                fact.userRating === "up" ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <ThumbsUp className={cn("w-5 h-5", fact.userRating === "up" && "fill-current")} />
              {fact.upvotes}
            </button>

            <button
              onClick={() => handleRate("down")}
              disabled={rateFact.isPending}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-sm transition-colors font-bold text-sm",
                fact.userRating === "down" ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <ThumbsDown className={cn("w-5 h-5", fact.userRating === "down" && "fill-current")} />
              {fact.downvotes}
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={handleGenerateVideo}
              disabled={videoState.status === "generating"}
              title="Generate an animated video from this fact"
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-sm transition-colors font-bold text-sm",
                videoState.status === "generating"
                  ? "text-primary bg-primary/10 cursor-wait"
                  : videoState.status === "done"
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              {videoState.status === "generating" ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Video className="w-5 h-5" />
              )}
              <span className="hidden sm:inline">
                {videoState.status === "done" ? "REGENERATE" : "VIDEO"}
              </span>
            </button>

            <Link href={`/facts/${fact.id}`} className="flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors text-sm font-bold px-3 py-2 rounded-sm hover:bg-secondary">
              <MessageSquare className="w-5 h-5" />
              {fact.commentCount} <span className="hidden sm:inline">COMMENTS</span>
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
