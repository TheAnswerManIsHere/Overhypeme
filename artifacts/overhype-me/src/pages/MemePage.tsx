import { useState, useEffect } from "react";
import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetFact, getGetFactQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { MerchButtons } from "@/components/MerchButtons";
import { Share2, AlertCircle, ArrowLeft, Download, Ban, Video, Loader2, X } from "lucide-react";

type MemeData = {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  isPublic: boolean;
  factText: string;
  createdAt: string;
  createdByName: string | null;
};

type VideoJob = {
  id: number;
  factId: number;
  imageUrl: string;
  videoUrl: string | null;
  status: "pending" | "completed" | "failed";
  ipAddress: string;
  createdAt: string;
};

type VideoState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

export default function MemePage() {
  const [, params] = useRoute("/meme/:slug");
  const slug = params?.slug ?? "";
  const [videoState, setVideoState] = useState<VideoState>({ status: "loading" });

  const { data: memeResult, isLoading, error } = useQuery<
    { meme: MemeData; deleted: false } | { meme: null; deleted: true }
  >({
    queryKey: ["meme-page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/memes/${slug}`, { credentials: "include" });
      if (res.status === 410) return { meme: null, deleted: true as const };
      if (!res.ok) throw new Error("Meme not found");
      const data = await res.json() as MemeData;
      return { meme: data, deleted: false as const };
    },
    enabled: !!slug,
    retry: false,
  });

  const meme = memeResult?.meme ?? null;
  const isDeleted = memeResult?.deleted === true;
  const factId = meme?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId }
  });

  useEffect(() => {
    if (!factId) return;
    setVideoState({ status: "loading" });
    fetch(`/api/videos/${factId}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: { videos?: VideoJob[] }) => {
        const latest = data.videos?.[0];
        if (latest?.videoUrl) {
          setVideoState({ status: "done", url: latest.videoUrl });
        } else {
          setVideoState({ status: "idle" });
        }
      })
      .catch(() => {
        setVideoState({ status: "idle" });
      });
  }, [factId]);

  const handleDownload = () => {
    if (!meme?.imageUrl) return;
    fetch(meme.imageUrl)
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `overhype-${slug}.jpg`;
        a.click();
      })
      .catch(console.error);
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: "Facts DB Meme",
        text: meme?.factText ?? "Check out this fact!",
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => alert("Link copied!"));
    }
  };

  const handleTwitterShare = () => {
    const text = encodeURIComponent(`"${(meme?.factText ?? "").slice(0, 200)}" — Overhype.me`);
    const url = encodeURIComponent(window.location.href);
    window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
  };

  const handleGenerateVideo = async () => {
    if (!meme?.imageUrl || videoState.status === "generating") return;
    setVideoState({ status: "generating" });
    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imageUrl: meme.imageUrl.startsWith("/") ? `${window.location.origin}${meme.imageUrl}` : meme.imageUrl,
          factId: meme.factId,
        }),
      });
      const body = await res.json() as { videoUrl?: string; error?: string };
      if (res.status === 429) {
        setVideoState({ status: "error", message: body.error ?? "Rate limit exceeded. You have generated too many videos in the past 24 hours." });
        return;
      }
      if (!res.ok || !body.videoUrl) {
        setVideoState({ status: "error", message: body.error ?? "Video generation failed. Please try again." });
        return;
      }
      setVideoState({ status: "done", url: body.videoUrl });
    } catch {
      setVideoState({ status: "error", message: "Network error. Please check your connection and try again." });
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex h-[50vh] items-center justify-center">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Layout>
    );
  }

  if (isDeleted) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-secondary border-2 border-border text-center">
          <Ban className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-3xl font-display uppercase mb-2">Meme Removed</h2>
          <p className="text-muted-foreground mb-6">This meme has been removed by its creator.</p>
          <Link href="/">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Return to Base
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  if (error || !meme) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-destructive/10 border-2 border-destructive text-center">
          <AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4" />
          <h2 className="text-3xl font-display text-destructive uppercase mb-2">Meme Not Found</h2>
          <p className="text-muted-foreground mb-6">This classified image has been redacted.</p>
          <Link href="/">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Return to Base
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-12 md:py-20">
        <div className="flex items-center gap-4 mb-8">
          <Link href={factId ? `/facts/${factId}` : "/"}>
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-primary">
              <ArrowLeft className="w-4 h-4" /> Back to Fact
            </Button>
          </Link>
        </div>

        <div className="bg-card border-l-8 border-primary p-6 md:p-10 shadow-2xl space-y-8">
          <h1 className="text-2xl md:text-3xl font-display uppercase tracking-wide text-primary">
            Fact Meme
          </h1>

          <img
            src={meme.imageUrl}
            alt="Fact meme"
            className="w-full rounded-sm border-2 border-border"
            loading="lazy"
          />

          <div className="border-t-2 border-border pt-6">
            <blockquote className="text-lg text-foreground italic leading-relaxed mb-4">
              "{meme.factText}"
            </blockquote>
            {fact && (
              <Link href={`/facts/${factId}`}>
                <Button variant="secondary" size="sm" className="gap-2">
                  Read Full Fact →
                </Button>
              </Link>
            )}
          </div>

          <div className="flex flex-wrap gap-3 border-t-2 border-border pt-6">
            <Button onClick={handleShare} variant="outline" className="gap-2">
              <Share2 className="w-4 h-4" /> Copy Link
            </Button>
            <Button onClick={handleTwitterShare} variant="outline" className="gap-2 border-sky-500/50 text-sky-400 hover:border-sky-400">
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share on X
            </Button>
            <Button onClick={handleDownload} variant="secondary" className="gap-2">
              <Download className="w-4 h-4" /> Download PNG
            </Button>
          </div>

          {/* ── Generate Video ── */}
          <div className="border-t border-border/50 pt-4 space-y-3">
            {videoState.status === "loading" && (
              <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 border border-border/50 rounded-sm text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>Checking for existing video…</span>
              </div>
            )}

            {videoState.status === "generating" && (
              <div className="flex items-center gap-3 px-4 py-3 bg-primary/10 border border-primary/30 rounded-sm text-sm text-primary">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>Generating your video… this takes 30–120 seconds</span>
              </div>
            )}

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

            {videoState.status === "done" && (
              <div className="rounded-sm overflow-hidden border border-border">
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

            {videoState.status !== "loading" && (
              <Button
                onClick={handleGenerateVideo}
                disabled={videoState.status === "generating"}
                variant="secondary"
                className="gap-2"
              >
                {videoState.status === "generating" ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />Generating Video…</>
                ) : (
                  <><Video className="w-4 h-4" />{videoState.status === "done" ? "Regenerate Video" : "Generate Video"}</>
                )}
              </Button>
            )}
          </div>

          {/* Merch buttons */}
          <div className="border-t border-border/50 pt-4">
            <MerchButtons
              sourceType="meme"
              sourceId={slug}
              text={meme.factText ?? ""}
              imageUrl={meme.imageUrl}
            />
          </div>

          {meme.createdByName && (
            <p className="text-xs text-muted-foreground">
              Generated by <span className="text-primary font-bold">{meme.createdByName}</span>
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}
