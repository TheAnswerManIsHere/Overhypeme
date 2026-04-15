import { useState, useEffect } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { format } from "date-fns";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useGetFact, useListComments, getGetFactQueryKey, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { MemeStudio } from "@/components/MemeStudio";
import { AdSlot } from "@/components/AdSlot";
import { ThumbsUp, ThumbsDown, User, AlertCircle, ImageIcon, GitBranch, ArrowLeft, Crown, Flame, Globe, Lock, Video, Play, ExternalLink } from "lucide-react";
import { ImageCard } from "@/components/ui/ImageCard";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { AccessGate } from "@/components/AccessGate";
import { renderFact } from "@/lib/render-fact";

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
        <MemeStudio
          factId={id}
          factText={renderedText}
          rawFactText={fact.text}
          aiMemeImages={(fact as unknown as { aiMemeImages?: import("@/components/MemeStudio").AiMemeImages | null })?.aiMemeImages ?? null}
          onClose={() => setShowStudio(false)}
          defaultTab={studioDefaultTab}
        />
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

interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    number[];
  female:  number[];
  neutral: number[];
}

// ── FactDetail ────────────────────────────────────────────────────────────────

export default function FactDetail() {
  const [, params] = useRoute("/facts/:id/:sub?");
  const factId = parseInt(params?.id || "0", 10);
  const isMemeRoute = params?.sub === "meme";
  const isVideoRoute = params?.sub === "video";
  const [, setLocation] = useLocation();
  const { isAuthenticated, role, user } = useAuth();
  const isPremium = role === "legendary" || role === "admin";
  const { rateFact, addComment } = useAppMutations();

  const { data: fact, isLoading: factLoading, error: factError } = useGetFact(factId, {
    query: { queryKey: getGetFactQueryKey(factId), enabled: !!factId }
  });

  const { data: commentsData } = useListComments(factId, { limit: 50 }, {
    query: { queryKey: getListCommentsQueryKey(factId, { limit: 50 }), enabled: !!factId }
  });

  const [showImages, setShowImages] = useState(() => localStorage.getItem("meme_show_images") !== "false");
  const [showVideos, setShowVideos] = useState(() => localStorage.getItem("meme_show_videos") !== "false");
  const [showCommunity, setShowCommunity] = useState(() => localStorage.getItem("meme_show_community") !== "false");
  const [showMyPublic, setShowMyPublic] = useState(() => localStorage.getItem("meme_show_my_public") !== "false");
  const [showMyPrivate, setShowMyPrivate] = useState(() => localStorage.getItem("meme_show_my_private") !== "false");
  const queryClient = useQueryClient();

  useEffect(() => { localStorage.setItem("meme_show_images", String(showImages)); }, [showImages]);
  useEffect(() => { localStorage.setItem("meme_show_videos", String(showVideos)); }, [showVideos]);
  useEffect(() => { localStorage.setItem("meme_show_community", String(showCommunity)); }, [showCommunity]);
  useEffect(() => { localStorage.setItem("meme_show_my_public", String(showMyPublic)); }, [showMyPublic]);
  useEffect(() => { localStorage.setItem("meme_show_my_private", String(showMyPrivate)); }, [showMyPrivate]);

  const { data: communityMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "community"],
    queryFn: () => fetchMemes(factId, "community"),
    enabled: !!factId,
  });

  const { data: myPublicMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-public"],
    queryFn: () => fetchMemes(factId, "my-public"),
    enabled: !!factId && isAuthenticated,
  });

  const { data: myPrivateMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-private"],
    queryFn: () => fetchMemes(factId, "my-private"),
    enabled: !!factId && isAuthenticated,
  });

  const communityMemes = communityMemesData?.memes ?? [];
  const myPublicMemes = myPublicMemesData?.memes ?? [];
  const myPrivateMemes = myPrivateMemesData?.memes ?? [];

  const { data: videosData } = useQuery({
    queryKey: ["listFactVideos", factId],
    queryFn: () => fetchVideos(factId),
    enabled: !!factId,
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
  const aiMemeImages = ((fact as unknown as { aiMemeImages?: import("@/components/MemeStudio").AiMemeImages | null })?.aiMemeImages) ?? null;

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
      {showMemeStudio && (
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

        {/* Main Fact Card */}
        <div className="bg-card border-l-8 border-primary p-8 md:p-12 shadow-2xl relative mb-12 overflow-hidden">
          <h1 className="text-3xl md:text-5xl font-bold leading-tight text-foreground relative z-10 mb-8 mt-4">
            "{renderedText}"
          </h1>

          <div className="flex flex-wrap gap-2 mb-10 relative z-10">
            {fact.hashtags.map(tag => (
              <span key={tag} className="text-sm font-bold font-display tracking-wider text-muted-foreground bg-secondary border border-border px-3 py-1 rounded-sm uppercase">
                #{tag}
              </span>
            ))}
          </div>

          <div className="flex items-center justify-between border-t-2 border-border pt-6 mt-6">
            <div className="flex items-center gap-4 flex-wrap">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => handleRate("up")}
                className={cn("gap-3 h-14", fact.userRating === "up" && "bg-primary/20 text-primary border-primary")}
                disabled={rateFact.isPending}
              >
                <ThumbsUp className={cn("w-6 h-6", fact.userRating === "up" && "fill-current")} />
                <span className="text-xl">{fact.upvotes}</span>
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => handleRate("down")}
                className={cn("gap-3 h-14", fact.userRating === "down" && "bg-destructive/20 text-destructive border-destructive")}
                disabled={rateFact.isPending}
              >
                <ThumbsDown className={cn("w-6 h-6", fact.userRating === "down" && "fill-current")} />
                <span className="text-xl">{fact.downvotes}</span>
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={() => openMemeStudio("image")}
                className="gap-2 h-14"
              >
                <Flame className="w-5 h-5" />
                <span>MAKE MEME</span>
              </Button>
            </div>

            <div className="text-muted-foreground text-sm font-medium text-right">
              <div>FACT ID {fact.id} &nbsp;·&nbsp; ADDED: {format(new Date(fact.createdAt), 'MMM dd, yyyy')}</div>
              {fact.submittedBy && <div className="text-primary mt-1">BY {fact.submittedBy.toUpperCase()}</div>}
            </div>
          </div>

        </div>

        {/* Ad slot below fact card — hidden for premium users */}
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_FACT_FOOTER ?? "1234567890"} format="horizontal" className="mb-8" />

        {/* Media Gallery — above comments */}
        <div className="mb-12">
          {/* Gallery header */}
          <div className="border-b-2 border-border pb-4 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-y-3 gap-x-4 mb-4">
              <h3 className="text-2xl font-display uppercase tracking-wide flex items-center gap-3">
                <ImageIcon className="w-6 h-6 text-primary" /> Memes
              </h3>
            </div>
            {/* Checkbox filters */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {/* Media type */}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showImages}
                    onChange={e => setShowImages(e.target.checked)}
                    className="accent-primary w-3.5 h-3.5"
                  />
                  <span className="flex items-center gap-1 text-xs font-display font-bold uppercase tracking-wider text-foreground">
                    <ImageIcon className="w-3.5 h-3.5" /> Images
                  </span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showVideos}
                    onChange={e => setShowVideos(e.target.checked)}
                    className="accent-primary w-3.5 h-3.5"
                  />
                  <span className="flex items-center gap-1 text-xs font-display font-bold uppercase tracking-wider text-foreground">
                    <Video className="w-3.5 h-3.5" /> Videos
                  </span>
                </label>
              </div>

              <div className="h-4 w-px bg-border hidden sm:block" />

              {/* Visibility */}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showCommunity}
                    onChange={e => setShowCommunity(e.target.checked)}
                    className="accent-primary w-3.5 h-3.5"
                  />
                  <span className="flex items-center gap-1 text-xs font-display font-bold uppercase tracking-wider text-foreground">
                    <Globe className="w-3.5 h-3.5" /> Community
                  </span>
                </label>
                {isAuthenticated && (
                  <>
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showMyPublic}
                        onChange={e => setShowMyPublic(e.target.checked)}
                        className="accent-primary w-3.5 h-3.5"
                      />
                      <span className="text-xs font-display font-bold uppercase tracking-wider text-foreground">
                        My Public
                      </span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showMyPrivate}
                        onChange={e => setShowMyPrivate(e.target.checked)}
                        className="accent-primary w-3.5 h-3.5"
                      />
                      <span className="flex items-center gap-1 text-xs font-display font-bold uppercase tracking-wider text-foreground">
                        <Lock className="w-3.5 h-3.5" /> My Private
                      </span>
                    </label>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Images section */}
          {showImages && (
            <div className={cn("space-y-8", showVideos && "mb-10")}>
              <p className="text-xs font-display uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
                <ImageIcon className="w-3.5 h-3.5" /> Images
              </p>

              {/* Community images */}
              {showCommunity && (
                <div>
                  <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 pl-0.5 border-l-2 border-primary/30 pl-2">
                    <Globe className="w-3 h-3" /> Community
                  </p>
                  {communityMemes.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start">
                      {communityMemes.map(meme => {
                        const isMyMeme = !!user?.id && meme.createdById === user.id;
                        const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                        return (
                          <div key={meme.id} className="space-y-1.5">
                            <ImageCard
                              src={meme.imageUrl}
                              alt="Meme"
                              href={`/meme/${meme.permalinkSlug}`}
                              aspectRatio={MEME_ASPECT_CLASS[meme.aspectRatio ?? "landscape"] ?? "aspect-video"}
                              actions={isMyMeme ? ["delete", "copyLink", "openFull", "makeMerch"] : ["copyLink", "openFull", "makeMerch"]}
                              onDelete={isMyMeme ? () => handleDeleteMeme(meme.permalinkSlug) : undefined}
                              zazzleUrl={`/api/memes/${meme.permalinkSlug}/zazzle-redirect`}
                              deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                              permalink={memePermalink}
                            />
                            <Link href={`/meme/${meme.permalinkSlug}`} className="w-full flex items-center justify-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
                              <ExternalLink className="w-3 h-3" /> View Permalink
                            </Link>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground pl-2">No community memes yet. Be the first!</p>
                  )}
                </div>
              )}

              {/* My Public images */}
              {isAuthenticated && showMyPublic && (
                <div>
                  <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 border-l-2 border-primary/30 pl-2">
                    My Public
                  </p>
                  {myPublicMemes.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start">
                      {myPublicMemes.map(meme => {
                        const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                        return (
                          <div key={meme.id} className="space-y-1.5">
                            <ImageCard
                              src={meme.imageUrl}
                              alt="Meme"
                              href={`/meme/${meme.permalinkSlug}`}
                              aspectRatio={MEME_ASPECT_CLASS[meme.aspectRatio ?? "landscape"] ?? "aspect-video"}
                              actions={["delete", "copyLink", "openFull", "makeMerch"]}
                              onDelete={() => handleDeleteMeme(meme.permalinkSlug)}
                              zazzleUrl={`/api/memes/${meme.permalinkSlug}/zazzle-redirect`}
                              deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                              permalink={memePermalink}
                            />
                            <Link href={`/meme/${meme.permalinkSlug}`} className="w-full flex items-center justify-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
                              <ExternalLink className="w-3 h-3" /> View Permalink
                            </Link>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center border-2 border-dashed border-border rounded-sm">
                      <p className="text-muted-foreground mb-4">You haven't made any public memes for this fact yet.</p>
                      <button
                        onClick={() => openMemeStudio("image")}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-sm hover:opacity-90 transition-opacity"
                      >
                        Create your first public meme
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* My Private images */}
              {isAuthenticated && showMyPrivate && (
                <div>
                  <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 border-l-2 border-primary/30 pl-2">
                    <Lock className="w-3 h-3" /> My Private
                  </p>
                  {myPrivateMemes.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start">
                      {myPrivateMemes.map(meme => {
                        const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                        return (
                          <div key={meme.id} className="space-y-1.5">
                            <ImageCard
                              src={meme.imageUrl}
                              alt="Meme"
                              href={`/meme/${meme.permalinkSlug}`}
                              aspectRatio={MEME_ASPECT_CLASS[meme.aspectRatio ?? "landscape"] ?? "aspect-video"}
                              actions={["delete", "copyLink", "openFull", "makeMerch"]}
                              onDelete={() => handleDeleteMeme(meme.permalinkSlug)}
                              zazzleUrl={`/api/memes/${meme.permalinkSlug}/zazzle-redirect`}
                              deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                              permalink={memePermalink}
                            />
                            <Link href={`/meme/${meme.permalinkSlug}`} className="w-full flex items-center justify-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
                              <ExternalLink className="w-3 h-3" /> View Permalink
                            </Link>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center border-2 border-dashed border-border rounded-sm">
                      <p className="text-muted-foreground mb-4">You haven't made any private memes for this fact yet.</p>
                      <button
                        onClick={openMemeStudioPrivate}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-sm hover:opacity-90 transition-opacity"
                      >
                        Create your first private meme
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Videos section */}
          {showVideos && (() => {
            const allVideos = videosData?.videos ?? [];
            const communityVideos = allVideos.filter(v => !v.isPrivate && v.userId !== user?.id);
            const myPublicVideos = allVideos.filter(v => !v.isPrivate && v.userId === user?.id);
            const myPrivateVideos = allVideos.filter(v => v.isPrivate && v.userId === user?.id);

            const VideoGrid = ({ videos }: { videos: VideoItem[] }) => (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start">
                {videos.map(video => (
                  <div key={video.id} className="space-y-1.5">
                    <div className="relative border-2 border-border rounded-sm overflow-hidden group hover:border-primary/60 transition-all">
                      <div className="aspect-video relative bg-black">
                        <video
                          src={video.videoUrl ?? ""}
                          poster={video.imageUrl}
                          controls
                          preload="metadata"
                          className="w-full h-full object-cover"
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
                    <Link href={`/video/${video.id}`} className="w-full flex items-center justify-center gap-1.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
                      <ExternalLink className="w-3 h-3" /> View Permalink
                    </Link>
                  </div>
                ))}
              </div>
            );

            return (
              <div>
                <p className="text-xs font-display uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 mb-4">
                  <Video className="w-3.5 h-3.5" /> Videos
                </p>
                <div className="space-y-6">
                  {showCommunity && (
                    <div>
                      <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 border-l-2 border-primary/30 pl-2">
                        <Globe className="w-3 h-3" /> Community
                      </p>
                      {communityVideos.length > 0
                        ? <VideoGrid videos={communityVideos} />
                        : <p className="text-sm text-muted-foreground pl-2">No community videos yet.</p>
                      }
                    </div>
                  )}
                  {isAuthenticated && showMyPublic && (
                    <div>
                      <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 border-l-2 border-primary/30 pl-2">
                        <Globe className="w-3 h-3" /> My Public
                      </p>
                      {myPublicVideos.length > 0
                        ? <VideoGrid videos={myPublicVideos} />
                        : (
                          <div className="py-8 text-center border-2 border-dashed border-border rounded-sm">
                            <p className="text-muted-foreground mb-4">You haven't made any public videos for this fact yet.</p>
                            <button
                              onClick={() => openMemeStudio("video")}
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-sm hover:opacity-90 transition-opacity"
                            >
                              Create your first public video
                            </button>
                          </div>
                        )
                      }
                    </div>
                  )}
                  {isAuthenticated && showMyPrivate && (
                    <div>
                      <p className="text-[11px] font-display uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-3 border-l-2 border-primary/30 pl-2">
                        <Lock className="w-3 h-3" /> My Private
                      </p>
                      {myPrivateVideos.length > 0
                        ? <VideoGrid videos={myPrivateVideos} />
                        : (
                          <div className="py-8 text-center border-2 border-dashed border-border rounded-sm">
                            <p className="text-muted-foreground mb-4">You haven't made any private videos for this fact yet.</p>
                            <button
                              onClick={() => { setMemeBuilderDefaultPrivate(true); openMemeStudio("video"); }}
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-display font-bold uppercase tracking-wider bg-primary text-primary-foreground rounded-sm hover:opacity-90 transition-opacity"
                            >
                              Create your first private video
                            </button>
                          </div>
                        )
                      }
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Layout split for Links and Comments */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">

          {/* Comments Section */}
          <div className="lg:col-span-2 space-y-8">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2">Comments ({fact.commentCount})</h3>

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
                    {isPremium ? (
                      <div className="flex items-center gap-2 text-yellow-500 text-sm font-display font-bold uppercase tracking-wider">
                        <Crown className="w-4 h-4" /> Captcha skipped (Legendary)
                      </div>
                    ) : (
                      <div className="overflow-hidden rounded-sm border-2 border-border">
                        <HCaptcha
                          sitekey={HCAPTCHA_SITE_KEY}
                          onVerify={setCaptchaToken}
                        />
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

      </div>
    </Layout>
  );
}
