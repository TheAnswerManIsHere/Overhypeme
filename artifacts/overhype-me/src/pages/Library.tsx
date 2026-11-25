import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetMyProfile, getGetMyProfileQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { ImageCard } from "@/components/ui/ImageCard";
import { AdminMediaInfo, AdminMediaInfoForUrl, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";
import { AccessGate } from "@/components/AccessGate";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { SubmissionsPanel, submissionTotal, useSubmissionCounts } from "@/components/library/SubmissionsPanel";
import { Link, useLocation, useSearch } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Bell, ChevronLeft, ChevronRight, Clock,
  FileText, ImageIcon, Images, Lock, Plus, RotateCcw, ThumbsUp, Trash2,
} from "lucide-react";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { CACHED_COPY_NOTICE } from "@/lib/cachedCopyNotice";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

type LibraryTab = "liked" | "submitted" | "history" | "images" | "memes" | "deleted";

const LIBRARY_TABS: readonly LibraryTab[] = ["liked", "submitted", "history", "images", "memes", "deleted"];

/** The open tab is in the address (`?tab=`), so a link, a reload or Back returns to it. */
function tabFrom(search: string): LibraryTab {
  const tab = new URLSearchParams(search).get("tab");
  return (LIBRARY_TABS as readonly string[]).includes(tab ?? "") ? (tab as LibraryTab) : "liked";
}

interface UploadItem {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
  /** Your current profile photo, which can't be deleted (#875, R5). */
  isProfile?: boolean;
}

/** A member picture's state (`GET /api/member-pictures`). */
interface MemberPictureState {
  attemptId: number;
  factId: number;
  status: "queued" | "drawing" | "done" | "failed";
  reason: string | null;
  creditReturned: boolean;
  createdAt: string;
}

interface AiImageItem {
  id: number;
  factId: number;
  gender: string;
  storagePath: string;
  imageType: string;
  createdAt: string;
}

type DeletedItem =
  | { kind: "photo"; key: string; objectPath: string; deletedAt: string; purgeAfter: string }
  | { kind: "generated"; key: string; id: number; storagePath: string; deletedAt: string; purgeAfter: string }
  | { kind: "meme"; key: string; slug: string; deletedAt: string; purgeAfter: string };

interface RecentlyDeleted {
  items: DeletedItem[];
  truncated: boolean;
  restoreWindowDays: number;
}

/** Reads a failed response's `error` message, so a refusal reaches the person as the server gave it. */
async function failure(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/**
 * One cursor-paged list of the account's content (plan S18): each page
 * carries the next page's cursor, and `loadMore` fetches it.
 */
function usePagedList<T>(key: string, url: string, pick: (page: Record<string, unknown>) => T[], enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [key],
    queryFn: async ({ pageParam }) => {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(pageParam ? `${url}${sep}cursor=${encodeURIComponent(pageParam)}` : url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<Record<string, unknown> & { nextCursor?: string | null }>;
    },
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  });
  const items = query.data ? query.data.pages.flatMap(pick) : undefined;
  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => { void query.fetchNextPage(); },
  };
}

interface MyMemeItem {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  isPublic: boolean;
  createdAt: string;
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
  heartCount: number;
  viewerHasHearted: boolean;
}

export default function Library() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: profile, isLoading } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, retry: false },
  });

  const search = useSearch();
  const activeTab = tabFrom(search);
  // A tab change is a history entry, and starts the new tab's view afresh.
  const setActiveTab = (tab: LibraryTab) => {
    if (tab !== activeTab) setLocation(tab === "liked" ? "/library" : `/library?tab=${tab}`);
  };
  const submissionCounts = useSubmissionCounts("", isAuthenticated);
  const submissionCount = submissionTotal(submissionCounts.data);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });

  const updateTabScroll = () => {
    const el = tabsRef.current;
    if (!el) return;
    setTabScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };

  useEffect(() => {
    let raf2: number;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(updateTabScroll);
    });
    const timer = setTimeout(updateTabScroll, 200);
    const el = tabsRef.current;
    if (!el) return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(timer); };
    const ro = new ResizeObserver(updateTabScroll);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const uploads = usePagedList<UploadItem>(
    "my-uploads", `${BASE_URL}api/users/me/uploads`,
    (page) => page.uploads as UploadItem[], isAuthenticated && activeTab === "images",
  );
  // The member's own AI pictures (launch Phase 7, increment 2), and the ones still drawing.
  const memberPictures = usePagedList<AiImageItem>(
    "my-member-pictures", `${BASE_URL}api/users/me/ai-images?imageType=member_picture`,
    (page) => page.images as AiImageItem[], isAuthenticated && activeTab === "images",
  );
  const { data: drawingData } = useQuery<{ pictures: MemberPictureState[] }>({
    queryKey: ["my-member-pictures-drawing"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/member-pictures`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load your pictures");
      return res.json();
    },
    enabled: isAuthenticated && activeTab === "images",
    // While any picture draws, follow it; a finished one lands in the list below.
    refetchInterval: (q) => (q.state.data?.pictures.some((p) => p.status === "queued" || p.status === "drawing") ? 3000 : false),
  });
  const drawing = (drawingData?.pictures ?? []).filter((p) => p.status === "queued" || p.status === "drawing");
  const recentlyFailed = (drawingData?.pictures ?? []).filter((p) => p.status === "failed" && Date.now() - Date.parse(p.createdAt) < 24 * 60 * 60_000);
  const lastDone = drawingData?.pictures.filter((p) => p.status === "done").length ?? 0;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["my-member-pictures"] });
  }, [lastDone, queryClient]);
  const aiImages = usePagedList<AiImageItem>(
    "my-ai-images", `${BASE_URL}api/users/me/ai-images?imageType=reference`,
    (page) => page.images as AiImageItem[], isAuthenticated && activeTab === "images",
  );
  const myMemes = usePagedList<MyMemeItem>(
    "profile-my-memes", `${BASE_URL}api/users/me/memes`,
    (page) => page.memes as MyMemeItem[], isAuthenticated && activeTab === "memes",
  );

  // Read on every visit: its count labels the tab, and its window is what the
  // delete confirmations promise.
  const { data: deletedData, isLoading: isDeletedLoading } = useQuery<RecentlyDeleted>({
    queryKey: ["my-recently-deleted"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/recently-deleted`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Recently deleted");
      return res.json() as Promise<RecentlyDeleted>;
    },
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
  // The server's window; until it has answered, the default it ships with.
  const windowDays = deletedData?.restoreWindowDays ?? 30;

  /** Runs a delete or restore, then refreshes the lists it changed. */
  async function change(url: string, method: "DELETE" | "POST", lists: string[], body?: unknown) {
    const res = await fetch(url, {
      method,
      credentials: "include",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw await failure(res, method === "DELETE" || url.endsWith("/purge") ? "Delete failed" : "Restore failed");
    await Promise.all([...lists, "my-recently-deleted"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }

  const deleteMeme = (slug: string) =>
    change(`${BASE_URL}api/memes/${encodeURIComponent(slug)}`, "DELETE", ["profile-my-memes"]);
  const deleteUpload = (objectPath: string) =>
    change(`${BASE_URL}api/users/me/uploads?path=${encodeURIComponent(objectPath)}`, "DELETE", ["my-uploads"]);
  const deleteAiImage = (id: number) =>
    change(`${BASE_URL}api/users/me/ai-images/${id}`, "DELETE", ["my-ai-images", "my-member-pictures"]);

  /** "Delete now": ends the item's restore window; the purger removes it within the hour. */
  const purgeNow = (item: DeletedItem) =>
    change(`${BASE_URL}api/users/me/recently-deleted/purge`, "POST", [], { kind: item.kind, key: item.key });

  function restore(item: DeletedItem) {
    switch (item.kind) {
      case "photo":
        return change(`${BASE_URL}api/users/me/uploads/restore`, "POST", ["my-uploads"], { path: item.objectPath });
      case "generated":
        return change(`${BASE_URL}api/users/me/ai-images/${item.id}/restore`, "POST", ["my-ai-images", "my-member-pictures"]);
      case "meme":
        return change(`${BASE_URL}api/memes/${encodeURIComponent(item.slug)}/restore`, "POST", ["profile-my-memes"]);
    }
  }

  if (authLoading || (isAuthenticated && isLoading)) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto px-4 py-12">
          <p className="text-muted-foreground">Loading…</p>
        </div>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return (
      <Layout>
        <AccessGate
          variant="page"
          reason="login"
          description="Sign in to see your liked facts, memes, uploads, and history."
        />
      </Layout>
    );
  }

  if (!profile) return null;

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-4 py-6 md:py-10">
        <div className="mb-6 md:mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display font-bold text-3xl md:text-5xl uppercase tracking-tight leading-none">
              Your <span className="text-primary">Library</span>
            </h1>
            <p className="text-sm md:text-base text-muted-foreground mt-2">
              Everything you've made, liked, and saved.
            </p>
          </div>
          {/* Persistent submit entry point — Submit a Fact is no longer in
              chrome, so the Library page (the natural home for "stuff I've
              made") owns it. Stays visible across all tabs. */}
          <PausedWhenReadOnly className="shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLocation("/submit")}
            className="gap-2 whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" /> SUBMIT A FACT
          </Button>
          </PausedWhenReadOnly>
        </div>

        <div className="relative mb-8">
          {tabScroll.left && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-16 z-10 flex items-center justify-start"
              style={{ background: "linear-gradient(to right, hsl(var(--background)) 30%, transparent)" }}>
              <ChevronLeft className="w-6 h-6 text-foreground/60 ml-1 flex-shrink-0" />
            </div>
          )}
          {tabScroll.right && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-16 z-10 flex items-center justify-end"
              style={{ background: "linear-gradient(to left, hsl(var(--background)) 30%, transparent)" }}>
              <ChevronRight className="w-6 h-6 text-foreground/60 mr-1 flex-shrink-0" />
            </div>
          )}
          <div
            ref={tabsRef}
            onScroll={updateTabScroll}
            className="flex overflow-x-auto gap-2 border-b-2 border-border no-scrollbar"
          >
            <TabButton active={activeTab === "liked"} onClick={() => setActiveTab("liked")}
              icon={<ThumbsUp className="w-5 h-5" />} label={`Liked Facts (${profile.likedFacts.length})`} />
            <TabButton active={activeTab === "submitted"} onClick={() => setActiveTab("submitted")}
              icon={<FileText className="w-5 h-5" />}
              label={submissionCount === null ? "Submissions" : `Submissions (${submissionCount})`} />
            <TabButton active={activeTab === "memes"} onClick={() => setActiveTab("memes")}
              icon={<ImageIcon className="w-5 h-5" />} label="My Memes" />
            <TabButton active={activeTab === "images"} onClick={() => setActiveTab("images")}
              icon={<Images className="w-5 h-5" />} label="My Images" />
            <TabButton active={activeTab === "deleted"} onClick={() => setActiveTab("deleted")}
              icon={<Trash2 className="w-5 h-5" />}
              label={deletedData && deletedData.items.length > 0 ? `Recently Deleted (${deletedData.items.length}${deletedData.truncated ? "+" : ""})` : "Recently Deleted"} />
            <TabButton active={activeTab === "history"} onClick={() => setActiveTab("history")}
              icon={<Clock className="w-5 h-5" />} label="Search History" />
            <TabButton active={false} onClick={() => setLocation("/activity")}
              icon={<Bell className="w-5 h-5" />} label="Activity" />
          </div>
        </div>

        <div className="min-h-[400px]">
          {activeTab === "liked" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {profile.likedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
              {profile.likedFacts.length === 0 && <p className="col-span-full text-center text-muted-foreground py-12">No liked facts. You have high standards.</p>}
            </div>
          )}

          {activeTab === "submitted" && <SubmissionsPanel />}

          {activeTab === "history" && (
            <div className="bg-card border-2 border-border rounded-sm p-6 max-w-2xl">
              <h3 className="font-display text-xl uppercase mb-6 text-foreground border-b border-border pb-4">Recent Queries</h3>
              <div className="space-y-2">
                {profile.searchHistory.map((query, i) => (
                  <Link key={i} href={`/search?q=${encodeURIComponent(query)}`} className="block px-4 py-3 bg-secondary hover:bg-primary/20 hover:text-primary transition-colors font-medium rounded-sm border border-transparent hover:border-primary/30">
                    "{query}"
                  </Link>
                ))}
                {profile.searchHistory.length === 0 && <p className="text-muted-foreground italic">Memory wiped. No history found.</p>}
              </div>
            </div>
          )}

          {activeTab === "images" && (
            <div>
              <p className="text-sm text-muted-foreground mb-6">Images you've uploaded for meme creation. Click an image to open it full size. The one marked Profile is your picture and can't be deleted; choose another on your Profile to change it.</p>
              {uploads.isError ? (
                <div className="text-center py-12 bg-card border-2 border-destructive/30 rounded-sm">
                  <AlertTriangle className="w-10 h-10 text-destructive/60 mx-auto mb-3" />
                  <p className="text-muted-foreground font-medium">Could not load your images. Please try again later.</p>
                </div>
              ) : uploads.isLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : uploads.items && uploads.items.length > 0 ? (
                <>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {uploads.items.map((upload) => {
                    const imgUrl = `${BASE_URL}api/storage${upload.objectPath}`;
                    const permalink = `${window.location.origin}${BASE_URL}api/storage${upload.objectPath}`;
                    return (
                      <ImageCard
                        key={upload.objectPath}
                        src={imgUrl}
                        alt="Uploaded image"
                        isAuthProtected
                        aspectRatio="aspect-square"
                        actions={["delete", "copyLink", "openFull"]}
                        onDelete={upload.isProfile ? undefined : () => deleteUpload(upload.objectPath)}
                        deleteConfirmMessage={`Delete this photo? It moves to Recently deleted, where you can restore it for ${windowDays} days. Memes you made with it stay as they are.`}
                        permalink={permalink}
                        imageOverlay={upload.isProfile || upload.isLowRes ? (
                          <div className="absolute top-1 left-1 flex gap-1 z-10">
                            {upload.isProfile && (
                              <span data-testid="library-profile-badge" className="bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-sm">
                                PROFILE
                              </span>
                            )}
                            {upload.isLowRes && (
                              <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-sm">
                                LOW RES
                              </span>
                            )}
                          </div>
                        ) : undefined}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(upload.objectPath)} fileSizeBytes={upload.fileSizeBytes} mimeType={getMimeTypeFromUrl(upload.objectPath)} width={upload.width} height={upload.height} />}
                      />
                    );
                  })}
                </div>
                <LoadMore list={uploads} />
                </>
              ) : (
                <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
                  <Images className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground text-lg font-medium mb-2">No images uploaded yet.</p>
                  <p className="text-muted-foreground text-sm mb-6">Upload a custom photo in the meme builder and it will appear here for easy reuse.</p>
                  <Link href="/"><Button variant="outline">GO TO MEME BUILDER</Button></Link>
                </div>
              )}

              {(drawing.length > 0 || recentlyFailed.length > 0 || memberPictures.isLoading || (memberPictures.items && memberPictures.items.length > 0)) && (
                <div className="mt-10" data-testid="my-ai-pictures">
                  <h3 className="text-lg font-display uppercase tracking-wider text-foreground mb-1">Your AI Pictures</h3>
                  <p className="text-sm text-muted-foreground mb-6">Pictures drawn from your photos. Use one as a meme background from that fact's meme builder.</p>
                  {(drawing.length > 0 || recentlyFailed.length > 0) && (
                    <ul className="mb-6 space-y-2" aria-live="polite">
                      {drawing.map((p) => (
                        <li key={p.attemptId} className="rounded-sm border-2 border-border bg-card px-3 py-2 text-sm">
                          {p.status === "queued" ? "Waiting to start drawing…" : "Drawing…"}{" "}
                          <Link href={`/facts/${p.factId}`} className="underline text-muted-foreground">this fact</Link>
                        </li>
                      ))}
                      {recentlyFailed.map((p) => (
                        <li key={p.attemptId} className="rounded-sm border-2 border-border bg-card px-3 py-2 text-sm">
                          {p.reason} {p.creditReturned ? "Your credit was returned." : "Your credit will be returned shortly."}
                        </li>
                      ))}
                    </ul>
                  )}
                  {memberPictures.isLoading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="aspect-[3/4] bg-card border-2 border-border rounded-sm animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {memberPictures.items!.map((img) => {
                        const imgUrl = `${BASE_URL}api/memes/ai-user/image?storagePath=${encodeURIComponent(img.storagePath)}`;
                        return (
                          <ImageCard
                            key={img.id}
                            src={imgUrl}
                            alt="Your AI picture"
                            isAuthProtected
                            aspectRatio="aspect-[3/4]"
                            actions={["delete", "openFull"]}
                            onDelete={() => deleteAiImage(img.id)}
                            deleteConfirmMessage={`Delete this picture? It moves to Recently deleted, where you can restore it for ${windowDays} days. Its credit is not returned.`}
                            footer={<AdminMediaInfoForUrl url={imgUrl} fileName={getFileNameFromUrl(img.storagePath)} mimeType={getMimeTypeFromUrl(img.storagePath)} />}
                          />
                        );
                      })}
                    </div>
                    <LoadMore list={memberPictures} />
                    </>
                  )}
                </div>
              )}

              {(aiImages.isLoading || (aiImages.items && aiImages.items.length > 0)) && (
                <div className="mt-10">
                  <h3 className="text-lg font-display uppercase tracking-wider text-foreground mb-1">AI Reference Backgrounds</h3>
                  <p className="text-sm text-muted-foreground mb-6">Backgrounds generated from your reference photos before AI styling was retired. They stay here for you to view.</p>
                  {aiImages.isLoading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {aiImages.items!.map((img) => {
                        const imgUrl = `${BASE_URL}api/memes/ai-user/image?storagePath=${encodeURIComponent(img.storagePath)}`;
                        return (
                          <ImageCard
                            key={img.id}
                            src={imgUrl}
                            alt="AI reference background"
                            isAuthProtected
                            aspectRatio="aspect-square"
                            actions={["delete", "openFull"]}
                            onDelete={() => deleteAiImage(img.id)}
                            deleteConfirmMessage={`Delete this image? It moves to Recently deleted, where you can restore it for ${windowDays} days.`}
                            imageOverlay={
                              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5 z-10">
                                <span className="text-[10px] text-white/70 uppercase tracking-wider">{img.gender}</span>
                              </div>
                            }
                            footer={<AdminMediaInfoForUrl url={imgUrl} fileName={getFileNameFromUrl(img.storagePath)} mimeType={getMimeTypeFromUrl(img.storagePath)} />}
                          />
                        );
                      })}
                    </div>
                    <LoadMore list={aiImages} />
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "memes" && (
            <div>
              <p className="text-sm text-muted-foreground mb-6">Memes you've created.</p>
              {myMemes.isLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-video bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : myMemes.items && myMemes.items.length > 0 ? (
                <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {myMemes.items.map(meme => {
                    const memePermalink = `${window.location.origin}/m/${meme.permalinkSlug}`;
                    return (
                      <div key={meme.id} className="space-y-1.5">
                        <ImageCard
                          src={meme.imageUrl}
                          alt="Meme"
                          href={`/m/${meme.permalinkSlug}`}
                          aspectRatio="aspect-video"
                          actions={["delete", "copyLink", "openFull"]}
                          onDelete={() => deleteMeme(meme.permalinkSlug)}
                          deleteConfirmMessage={`Delete this meme? It leaves Overhype.me now and moves to Recently deleted, where you can restore it for ${windowDays} days. ${CACHED_COPY_NOTICE}`}
                          permalink={memePermalink}
                           imageOverlay={!meme.isPublic ? (
                             <div
                               className="absolute top-2 left-2 z-10 inline-flex items-center justify-center rounded-sm bg-black/70 p-1.5 text-white shadow-sm"
                               title="Private meme"
                               aria-label="Private meme"
                             >
                               <Lock className="w-4 h-4" aria-hidden="true" />
                               <span className="sr-only">Private meme</span>
                             </div>
                           ) : undefined}
                          footer={<AdminMediaInfo fileName={getFileNameFromUrl(meme.imageUrl)} fileSizeBytes={meme.uploadFileSizeBytes} mimeType={getMimeTypeFromUrl(meme.imageUrl)} width={meme.originalWidth} height={meme.originalHeight} />}
                        />
                        <div className="px-1 flex items-center justify-between gap-2">
                          <MemeHeartButton
                            memeId={meme.id}
                            initialHeartCount={meme.heartCount}
                            initialViewerHasHearted={meme.viewerHasHearted}
                            stopPropagation
                            size="sm"
                          />
                          <span className="text-[11px] text-muted-foreground text-right" data-testid="library-meme-meta">
                            {formatMadeOn(meme.createdAt)} ·{" "}
                            <Link href={`/facts/${meme.factId}`} className="underline underline-offset-2 hover:text-foreground">Fact</Link>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <LoadMore list={myMemes} />
                </>
              ) : (
                <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
                  <ImageIcon className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground text-lg font-medium mb-2">No memes created yet.</p>
                  <p className="text-muted-foreground text-sm mb-6">Head to a fact page and build your first meme.</p>
                  <Link href="/"><Button variant="outline">BROWSE FACTS</Button></Link>
                </div>
              )}
            </div>
          )}

          {activeTab === "deleted" && (
            <RecentlyDeletedPanel data={deletedData} isLoading={isDeletedLoading} windowDays={windowDays} onRestore={restore} onPurge={purgeNow} />
          )}
        </div>
      </div>
    </Layout>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  // The open tab comes from the address, so it can be one scrolled out of
  // view on a phone; bring it into the row's view.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${
        active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {icon} {label}
    </button>
  );
}

/** The "Load more" control under a paged list, shown while the server has more. */
function LoadMore({ list }: { list: { hasMore: boolean; loadingMore: boolean; loadMore: () => void } }) {
  if (!list.hasMore) return null;
  return (
    <div className="flex justify-center mt-6">
      <Button variant="outline" onClick={list.loadMore} disabled={list.loadingMore}>
        {list.loadingMore ? "LOADING…" : "LOAD MORE"}
      </Button>
    </div>
  );
}

const KIND_LABEL: Record<DeletedItem["kind"], string> = { photo: "Photo", generated: "Generated image", meme: "Meme" };

/** Where a deleted item's picture is read from; its owner may still see it until it is removed. */
function deletedItemSrc(item: DeletedItem): string {
  switch (item.kind) {
    case "photo": return `${BASE_URL}api/storage${item.objectPath}`;
    case "generated": return `${BASE_URL}api/memes/ai-user/image?storagePath=${encodeURIComponent(item.storagePath)}`;
    case "meme": return `${BASE_URL}api/memes/${encodeURIComponent(item.slug)}/image`;
  }
}

/** A meme's creation date, short and in the reader's locale ("23 Nov 2026"). */
function formatMadeOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Whole days until the purge, at least one while it is still listed. */
function daysLeft(purgeAfter: string): number {
  return Math.max(1, Math.ceil((Date.parse(purgeAfter) - Date.now()) / 86_400_000));
}

/**
 * Recently deleted (launch Phase 5, plan S2/S18): everything the person
 * deleted that can still come back, with how long each has left. Restoring
 * puts it back where it was, as it was.
 */
function RecentlyDeletedPanel({ data, isLoading, windowDays, onRestore, onPurge }: {
  data: RecentlyDeleted | undefined;
  isLoading: boolean;
  windowDays: number;
  onRestore: (item: DeletedItem) => Promise<void>;
  onPurge: (item: DeletedItem) => Promise<void>;
}) {
  const { toast } = useToast();
  const [restoring, setRestoring] = useState<string | null>(null);
  /** The item whose "Delete now" is waiting for its confirmation, and the one being deleted. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);

  async function purgeItem(item: DeletedItem) {
    setPurging(`${item.kind}:${item.key}`);
    try {
      await onPurge(item);
      toast({ title: `${KIND_LABEL[item.kind]} deleted for good` });
    } catch (err) {
      toast({ variant: "destructive", title: "Delete failed", description: err instanceof Error ? err.message : undefined });
    } finally {
      setPurging(null);
      setConfirming(null);
    }
  }

  async function restoreItem(item: DeletedItem) {
    setRestoring(`${item.kind}:${item.key}`);
    try {
      await onRestore(item);
      toast({ title: `${KIND_LABEL[item.kind]} restored` });
    } catch (err) {
      toast({ variant: "destructive", title: "Restore failed", description: err instanceof Error ? err.message : undefined });
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-6">
        Photos, images and memes you deleted. Each stays here for {windowDays} days after you delete it,
        then it is removed from Overhype.me for good. Restore puts it back exactly as it was; Delete now
        removes it for good straight away. Click an image to open it full size.
      </p>
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {data.items.map((item) => {
              const id = `${item.kind}:${item.key}`;
              const left = daysLeft(item.purgeAfter);
              return (
                <div key={id} className="bg-card border-2 border-border rounded-sm overflow-hidden flex flex-col">
                  <a href={deletedItemSrc(item)} target="_blank" rel="noopener noreferrer"
                    className={`${item.kind === "meme" ? "aspect-video" : "aspect-square"} bg-secondary block`}
                    data-testid="deleted-item-open" title="Open full size">
                    <img src={deletedItemSrc(item)} alt={`Deleted ${KIND_LABEL[item.kind].toLowerCase()}`}
                      className="w-full h-full object-cover opacity-60" loading="lazy" />
                  </a>
                  <div className="p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-foreground">{KIND_LABEL[item.kind]}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {left} {left === 1 ? "day" : "days"} left
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground" data-testid="deleted-item-purge-date">
                      Removed for good on {new Date(item.purgeAfter).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                    <PausedWhenReadOnly>
                    <Button size="sm" variant="outline" className="gap-2" disabled={restoring === id || purging === id} onClick={() => void restoreItem(item)}>
                      <RotateCcw className="w-4 h-4" /> {restoring === id ? "RESTORING…" : "RESTORE"}
                    </Button>
                    {confirming === id ? (
                      <div className="flex flex-col gap-1" data-testid="deleted-item-confirm">
                        <p className="text-[11px] text-destructive">This can't be undone.</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="danger" className="flex-1" disabled={purging === id}
                            data-testid="deleted-item-confirm-delete" onClick={() => void purgeItem(item)}>
                            {purging === id ? "DELETING…" : "DELETE"}
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1" disabled={purging === id} onClick={() => setConfirming(null)}>
                            KEEP
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" className="gap-2 text-destructive" disabled={restoring === id}
                        data-testid="deleted-item-delete-now" onClick={() => setConfirming(id)}>
                        <Trash2 className="w-4 h-4" /> DELETE NOW
                      </Button>
                    )}
                    </PausedWhenReadOnly>
                  </div>
                </div>
              );
            })}
          </div>
          {data.truncated && (
            <p className="text-xs text-muted-foreground mt-4">Showing your most recent deletions; older ones are still restorable and appear here as these are restored or removed.</p>
          )}
        </>
      ) : (
        <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
          <Trash2 className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground text-lg font-medium">Nothing recently deleted.</p>
        </div>
      )}
    </div>
  );
}
