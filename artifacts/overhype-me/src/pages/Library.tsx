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
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Bell, ChevronLeft, ChevronRight, CheckCircle, Clock,
  FileText, ImageIcon, Images, Plus, ThumbsUp,
} from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

type LibraryTab = "liked" | "submitted" | "history" | "images" | "memes" | "activity";

interface UploadItem {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
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

  const [activeTab, setActiveTab] = useState<LibraryTab>("liked");
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

  const { data: uploadsData, isLoading: isUploadsLoading, isError: isUploadsError } = useQuery<{ uploads: UploadItem[] }>({
    queryKey: ["my-uploads"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/uploads`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch uploads");
      return res.json() as Promise<{ uploads: UploadItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "images",
    staleTime: 30_000,
  });

  const { data: aiImagesData, isLoading: isAiImagesLoading } = useQuery<{ images: AiImageItem[] }>({
    queryKey: ["my-ai-images"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/ai-images?imageType=reference`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch AI images");
      return res.json() as Promise<{ images: AiImageItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "images",
    staleTime: 30_000,
  });

  const { data: myMemesData, isLoading: isMyMemesLoading } = useQuery<{ memes: MyMemeItem[] }>({
    queryKey: ["profile-my-memes"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/memes`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch memes");
      return res.json() as Promise<{ memes: MyMemeItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "memes",
    staleTime: 30_000,
  });

  async function deleteMeme(slug: string) {
    const res = await fetch(`${BASE_URL}api/memes/${slug}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) throw new Error("Failed to delete meme");
    await queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
  }

  async function deleteUpload(objectPath: string) {
    const encodedPath = encodeURIComponent(objectPath);
    const res = await fetch(`${BASE_URL}api/users/me/uploads?path=${encodedPath}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? "Delete failed");
    }
    await queryClient.invalidateQueries({ queryKey: ["my-uploads"] });
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLocation("/submit")}
            className="gap-2 whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" /> SUBMIT A FACT
          </Button>
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
              label={`Submissions (${profile.submittedFacts.length + (profile.pendingSubmissions?.length ?? 0) + (profile.myComments?.length ?? 0)})`} />
            <TabButton active={activeTab === "memes"} onClick={() => setActiveTab("memes")}
              icon={<ImageIcon className="w-5 h-5" />} label="My Memes" />
            <TabButton active={activeTab === "images"} onClick={() => setActiveTab("images")}
              icon={<Images className="w-5 h-5" />} label="My Images" />
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

          {activeTab === "submitted" && (
            <div className="space-y-8">
              {(profile.pendingSubmissions?.length ?? 0) > 0 && (
                <div>
                  <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Under Review
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {profile.pendingSubmissions!.map((sub) => (
                      <div key={sub.id} className={`bg-card border-2 rounded-sm p-4 space-y-2 ${sub.status === "rejected" ? "border-destructive/40" : "border-border"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
                            sub.status === "pending"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/40"
                              : sub.status === "rejected"
                              ? "bg-destructive/10 text-destructive border-destructive/40"
                              : "bg-green-500/10 text-green-400 border-green-500/40"
                          }`}>
                            {sub.status === "pending" ? "Pending Review" : sub.status === "rejected" ? "Declined" : sub.status}
                          </span>
                          <span className="text-xs text-muted-foreground">{new Date(sub.createdAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-foreground text-sm leading-relaxed">{sub.text}</p>
                        {sub.hashtags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {sub.hashtags.map((tag: string) => (
                              <span key={tag} className="text-[10px] text-primary/70 font-bold uppercase tracking-wider">#{tag}</span>
                            ))}
                          </div>
                        )}
                        {sub.status === "rejected" && sub.reason && (
                          <p className="text-xs text-muted-foreground border-t border-border/50 pt-2 mt-2">
                            <span className="font-bold text-destructive/80">Reason:</span> {sub.reason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {profile.submittedFacts.length > 0 && (
                <div>
                  {(profile.pendingSubmissions?.length ?? 0) > 0 && (
                    <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-500" /> Approved &amp; Live
                    </h3>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {profile.submittedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
                  </div>
                </div>
              )}

              {(profile.myComments?.length ?? 0) > 0 && (
                <div>
                  <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                    <FileText className="w-4 h-4" /> Your Comments
                  </h3>
                  <div className="space-y-3">
                    {profile.myComments!.map((comment) => (
                      <div key={comment.id} className="bg-card border border-border rounded-sm p-4 space-y-2">
                        {comment.factText && (
                          <p className="text-xs text-muted-foreground italic border-l-2 border-primary/40 pl-2 leading-relaxed line-clamp-2">
                            {comment.factText}
                          </p>
                        )}
                        <p className="text-sm text-foreground leading-relaxed">{comment.text}</p>
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
                            comment.status === "pending"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/40"
                              : comment.status === "approved"
                              ? "bg-green-500/10 text-green-400 border-green-500/40"
                              : "bg-destructive/10 text-destructive border-destructive/40"
                          }`}>
                            {comment.status === "pending" ? "Awaiting Approval" : comment.status === "approved" ? "Visible" : comment.status}
                          </span>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleDateString()}</span>
                            <Link href={`/facts/${comment.factId}`} className="text-xs text-primary hover:underline">View Fact →</Link>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {profile.submittedFacts.length === 0 && (profile.pendingSubmissions?.length ?? 0) === 0 && (profile.myComments?.length ?? 0) === 0 && (
                <div className="text-center py-12 bg-card border-2 border-dashed border-border rounded-sm">
                  <p className="text-muted-foreground text-lg mb-4">You haven't submitted any facts yet.</p>
                  <Link href="/submit"><Button>SUBMIT FACT</Button></Link>
                </div>
              )}
            </div>
          )}

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
              <p className="text-sm text-muted-foreground mb-6">Images you've uploaded for meme creation. Click an image to copy its link for reuse in the meme builder.</p>
              {isUploadsError ? (
                <div className="text-center py-12 bg-card border-2 border-destructive/30 rounded-sm">
                  <AlertTriangle className="w-10 h-10 text-destructive/60 mx-auto mb-3" />
                  <p className="text-muted-foreground font-medium">Could not load your images. Please try again later.</p>
                </div>
              ) : isUploadsLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : uploadsData && uploadsData.uploads.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {uploadsData.uploads.map((upload) => {
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
                        onDelete={() => deleteUpload(upload.objectPath)}
                        deleteConfirmMessage="Permanently delete this uploaded image? This cannot be undone."
                        permalink={permalink}
                        imageOverlay={upload.isLowRes ? (
                          <div className="absolute top-1 left-1 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-sm z-10">
                            LOW RES
                          </div>
                        ) : undefined}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(upload.objectPath)} fileSizeBytes={upload.fileSizeBytes} mimeType={getMimeTypeFromUrl(upload.objectPath)} width={upload.width} height={upload.height} />}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
                  <Images className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground text-lg font-medium mb-2">No images uploaded yet.</p>
                  <p className="text-muted-foreground text-sm mb-6">Upload a custom photo in the meme builder and it will appear here for easy reuse.</p>
                  <Link href="/"><Button variant="outline">GO TO MEME BUILDER</Button></Link>
                </div>
              )}

              {(isAiImagesLoading || (aiImagesData && aiImagesData.images.length > 0)) && (
                <div className="mt-10">
                  <h3 className="text-lg font-display uppercase tracking-wider text-foreground mb-1">AI Reference Backgrounds</h3>
                  <p className="text-sm text-muted-foreground mb-6">Images generated from your reference photos in the meme builder.</p>
                  {isAiImagesLoading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {aiImagesData!.images.map((img) => {
                        const imgUrl = `${BASE_URL}api/memes/ai-user/image?storagePath=${encodeURIComponent(img.storagePath)}`;
                        return (
                          <ImageCard
                            key={img.id}
                            src={imgUrl}
                            alt="AI reference background"
                            isAuthProtected
                            aspectRatio="aspect-square"
                            actions={["openFull"]}
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
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "memes" && (
            <div>
              <p className="text-sm text-muted-foreground mb-6">Memes you've created.</p>
              {isMyMemesLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-video bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : myMemesData && myMemesData.memes.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {myMemesData.memes.map(meme => {
                    const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                    return (
                      <div key={meme.id} className="space-y-1.5">
                        <ImageCard
                          src={meme.imageUrl}
                          alt="Meme"
                          href={`/meme/${meme.permalinkSlug}`}
                          aspectRatio="aspect-video"
                          actions={["delete", "copyLink", "openFull"]}
                          onDelete={() => deleteMeme(meme.permalinkSlug)}
                          deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                          permalink={memePermalink}
                          footer={<AdminMediaInfo fileName={getFileNameFromUrl(meme.imageUrl)} fileSizeBytes={meme.uploadFileSizeBytes} mimeType={getMimeTypeFromUrl(meme.imageUrl)} width={meme.originalWidth} height={meme.originalHeight} />}
                        />
                        <div className="px-1">
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
        </div>
      </div>
    </Layout>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${
        active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {icon} {label}
    </button>
  );
}
