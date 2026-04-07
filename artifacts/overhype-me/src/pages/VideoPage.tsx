import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetFact, getGetFactQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Share2, AlertCircle, ArrowLeft, Play, Download } from "lucide-react";

type VideoData = {
  id: number;
  factId: number;
  imageUrl: string;
  videoUrl: string | null;
  motionPrompt: string | null;
  styleId: string | null;
  status: string;
  isPrivate: boolean;
  createdAt: string;
};

export default function VideoPage() {
  const [, params] = useRoute("/video/:id");
  const videoId = params?.id ?? "";

  const { data: videoResult, isLoading, error } = useQuery<{ video: VideoData }>({
    queryKey: ["video-page", videoId],
    queryFn: async () => {
      const res = await fetch(`/api/video/${videoId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Video not found");
      return res.json() as Promise<{ video: VideoData }>;
    },
    enabled: !!videoId,
    retry: false,
  });

  const video = videoResult?.video ?? null;
  const factId = video?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId }
  });

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: "Overhype.me Video",
        text: fact?.fact ?? "Check out this fact!",
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => alert("Link copied!"));
    }
  };

  const handleTwitterShare = () => {
    const text = encodeURIComponent(`"${(fact?.fact ?? "").slice(0, 200)}" — Overhype.me`);
    const url = encodeURIComponent(window.location.href);
    window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
  };

  const handleDownload = () => {
    if (!video?.videoUrl) return;
    fetch(video.videoUrl)
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `overhype-video-${videoId}.mp4`;
        a.click();
      })
      .catch(console.error);
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

  if (error || !video) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-destructive/10 border-2 border-destructive text-center">
          <AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4" />
          <h2 className="text-3xl font-display text-destructive uppercase mb-2">Video Not Found</h2>
          <p className="text-muted-foreground mb-6">This video may have been removed or is not publicly available.</p>
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
          <Link href={factId ? `/facts/${factId}/meme` : "/"}>
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-primary">
              <ArrowLeft className="w-4 h-4" /> Back to Fact
            </Button>
          </Link>
        </div>

        <div className="bg-card border-l-8 border-primary p-6 md:p-10 shadow-2xl space-y-8">
          <h1 className="text-2xl md:text-3xl font-display uppercase tracking-wide text-primary flex items-center gap-3">
            <Play className="w-7 h-7" /> Fact Meme Video
          </h1>

          <div className="relative bg-black rounded-sm border-2 border-border overflow-hidden aspect-video">
            {video.videoUrl ? (
              <video
                src={video.videoUrl}
                poster={video.imageUrl}
                controls
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <img src={video.imageUrl} alt="Video source" className="w-full h-full object-cover opacity-40" />
                <Play className="absolute w-14 h-14 text-white/50" />
              </div>
            )}
          </div>

          {fact && (
            <div className="border-t-2 border-border pt-6">
              <blockquote className="text-lg text-foreground italic leading-relaxed mb-4">
                "{fact.fact}"
              </blockquote>
              <Link href={`/facts/${factId}`}>
                <Button variant="secondary" size="sm" className="gap-2">
                  Read Full Fact →
                </Button>
              </Link>
            </div>
          )}

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
            {video.videoUrl && (
              <Button onClick={handleDownload} variant="secondary" className="gap-2">
                <Download className="w-4 h-4" /> Download Video
              </Button>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
