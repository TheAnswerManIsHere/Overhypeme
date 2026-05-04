import { useState, useEffect, useRef, Suspense } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { format } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useGetFact, useListComments, getGetFactQueryKey, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { AdSlot } from "@/components/AdSlot";

import { ThumbsUp, ThumbsDown, User, AlertCircle, GitBranch, ArrowLeft, Crown, Flame, Video, Play, ExternalLink, MessageSquare, Check } from "lucide-react";
import { ImageCard } from "@/components/ui/ImageCard";
import { CommentHeartButton } from "@/components/comments/CommentHeartButton";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { AccessGate } from "@/components/AccessGate";
import { renderFact } from "@/lib/render-fact";
import type { FactPexelsImages } from "@/types/pexels";

import { lazyWithRetry } from "@/lib/lazy-retry";
import { AdminMediaInfo, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";

const MemeStudio = lazyWithRetry(() => import("@/components/MemeStudio").then(m => ({ default: m.MemeStudio })));
const HCaptcha = lazyWithRetry(() => import("@hcaptcha/react-hcaptcha"));

type MemeItem = {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  isPublic: boolean;
  createdById: string | null;
  createdAt: string;
  aspectRatio?: "landscape" | "square" | "portrait";
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
  heartCount: number;
  viewerHasHearted: boolean;
};

const MEME_ASPECT_CLASS: Record<string, string> = {
  landscape: "aspect-video",
  square: "aspect-square",
  portrait: "aspect-[9/16]",
};

type VideoItem = {
  id: number;
  factId: number;
  imageUrl: string;
  videoUrl: string | null;
  motionPrompt: string | null;
  styleId: string | null;
  isPrivate: boolean;
  userId: string | null;
  createdAt: string;
};

async function fetchVideos(factId: number): Promise<{ videos: VideoItem[] }> {
  const res = await fetch(`/api/videos/${factId}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch videos");
  return res.json() as Promise<{ videos: VideoItem[] }>;
}

async function fetchMemes(factId: number, visibility: "community" | "my-public" | "my-private"): Promise<{ memes: MemeItem[] }> {
  const res = await fetch(`/api/facts/${factId}/memes?visibility=${visibility}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch memes");
  return res.json() as Promise<{ memes: MemeItem[] }>;
}

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

function VariantFactCard({ id, useCase }: { id: number; useCase: string | null }) {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { rateFact } = useAppMutations();
  const { name, pronouns } = usePersonName();
  const [showStudio, setShowStudio] = useState(false);
  const [studioDefaultTab, setStudioDefaultTab] = useState<"image" | "video">("image");

  const { data: fact, isLoading } = useGetFact(id, {
    query: { queryKey: getGetFactQueryKey(id), enabled: true }
  });

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) return setLocation(`/login?from=/facts/${id}`);
    const newRating = fact?.userRating === type ? "none" : type;
    rateFact.mutate({ factId: id, data: { rating: newRating } });
  };

  if (isLoading || !fact) {
    return (
      <div className="bg-card border-l-4 border-primary/30 p-6 animate-pulse rounded-sm">
        <div className="h-6 bg-muted rounded w-3/4 mb-4" />
        <div className="h-4 bg-muted rounded w-1/2" />
      </div>
    );
  }

  const renderedText = renderFact(fact.text, name, pronouns);

  return (
    <div className="bg-card border-l-4 border-primary/60 p-6 md:p-8 shadow-lg relative">
      {showStudio && (
        <Suspense fallback={null}>
          <MemeStudio
            factId={id}
            factText={renderedText}
            rawFactText={fact.text}
            aiMemeImages={(fact as unknown as { aiMemeImages?: import("@/types/meme").AiMemeImages | null })?.aiMemeImages ?? null}
            onClose={() => setShowStudio(false)}
            defaultTab={studioDefaultTab}
          />
        </Suspense>
      )}

      {useCase && (
        <span className="inline-block mb-4 text-xs font-bold font-display tracking-widest uppercase text-primary bg-primary/10 border border-primary/30 px-2 py-0.5 rounded-sm">
          {useCase.replace(/_/g, " ")}
        </span>
      )}

      <h2 className="text-2xl md:text-3xl font-bold leading-tight text-foreground mb-6">
        "{renderedText}"
      </h2>

      {fact.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {fact.hashtags.map(tag => (
            <span key={tag} className="text-xs font-bold font-display tracking-wider text-muted-foreground bg-secondary border border-border px-2 py-0.5 rounded-sm uppercase">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap border-t-2 border-border pt-5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleRate("up")}
          className={cn("gap-2", fact.userRating === "up" && "bg-primary/20 text-primary border-primary")}
          disabled={rateFact.isPending}
        >
          <ThumbsUp className={cn("w-4 h-4", fact.userRating === "up" && "fill-current")} />
          <span>{fact.upvotes}</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleRate("down")}
          className={cn("gap-2", fact.userRating === "down" && "bg-destructive/20 text-destructive border-destructive")}
          disabled={rateFact.isPending}
        >
          <ThumbsDown className={cn("w-4 h-4", fact.userRating === "down" && "fill-current")} />
          <span>{fact.downvotes}</span>
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { setStudioDefaultTab("image"); setShowStudio(true); }}
          className="gap-2"
        >
          <Flame className="w-4 h-4" />
          MAKE MEME
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { setStudioDefaultTab("video"); setShowStudio(true); }}
          className="gap-2"
        >
          <Video className="w-4 h-4" />
          MAKE VIDEO
        </Button>
        <Link href={`/facts/${id}`} className="ml-auto text-xs text-muted-foreground hover:text-primary transition-colors font-medium underline underline-offset-4">
          View discussion →
        </Link>
      </div>

    </div>
  );
}

// ── VideoCardItem ─────────────────────────────────────────────────────────────
// Isolated component so each video card tracks its own playback dimensions

function VideoCardItem({ video }: { video: VideoItem }) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  return (
    <div className="space-y-1.5">
      <div className="relative border-2 border-border rounded-sm overflow-hidden group hover:border-primary/60 transition-all">
        <div className="aspect-video relative bg-black">
          <video
            src={video.videoUrl ?? ""}
            poster={video.imageUrl}
            controls
            preload="metadata"
            className="w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0) setDims({ width: v.videoWidth, height: v.videoHeight });
            }}
          />
          {!video.videoUrl && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Play className="w-10 h-10 text-white/40" />
            </div>
          )}
        </div>
        {video.motionPrompt && (
          <div className="px-2 py-1.5 bg-secondary/80 border-t border-border">
            <p className="text-[10px] text-muted-foreground line-clamp-1">{video.motionPrompt}</p>
          </div>
        )}
      </div>
      {video.videoUrl && (
        <AdminMediaInfo
          fileName={getFileNameFromUrl(video.videoUrl)}
          fileSizeBytes={null}
          mimeType={getMimeTypeFromUrl(video.videoUrl)}
          width={dims?.width ?? null}
          height={dims?.height ?? null}
        />
      )}
      <Link href={`/video/${video.id}`} className="w-full flex items-center justify-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
        <ExternalLink className="w-3 h-3" /> View Permalink
      </Link>
    </div>
  );
}

// ── FactDetail ────────────────────────────────────────────────────────────────

export default function FactDetail() {
  const [, params] = useRoute("/facts/:id/:sub?");
  const factId = parseInt(params?.id || "0", 10);
  const isMemeRoute = params?.sub === "meme";
  const isVideoRoute = params?.sub === "video";
  const [, setLocation] = useLocation();
  const { isAuthenticated, role, user } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";
  const { rateFact, addComment } = useAppMutations();

  const { data: fact, isLoading: factLoading, error: factError } = useGetFact(factId, {
    query: { queryKey: getGetFactQueryKey(factId), enabled: !!factId }
  });

  const [galleryTab, setGalleryTab] = useState<"community" | "mine">("community");
  const [mediaFilter, setMediaFilter] = useState<"all" | "image" | "video">("all");
  const [belowFoldMounted, setBelowFoldMounted] = useState(false);
  const queryClient = useQueryClient();

  const belowFoldSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (belowFoldMounted) return;
    const sentinel = belowFoldSentinelRef.current;
    if (!sentinel) return;

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            setBelowFoldMounted(true);
            observer.disconnect();
          }
        },
        { rootMargin: "200px" }
      );
      observer.observe(sentinel);

      const ric = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : null;
      let ricId: number;
      const fallback = () => {
        setBelowFoldMounted(true);
        observer.disconnect();
      };
      if (ric) {
        ricId = ric(fallback, { timeout: 5000 });
      } else {
        ricId = setTimeout(fallback, 5000) as unknown as number;
      }

      return () => {
        observer.disconnect();
        if (ric) cancelIdleCallback(ricId);
        else clearTimeout(ricId as unknown as ReturnType<typeof setTimeout>);
      };
    } else {
      const ric = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : null;
      let id: number;
      if (ric) {
        id = ric(() => setBelowFoldMounted(true));
      } else {
        id = setTimeout(() => setBelowFoldMounted(true), 0) as unknown as number;
      }
      return () => {
        if (ric) cancelIdleCallback(id);
        else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      };
    }
  }, [fact, belowFoldMounted]);

  const { data: commentsData } = useListComments(factId, { limit: 50 }, {
    query: { queryKey: getListCommentsQueryKey(factId, { limit: 50 }), enabled: !!factId && belowFoldMounted }
  });

  const { data: communityMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "community"],
    queryFn: () => fetchMemes(factId, "community"),
    enabled: !!factId && belowFoldMounted,
  });

  const { data: myPublicMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-public"],
    queryFn: () => fetchMemes(factId, "my-public"),
    enabled: !!factId && isAuthenticated && belowFoldMounted,
  });

  const { data: myPrivateMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-private"],
    queryFn: () => fetchMemes(factId, "my-private"),
    enabled: !!factId && isAuthenticated && belowFoldMounted,
  });

  const communityMemes = communityMemesData?.memes ?? [];
  const myPublicMemes = myPublicMemesData?.memes ?? [];
  const myPrivateMemes = myPrivateMemesData?.memes ?? [];

  const { data: videosData } = useQuery({
    queryKey: ["listFactVideos", factId],
    queryFn: () => fetchVideos(factId),
    enabled: !!factId && belowFoldMounted,
  });

  const { name, pronouns } = usePersonName();
  const [commentText, setCommentText] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [commentSubmitted, setCommentSubmitted] = useState(false);

  // Meme builder open state is derived from URL (/facts/:id/meme)
  // so that mobile browsers reloading the tab re-open the builder automatically.
  const [memeBuilderDefaultPrivate, setMemeBuilderDefaultPrivate] = useState(false);
  const [studioDefaultTab, setStudioDefaultTab] = useState<"image" | "video">("image");

  const showMemeStudio = isMemeRoute || isVideoRoute;
  const openMemeStudio = (tab: "image" | "video" = "image") => {
    setStudioDefaultTab(tab);
    setLocation(`/facts/${factId}/meme`);
  };
  const openMemeStudioPrivate = () => { setMemeBuilderDefaultPrivate(true); openMemeStudio("image"); };
  const closeMemeStudio = () => {
    setMemeBuilderDefaultPrivate(false);
    setLocation(`/facts/${factId}`);
    void queryClient.invalidateQueries({ queryKey: ["listFactVideos", factId] });
  };

  async function handleDeleteMeme(slug: string) {
    const res = await fetch(`/api/memes/${slug}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) throw new Error("Failed to delete meme");
    await queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
  }

  const pexelsImages = ((fact as unknown as { pexelsImages?: FactPexelsImages | null })?.pexelsImages) ?? null;
  const aiMemeImages = ((fact as unknown as { aiMemeImages?: import("@/types/meme").AiMemeImages | null })?.aiMemeImages) ?? null;

  if (factLoading) return <Layout><div className="flex h-[50vh] items-center justify-center"><div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div></Layout>;
  if (factError || !fact) return <Layout><div className="max-w-2xl mx-auto mt-20 p-8 bg-destructive/10 border-2 border-destructive text-center"><AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4"/><h2 className="text-3xl font-display text-destructive uppercase">Classified Record Not Found</h2></div></Layout>;

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) return setLocation(`/login?from=/facts/${factId}`);
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId, data: { rating: newRating } });
  };

  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) return setLocation(`/login?from=/facts/${factId}`);
    if (!commentText.trim()) return;

    addComment.mutate({ factId, data: { text: commentText, captchaToken } }, {
      onSuccess: () => {
        setCommentText("");
        setCaptchaToken("");
        setCommentSubmitted(true);
      }
    });
  };

  const renderedText = renderFact(fact.text, name, pronouns);
  const isVariant = !!fact.parentId;

  return (
    <Layout>
      {/* Desktop Meme Creator stepper — fixed bar below the nav */}
      {showMemeStudio && (
        <div className="hidden md:flex fixed top-16 left-0 right-0 z-[200] bg-background/95 backdrop-blur border-b border-border items-center justify-center h-10 gap-0">
          <div className="flex items-center gap-1.5 px-5">
            <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
              <Check className="w-2.5 h-2.5 text-white" />
            </div>
            <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-green-500 font-display">Pick a fact</span>
          </div>
          <span className="text-muted-foreground/30 text-xs">›</span>
          <div className="flex items-center gap-1.5 px-5">
            <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
              <span className="text-[8px] font-bold text-white leading-none">2</span>
            </div>
            <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-foreground font-display">Add your face</span>
          </div>
          <span className="text-muted-foreground/30 text-xs">›</span>
          <div className="flex items-center gap-1.5 px-5">
            <div className="w-4 h-4 rounded-full border border-border flex items-center justify-center flex-shrink-0">
              <span className="text-[8px] font-bold text-muted-foreground leading-none">3</span>
            </div>
            <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-muted-foreground font-display">Style &amp; share</span>
          </div>
        </div>
      )}

      {showMemeStudio && (
        <Suspense fallback={null}>
          <MemeStudio
            factId={factId}
            factText={renderedText}
            rawFactText={fact.text}
            pexelsImages={pexelsImages}
            aiMemeImages={aiMemeImages}
            onClose={closeMemeStudio}
            defaultPrivate={memeBuilderDefaultPrivate}
            defaultTab={isVideoRoute ? "video" : studioDefaultTab}
          />
        </Suspense>
      )}
      <div className="max-w-4xl mx-auto px-4 py-12 md:py-20">

        {/* Parent fact button — prominent banner when this fact is a variant */}
        {isVariant && (
          <Link href={`/facts/${fact.parentId}`}>
            <div className="mb-8 flex items-center gap-4 bg-primary/10 border-2 border-primary/40 hover:border-primary hover:bg-primary/15 transition-all p-5 rounded-sm cursor-pointer group">
              <div className="shrink-0 w-12 h-12 bg-primary/20 border-2 border-primary/40 group-hover:border-primary rounded-sm flex items-center justify-center transition-colors">
                <ArrowLeft className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs font-display uppercase tracking-widest text-primary/70 mb-0.5">Variant of</p>
                <p className="text-lg font-bold font-display uppercase tracking-wide text-primary group-hover:underline underline-offset-4">
                  View Original Fact #{fact.parentId}
                </p>
              </div>
              <GitBranch className="w-6 h-6 text-primary/40 ml-auto" />
            </div>
          </Link>
        )}

        {/* Main Fact Card — compact header, consistent with feed cards */}
        <div className="bg-card rounded-2xl border border-border shadow-lg p-6 md:p-8 relative mb-4 overflow-hidden">
          {/* Compact meta strip */}
          <div className="flex items-center gap-2 mb-4 text-[10px] font-display font-bold tracking-widest uppercase text-muted-foreground">
            <Flame className="w-3 h-3 text-primary" />
            {name && <span>About {name}</span>}
            <span className="opacity-30">·</span>
            <span>{format(new Date(fact.createdAt), 'MMM dd, yyyy')}</span>
            {fact.submittedBy && (
              <><span className="opacity-30">·</span><span className="text-primary">{fact.submittedBy}</span></>
            )}
          </div>

          <h1 className="text-2xl md:text-3xl font-display font-bold leading-tight uppercase tracking-tight text-foreground mb-5">
            "{renderedText}"
          </h1>

          {fact.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-5">
              {fact.hashtags.map(tag => (
                <span key={tag} className="text-xs font-semibold font-display tracking-wide text-muted-foreground bg-secondary/80 px-2.5 py-1 rounded-full uppercase border border-border/50">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Engagement row — pill upvote matching feed */}
          <div className="flex items-center gap-3 pt-4 border-t border-border/50">
            <div className={cn(
              "inline-flex items-center rounded-full border h-9 transition-colors",
              fact.userRating === "up"
                ? "bg-primary/[0.14] border-primary text-primary"
                : "bg-secondary border-border/80 text-foreground"
            )}>
              <button
                onClick={() => handleRate("up")}
                disabled={rateFact.isPending}
                className="flex items-center gap-2 pl-4 pr-2.5 h-full"
                title="Upvote"
              >
                <ThumbsUp className={cn("w-4 h-4", fact.userRating === "up" && "fill-current")} />
                <span className="text-sm font-bold">{fact.upvotes}</span>
              </button>
              <span className="w-px h-4 bg-border/80 flex-shrink-0" />
              <button
                onClick={() => handleRate("down")}
                disabled={rateFact.isPending}
                className={cn(
                  "flex items-center px-2.5 h-full transition-colors",
                  fact.userRating === "down" ? "text-destructive" : "text-muted-foreground/60 hover:text-muted-foreground"
                )}
                title="Downvote"
              >
                <ThumbsDown className={cn("w-4 h-4", fact.userRating === "down" && "fill-current")} />
              </button>
            </div>

            <Link href="#comments" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <MessageSquare className="w-5 h-5" />
              <span className="text-sm font-semibold">{fact.commentCount}</span>
            </Link>
          </div>
        </div>

        {/* PRIMARY CTA — Make a meme, full-width, prominent */}
        <div className="mb-4">
          <Button
            variant="primary"
            size="lg"
            onClick={() => openMemeStudio("image")}
            className="w-full h-14 gap-3 shadow-[0_8px_20px_rgba(255,101,0,0.22)] tracking-widest"
          >
            <Flame className="w-5 h-5" />
            MAKE A MEME OF THIS
          </Button>
        </div>

        {/* Ad slot — hidden for premium users */}
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_FACT_FOOTER ?? "1234567890"} format="horizontal" className="mb-8" />

        {/* Sentinel: IntersectionObserver watches this to trigger below-fold content */}
        <div ref={belowFoldSentinelRef} aria-hidden="true" />

        {belowFoldMounted && (<>

        {/* Gallery — the reason you came here */}
        <div className="mb-12">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-2xl font-display uppercase tracking-wide">Memes from this fact</h3>
            <span className="text-sm text-muted-foreground font-medium">
              {communityMemes.length + myPublicMemes.length + myPrivateMemes.length} total
            </span>
          </div>

          {/* COMMUNITY / MINE segmented tabs */}
          <div className="flex gap-1 bg-secondary border border-border/60 rounded-xl p-1 mb-4">
            <button
              onClick={() => setGalleryTab("community")}
              className={cn(
                "flex-1 h-9 rounded-[10px] font-display font-bold text-xs tracking-widest uppercase transition-all flex items-center justify-center gap-2",
                galleryTab === "community"
                  ? "bg-card text-foreground shadow-sm border border-border/40"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Community
              <span className={cn("text-[10px]", galleryTab === "community" ? "text-muted-foreground" : "opacity-50")}>
                {communityMemes.length}
              </span>
            </button>
            {isAuthenticated && (
              <button
                onClick={() => setGalleryTab("mine")}
                className={cn(
                  "flex-1 h-9 rounded-[10px] font-display font-bold text-xs tracking-widest uppercase transition-all flex items-center justify-center gap-2",
                  galleryTab === "mine"
                    ? "bg-card text-foreground shadow-sm border border-border/40"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Mine
                <span className={cn("text-[10px]", galleryTab === "mine" ? "text-muted-foreground" : "opacity-50")}>
                  {myPublicMemes.length + myPrivateMemes.length}
                </span>
              </button>
            )}
          </div>

          {/* Image / Video sub-toggle */}
          <div className="flex gap-2 mb-6">
            {(["all", "image", "video"] as const).map(v => (
              <button
                key={v}
                onClick={() => setMediaFilter(v)}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors",
                  mediaFilter === v
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                )}
              >
                {v === "all" ? "All" : v === "image" ? "Images" : "Videos"}
              </button>
            ))}
          </div>

          {/* Meme image grid */}
          {(mediaFilter === "all" || mediaFilter === "image") && (() => {
            const memes = galleryTab === "community"
              ? communityMemes
              : [...myPublicMemes, ...myPrivateMemes];

            return memes.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start mb-6">
                {memes.map(meme => {
                  const isMyMeme = galleryTab === "mine" || (!!user?.id && meme.createdById === user.id);
                  const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                  return (
                    <div key={meme.id} className="relative space-y-1.5">
                      {/* Privacy badge — only shown in Mine tab */}
                      {galleryTab === "mine" && (
                        <div className={cn(
                          "absolute top-2 right-2 z-10 px-2 py-0.5 rounded-full text-[9px] font-bold font-display uppercase tracking-wider",
                          meme.isPublic
                            ? "bg-primary text-white"
                            : "bg-black/60 text-white backdrop-blur-sm"
                        )}>
                          {meme.isPublic ? "Public" : "Private"}
                        </div>
                      )}
                      <ImageCard
                        src={meme.imageUrl}
                        alt="Meme"
                        href={`/meme/${meme.permalinkSlug}`}
                        aspectRatio={MEME_ASPECT_CLASS[meme.aspectRatio ?? "landscape"] ?? "aspect-video"}
                        actions={isMyMeme ? ["delete", "copyLink", "openFull", "makeMerch"] : ["copyLink", "openFull", "makeMerch"]}
                        onDelete={isMyMeme ? () => handleDeleteMeme(meme.permalinkSlug) : undefined}
                        zazzleUrl={`/api/memes/${meme.permalinkSlug}/zazzle-redirect?source=fact-detail&returnUrl=${encodeURIComponent(window.location.href)}`}
                        deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                        permalink={memePermalink}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(meme.imageUrl)} fileSizeBytes={meme.uploadFileSizeBytes} mimeType={getMimeTypeFromUrl(meme.imageUrl)} width={meme.originalWidth} height={meme.originalHeight} />}
                      />
                      <div className="w-full flex items-center justify-between gap-2 px-1 py-1">
                        <MemeHeartButton
                          memeId={meme.id}
                          initialHeartCount={meme.heartCount}
                          initialViewerHasHearted={meme.viewerHasHearted}
                          stopPropagation
                          size="sm"
                        />
                        <Link href={`/meme/${meme.permalinkSlug}`} className="flex items-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors">
                          <ExternalLink className="w-3 h-3" /> View Permalink
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-12 text-center border-2 border-dashed border-border rounded-2xl mb-6">
                <p className="text-muted-foreground mb-4">
                  {galleryTab === "community" ? "No community memes yet. Be the first!" : "You haven't made any memes for this fact yet."}
                </p>
                {galleryTab === "mine" && (
                  <button
                    onClick={() => openMemeStudio("image")}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-opacity"
                  >
                    <Flame className="w-4 h-4" /> Create your first meme
                  </button>
                )}
              </div>
            );
          })()}

          {/* Video grid */}
          {(mediaFilter === "all" || mediaFilter === "video") && (() => {
            const allVideos = videosData?.videos ?? [];
            const videos = galleryTab === "community"
              ? allVideos.filter(v => !v.isPrivate && v.userId !== user?.id)
              : allVideos.filter(v => v.userId === user?.id);

            return videos.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start mb-6">
                {videos.map(video => <VideoCardItem key={video.id} video={video} />)}
              </div>
            ) : mediaFilter === "video" ? (
              <div className="py-12 text-center border-2 border-dashed border-border rounded-2xl mb-6">
                <p className="text-muted-foreground mb-4">
                  {galleryTab === "community" ? "No community videos yet." : "You haven't made any videos for this fact yet."}
                </p>
                {galleryTab === "mine" && (
                  <button
                    onClick={() => openMemeStudio("video")}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-opacity"
                  >
                    <Video className="w-4 h-4" /> Create your first video
                  </button>
                )}
              </div>
            ) : null;
          })()}

          {/* Private-by-default hint — only shown in Mine tab when there's content */}
          {galleryTab === "mine" && isAuthenticated && (myPublicMemes.length + myPrivateMemes.length) > 0 && (
            <div className="flex gap-3 items-start p-4 bg-secondary rounded-2xl border border-border mt-2">
              <span className="text-base leading-none pt-0.5">🔒</span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your memes are <strong className="text-foreground">private by default</strong>. Tap a meme to publish it to the community.
              </p>
            </div>
          )}
        </div>

        {/* Layout split for Links and Comments */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">

          {/* Comments Section */}
          <div className="lg:col-span-2 space-y-8">
            <h3 id="comments" className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2">Comments ({fact.commentCount})</h3>

            {/* Comment Form */}
            {isAuthenticated ? (
              commentSubmitted ? (
                <div className="bg-secondary p-6 rounded-sm border-2 border-border text-center space-y-3">
                  <p className="font-display font-bold text-foreground uppercase tracking-wide">Intel Received</p>
                  <p className="text-sm text-muted-foreground">Your comment is pending review and will appear once approved.</p>
                  <Button variant="outline" size="sm" onClick={() => setCommentSubmitted(false)}>Submit Another</Button>
                </div>
              ) : (
                <form onSubmit={handleCommentSubmit} className="bg-secondary p-6 rounded-sm border-2 border-border space-y-4">
                  <Textarea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="Drop some knowledge..."
                    className="bg-background min-h-[100px]"
                  />
                  <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                    {isLegendary ? (
                      <div className="flex items-center gap-2 text-yellow-500 text-sm font-display font-bold uppercase tracking-wider">
                        <Crown className="w-4 h-4" /> Captcha skipped (Legendary)
                      </div>
                    ) : (
                      <div className="overflow-hidden rounded-sm border-2 border-border">
                        <Suspense fallback={<div className="w-[303px] h-[78px] bg-muted animate-pulse rounded-sm" />}>
                          <HCaptcha
                            sitekey={HCAPTCHA_SITE_KEY}
                            onVerify={setCaptchaToken}
                          />
                        </Suspense>
                      </div>
                    )}
                    <Button type="submit" isLoading={addComment.isPending} disabled={!commentText.trim()} className="w-full sm:w-auto">
                      POST INTEL
                    </Button>
                  </div>
                </form>
              )
            ) : (
              <AccessGate reason="login" size="sm" description="Authentication required to add intel." returnTo={`/facts/${factId}`} />
            )}

            {/* Comment List */}
            <div className="space-y-4">
              {commentsData?.comments.map(comment => (
                <div key={comment.id} className="bg-card p-5 border-l-4 border-muted rounded-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {comment.authorImage ? (
                        <img src={comment.authorImage} alt="Avatar" className="w-8 h-8 rounded-sm" />
                      ) : (
                        <div className="w-8 h-8 bg-muted flex items-center justify-center rounded-sm">
                          <User className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                      <span className="font-bold text-primary">{comment.authorName || "ANONYMOUS"}</span>
                    </div>
                    <span className="text-xs text-muted-foreground font-medium">{format(new Date(comment.createdAt), 'MMM dd, yyyy')}</span>
                  </div>
                  <p className="text-foreground leading-relaxed">{comment.text}</p>
                  <div className="mt-3 flex items-center">
                    <CommentHeartButton
                      commentId={comment.id}
                      initialHeartCount={comment.heartCount}
                      initialViewerHasHearted={comment.viewerHasHearted}
                    />
                  </div>
                </div>
              ))}
              {commentsData?.comments.length === 0 && (
                <p className="text-muted-foreground py-8 text-center border-2 border-dashed border-border rounded-sm">No intel submitted yet.</p>
              )}
            </div>
          </div>

        </div>

        {/* Variants — only shown on root (parent) facts, never on variants themselves */}
        {!isVariant && fact.variants && fact.variants.length > 0 && (
          <div className="mt-16">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2 mb-8 flex items-center gap-3">
              <GitBranch className="w-6 h-6 text-primary" />
              Alternate Phrasings ({fact.variants.length})
            </h3>
            <div className="space-y-6">
              {fact.variants.map(v => (
                <VariantFactCard key={v.id} id={v.id} useCase={v.useCase ?? null} />
              ))}
            </div>
          </div>
        )}

        </>)}

      </div>
    </Layout>
  );
}
