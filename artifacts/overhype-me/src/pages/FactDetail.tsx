import { useState, useEffect, useRef, Suspense } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useGetFact, useListRelatedFacts, getGetFactQueryKey, getListRelatedFactsQueryKey } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { FactComments } from "@/components/facts/FactComments";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { AdSlot } from "@/components/AdSlot";

import { AlertCircle, Flame } from "lucide-react";
import { ImageCard } from "@/components/ui/ImageCard";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { useAskBefore, useIdentityGate } from "@/hooks/use-identity-gate";

import { lazyWithRetry } from "@/lib/lazy-retry";
import { AdminMediaInfo, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";
import { roleToIdentity } from "@/components/meme-builder/integration/studioAdapter";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { CACHED_COPY_NOTICE } from "@/lib/cachedCopyNotice";

const MemeBuilderWizard = lazyWithRetry(() =>
  import("@/components/meme-builder/wizard").then(m => ({ default: m.MemeBuilderWizard })),
);

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

type MemeSort = "top" | "new";

async function fetchMemes(factId: number, visibility: "community" | "my-public" | "my-private", sort: MemeSort): Promise<{ memes: MemeItem[] }> {
  const res = await fetch(`/api/facts/${factId}/memes?visibility=${visibility}&sort=${sort}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch memes");
  return res.json() as Promise<{ memes: MemeItem[] }>;
}

export default function FactDetail() {
  const [, params] = useRoute("/facts/:id/:sub?");
  const factId = parseInt(params?.id || "0", 10);
  const isMemeRoute = params?.sub === "meme";
  const [, setLocation] = useLocation();
  const { isAuthenticated, user, role, entitlements } = useAuth();

  const { data: fact, isLoading: factLoading, error: factError } = useGetFact(factId, {
    query: { queryKey: getGetFactQueryKey(factId), enabled: !!factId }
  });

  const [galleryTab, setGalleryTab] = useState<"community" | "mine">("community");
  const [memeSort, setMemeSort] = useState<MemeSort>("top");
  const [belowFoldMounted, setBelowFoldMounted] = useState(false);
  const queryClient = useQueryClient();

  const belowFoldSentinelRef = useRef<HTMLDivElement>(null);

  // A builder copies the identity once at mount, so a builder reached by its
  // route waits until the identity sheet has a complete identity (#719). The
  // fact itself waits too (identity-flow Phase 4): a visitor without a name
  // sees the identity sheet over the loading surface, never a fact read as
  // "__", and the page renders once the identity is ready.
  const { builderReady, builderSeed, contentReady } = useIdentityGate();

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
    // contentReady: the sentinel mounts only once the identity hold releases
    // (Phase 4), which may be after the fact has arrived.
  }, [fact, belowFoldMounted, contentReady]);

  const { data: relatedFactsData } = useListRelatedFacts(factId, { limit: 6 }, {
    query: { queryKey: getListRelatedFactsQueryKey(factId, { limit: 6 }), enabled: !!factId && belowFoldMounted }
  });

  const { data: communityMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "community", memeSort],
    queryFn: () => fetchMemes(factId, "community", memeSort),
    enabled: !!factId && belowFoldMounted,
  });

  const { data: myPublicMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-public", memeSort],
    queryFn: () => fetchMemes(factId, "my-public", memeSort),
    enabled: !!factId && isAuthenticated && belowFoldMounted,
  });

  const { data: myPrivateMemesData } = useQuery({
    queryKey: ["listFactMemes", factId, "my-private", memeSort],
    queryFn: () => fetchMemes(factId, "my-private", memeSort),
    enabled: !!factId && isAuthenticated && belowFoldMounted,
  });

  const communityMemes = communityMemesData?.memes ?? [];
  const myPublicMemes = myPublicMemesData?.memes ?? [];
  const myPrivateMemes = myPrivateMemesData?.memes ?? [];

  const { name, pronouns } = usePersonName();

  // Meme builder open state is derived from URL (/facts/:id/meme)
  // so that mobile browsers reloading the tab re-open the builder automatically.

  // In-page actions on this page ask for a missing identity first, then run
  // (identity-flow Phase 3); navigations need nothing, the next page asks.
  const askBefore = useAskBefore();
  const showMemeStudio = isMemeRoute && builderReady;
  const openMemeStudio = () => {
    setLocation(`/facts/${factId}/meme`);
  };
  const closeMemeStudio = () => {
    setLocation(`/facts/${factId}`);
    void queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
  };

  async function handleDeleteMeme(slug: string) {
    const res = await fetch(`/api/memes/${slug}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      // The server's own explanation (a read-only refusal says the site is paused) is what the toast shows.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Failed to delete meme");
    }
    await queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
    // The same meme is listed in your Library and now sits in Recently deleted.
    void queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
    void queryClient.invalidateQueries({ queryKey: ["my-recently-deleted"] });
  }


  if (factLoading || !contentReady) return <Layout><div className="flex h-[50vh] items-center justify-center"><div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div></Layout>;
  if (factError || !fact) return <Layout><div className="max-w-2xl mx-auto mt-20 p-8 bg-destructive/10 border-2 border-destructive text-center"><AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4"/><h2 className="text-3xl font-display text-destructive uppercase">Classified Record Not Found</h2></div></Layout>;

  return (
    <Layout>
      {showMemeStudio && (
        <Suspense fallback={null}>
          <MemeBuilderWizard
              factId={String(factId)}
              factText={fact.text}
              viewerContext={{
                tier: roleToIdentity(role),
                entitlements,
                userId: user?.id,
                name: user?.displayName ?? undefined,
                pronouns: (user as { pronouns?: string } | undefined)?.pronouns ?? pronouns ?? undefined,
                hasLibraryImages: role !== "anonymous" && role !== "unregistered",
              }}
              entryFlow="fact-detail"
              initialName={builderSeed.name || undefined}
              initialPronouns={builderSeed.pronouns || undefined}
              onComplete={(result) => {
                if (result.kind === "saved" && result.permalinkUrl) {
                                void queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
                  setLocation(result.permalinkUrl);
                } else {
                  closeMemeStudio();
                }
              }}
              onCancel={closeMemeStudio}
            />
        </Suspense>
      )}
      <div className="max-w-4xl mx-auto px-4 py-12 md:py-20">

        {/* Main Fact Card — same FactCard primitive used in the feed and
            on TopFacts, with size="detail" for h1/larger padding/no Link wrap.
            Personalization edit + authorship byline live in the header chrome
            and PR description respectively, not on the card. */}
        <div className="mb-4">
          <FactCard
            fact={fact}
            size="detail"
            onCommentClick={() => {
              setBelowFoldMounted(true);
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  document.getElementById("comments")?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              });
            }}
          />
        </div>

        {/* PRIMARY CTA — Make a meme, full-width, prominent */}
        <div className="mb-4">
          <PausedWhenReadOnly>
          <Button
            variant="primary"
            size="lg"
            onClick={() => openMemeStudio()}
            className="w-full h-14 gap-3 shadow-[0_8px_20px_rgba(255,101,0,0.22)] tracking-widest"
          >
            <Flame className="w-5 h-5" />
            MAKE A MEME OF THIS
          </Button>
          </PausedWhenReadOnly>
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
              onClick={() => askBefore(() => setGalleryTab("community"))}
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
                onClick={() => askBefore(() => setGalleryTab("mine"))}
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

          {/* Top/Newest sort */}
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="text-muted-foreground font-display tracking-wider uppercase">Sort</span>
              <select
                value={memeSort}
                onChange={(e) => {
                  const next = e.target.value as MemeSort;
                  askBefore(() => setMemeSort(next));
                }}
                className="bg-secondary border border-border/80 rounded-full px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/50 transition-colors focus:outline-none focus:border-primary"
                aria-label="Sort memes"
              >
                <option value="top">Top</option>
                <option value="new">Newest</option>
              </select>
            </div>
          </div>

          {/* Meme image grid */}
          {(() => {
            const memes = galleryTab === "community"
              ? communityMemes
              : [...myPublicMemes, ...myPrivateMemes];

            return memes.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-start mb-6">
                {memes.map(meme => {
                  const isMyMeme = galleryTab === "mine" || (!!user?.id && meme.createdById === user.id);
                  const memePermalink = `${window.location.origin}/m/${meme.permalinkSlug}`;
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
                        href={`/m/${meme.permalinkSlug}`}
                        aspectRatio={MEME_ASPECT_CLASS[meme.aspectRatio ?? "landscape"] ?? "aspect-video"}
                        actions={isMyMeme ? ["delete", "copyLink", "openFull"] : ["copyLink", "openFull"]}
                        onDelete={isMyMeme ? () => handleDeleteMeme(meme.permalinkSlug) : undefined}
                        deleteConfirmMessage={`Delete this meme? It leaves Overhype.me now and moves to Recently deleted in your Library, where you can restore it. ${CACHED_COPY_NOTICE}`}
                        permalink={memePermalink}
                        askBefore={askBefore}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(meme.imageUrl)} fileSizeBytes={meme.uploadFileSizeBytes} mimeType={getMimeTypeFromUrl(meme.imageUrl)} width={meme.originalWidth} height={meme.originalHeight} />}
                      />
                      <div className="w-full flex items-center px-1 py-1">
                        <MemeHeartButton
                          memeId={meme.id}
                          initialHeartCount={meme.heartCount}
                          initialViewerHasHearted={meme.viewerHasHearted}
                          stopPropagation
                          size="sm"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : galleryTab === "mine" ? (
              <div className="mb-6 p-8 md:p-10 text-center bg-gradient-to-br from-primary/15 via-primary/5 to-transparent border-2 border-primary/40 rounded-2xl">
                <h4 className="text-xl md:text-2xl font-display font-bold uppercase tracking-tight text-foreground mb-2">
                  You haven't made one yet
                </h4>
                <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
                  Make this fact yours.
                </p>
                <PausedWhenReadOnly>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => openMemeStudio()}
                  className="gap-3 tracking-widest shadow-[0_8px_20px_rgba(255,101,0,0.22)]"
                >
                  <Flame className="w-5 h-5" />
                  MAKE A MEME OF THIS
                </Button>
                </PausedWhenReadOnly>
              </div>
            ) : (
              <div className="py-12 text-center border-2 border-dashed border-border rounded-2xl mb-6">
                <p className="text-muted-foreground">
                  No community memes yet. Be the first!
                </p>
              </div>
            );
          })()}

          {/* Visibility hint — only shown in Mine tab when there's content. New memes
              are public by default (the site is for sharing); making one private
              is a Legendary perk (David, Q15, 2026-11-23; inventory F21). */}
          {galleryTab === "mine" && isAuthenticated && (myPublicMemes.length + myPrivateMemes.length) > 0 && (
            <div className="flex gap-3 items-start p-4 bg-secondary rounded-2xl border border-border mt-2">
              <span className="text-base leading-none pt-0.5">🔒</span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your memes are <strong className="text-foreground">public by default</strong>, so others can find them. Legendary members can make a meme private from its page.
              </p>
            </div>
          )}
        </div>

        {/* PRIMARY CTA — repeated after the meme grid so deep-scroll visitors keep the affordance */}
        <div className="mb-12">
          <PausedWhenReadOnly>
          <Button
            variant="primary"
            size="lg"
            onClick={() => openMemeStudio()}
            className="w-full h-14 gap-3 shadow-[0_8px_20px_rgba(255,101,0,0.22)] tracking-widest"
          >
            <Flame className="w-5 h-5" />
            MAKE A MEME OF THIS
          </Button>
          </PausedWhenReadOnly>
        </div>

        {/* Comments — list first, composer at bottom (variant="detail") */}
        <FactComments fact={fact} variant="detail" />

        {/* Related facts — convert share-arrival traffic into session traffic */}
        {relatedFactsData?.facts && relatedFactsData.facts.length > 0 && (
          <div className="mt-16">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2 mb-8">
              More facts you'll like
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {relatedFactsData.facts.map((rf, i) => (
                <FactCard key={rf.id} fact={rf} index={i} />
              ))}
            </div>
          </div>
        )}

        </>)}

      </div>
    </Layout>
  );
}
