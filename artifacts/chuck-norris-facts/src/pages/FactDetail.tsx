import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { format } from "date-fns";
import HCaptcha from "@hcaptcha/react-hcaptcha";

import { useGetFact, useListComments, useListFactMemes, getGetFactQueryKey, getListCommentsQueryKey } from "@workspace/api-client-react";
import type { ExternalLink } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { MemeBuilder } from "@/components/MemeBuilder";
import { MerchButtons } from "@/components/MerchButtons";
import { AdSlot } from "@/components/AdSlot";
import { ThumbsUp, ThumbsDown, User, Link as LinkIcon, Youtube, Instagram, AlertCircle, Plus, Trash2, ImageIcon, GitBranch, Copy } from "lucide-react";
import { cn } from "@/components/ui/Button";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

export default function FactDetail() {
  const [, params] = useRoute("/facts/:id");
  const factId = parseInt(params?.id || "0", 10);
  const [, setLocation] = useLocation();
  const { isAuthenticated, user } = useAuth();
  const { rateFact, addComment, addLink, deleteLink } = useAppMutations();

  const { data: fact, isLoading: factLoading, error: factError } = useGetFact(factId, {
    query: { queryKey: getGetFactQueryKey(factId), enabled: !!factId }
  });
  
  const { data: commentsData } = useListComments(factId, { limit: 50 }, {
    query: { queryKey: getListCommentsQueryKey(factId, { limit: 50 }), enabled: !!factId }
  });

  const { data: memesData } = useListFactMemes(factId, {
    query: { queryKey: ["listFactMemes", factId], enabled: !!factId }
  });

  const [commentText, setCommentText] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [showAddLink, setShowAddLink] = useState(false);
  const [showMemeBuilder, setShowMemeBuilder] = useState(false);

  if (factLoading) return <Layout><div className="flex h-[50vh] items-center justify-center"><div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div></Layout>;
  if (factError || !fact) return <Layout><div className="max-w-2xl mx-auto mt-20 p-8 bg-destructive/10 border-2 border-destructive text-center"><AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4"/><h2 className="text-3xl font-display text-destructive uppercase">Classified Record Not Found</h2></div></Layout>;

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) return setLocation("/login");
    const newRating = fact.userRating === type ? "none" : type;
    rateFact.mutate({ factId, data: { rating: newRating } });
  };

  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) return setLocation("/login");
    if (!commentText.trim() || !captchaToken) return;

    addComment.mutate({ factId, data: { text: commentText, captchaToken } }, {
      onSuccess: () => {
        setCommentText("");
        setCaptchaToken("");
      }
    });
  };

  const handleAddLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) return setLocation("/login");
    if (!linkUrl.trim()) return;

    addLink.mutate({ factId, data: { url: linkUrl } }, {
      onSuccess: () => {
        setLinkUrl("");
        setShowAddLink(false);
      }
    });
  };

  return (
    <Layout>
      {showMemeBuilder && (
        <MemeBuilder
          factId={factId}
          factText={fact.text}
          onClose={() => setShowMemeBuilder(false)}
        />
      )}
      <div className="max-w-4xl mx-auto px-4 py-12 md:py-20">
        
        {/* Main Fact Card */}
        <div className="bg-card border-l-8 border-primary p-8 md:p-12 shadow-2xl relative mb-12">
          <div className="absolute top-4 right-4 text-muted-foreground/30 font-display text-8xl font-bold italic select-none pointer-events-none -mt-4">
            #{fact.rank ?? fact.id}
          </div>
          
          <h1 className="text-3xl md:text-5xl font-bold leading-tight text-foreground relative z-10 mb-8">
            "{fact.text}"
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
                variant="outline"
                size="lg"
                onClick={() => setShowMemeBuilder(true)}
                className="gap-2 h-14 border-dashed hover:border-primary hover:text-primary"
              >
                <ImageIcon className="w-5 h-5" />
                <span>MAKE MEME</span>
              </Button>
            </div>
            
            <div className="text-muted-foreground text-sm font-medium text-right">
              <div>VERIFIED: {format(new Date(fact.createdAt), 'MMM dd, yyyy')}</div>
              {fact.submittedBy && <div className="text-primary mt-1">BY AGENT {fact.submittedBy.substring(0,8).toUpperCase()}</div>}
            </div>
          </div>

          {/* Merch buttons */}
          <div className="mt-6 pt-4 border-t border-border/50">
            <MerchButtons sourceType="fact" sourceId={factId} text={fact.text} />
          </div>
        </div>

        {/* Ad slot below fact card — hidden for premium users */}
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_FACT_FOOTER ?? "1234567890"} format="horizontal" className="mb-8" />

        {/* Layout split for Links and Comments */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          
          {/* Comments Section */}
          <div className="lg:col-span-2 space-y-8">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2">Intel & Discussion ({fact.commentCount})</h3>
            
            {/* Comment Form */}
            {isAuthenticated ? (
              <form onSubmit={handleCommentSubmit} className="bg-secondary p-6 rounded-sm border-2 border-border space-y-4">
                <Textarea 
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  placeholder="Drop some knowledge..."
                  className="bg-background min-h-[100px]"
                />
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                  <div className="overflow-hidden rounded-sm border-2 border-border">
                    <HCaptcha
                      sitekey={HCAPTCHA_SITE_KEY}
                      onVerify={setCaptchaToken}
                    />
                  </div>
                  <Button type="submit" isLoading={addComment.isPending} disabled={!commentText || !captchaToken} className="w-full sm:w-auto">
                    POST INTEL
                  </Button>
                </div>
              </form>
            ) : (
              <div className="bg-secondary p-6 rounded-sm border-2 border-border text-center">
                <p className="text-muted-foreground font-medium mb-4">Authentication required to add intel.</p>
                <Button onClick={() => setLocation("/login")} variant="outline">LOGIN TO COMMENT</Button>
              </div>
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
                      <span className="font-bold text-primary">{comment.authorName || "UNKNOWN AGENT"}</span>
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

          {/* Links Section */}
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b-2 border-border pb-2">
              <h3 className="text-xl font-display uppercase tracking-wide">Source Links</h3>
              {isAuthenticated && !showAddLink && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" onClick={() => setShowAddLink(true)}>
                  <Plus className="w-5 h-5" />
                </Button>
              )}
            </div>

            {showAddLink && (
              <form onSubmit={handleAddLink} className="bg-secondary p-4 rounded-sm border-2 border-primary/50 space-y-3">
                <Input 
                  placeholder="https://youtube.com/..." 
                  value={linkUrl}
                  onChange={e => setLinkUrl(e.target.value)}
                  type="url"
                  required
                  className="bg-background text-sm h-10"
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" className="flex-1" isLoading={addLink.isPending}>SAVE</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowAddLink(false)}>CANCEL</Button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {fact.links?.map(link => {
                const isYoutube = link.url.includes("youtube.com") || link.url.includes("youtu.be");
                const isInsta = link.url.includes("instagram.com");
                return (
                  <div key={link.id} className="group relative bg-card border-2 border-border p-3 rounded-sm hover:border-primary/50 transition-colors flex items-center justify-between">
                    <a href={link.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 overflow-hidden">
                      <div className="shrink-0 w-8 h-8 bg-background flex items-center justify-center rounded-sm">
                        {isYoutube ? <Youtube className="w-4 h-4 text-red-500" /> : isInsta ? <Instagram className="w-4 h-4 text-pink-500" /> : <LinkIcon className="w-4 h-4 text-primary" />}
                      </div>
                      <span className="text-sm font-medium text-foreground truncate hover:underline underline-offset-4 decoration-primary">
                        {link.title || new URL(link.url).hostname.replace("www.", "")}
                      </span>
                    </a>
                    
                    {isAuthenticated && user?.id === (link as ExternalLink & { addedById?: string | null }).addedById && (
                      <button 
                        onClick={() => deleteLink.mutate({ factId, linkId: link.id })}
                        disabled={deleteLink.isPending}
                        className="opacity-0 group-hover:opacity-100 shrink-0 p-2 text-muted-foreground hover:text-destructive transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
              {fact.links?.length === 0 && (
                <p className="text-muted-foreground text-sm py-4 italic">No external sources documented.</p>
              )}
            </div>
          </div>

        </div>

        {/* Variants */}
        {fact.variants && fact.variants.length > 0 && (
          <div className="mt-12">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2 mb-6 flex items-center gap-3">
              <GitBranch className="w-6 h-6 text-primary" />
              Variants ({fact.variants.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fact.variants.map(v => (
                <div key={v.id} className="group bg-card border-2 border-border hover:border-primary/50 p-5 rounded-sm transition-colors relative">
                  {v.useCase && (
                    <span className="inline-block mb-3 text-xs font-bold font-display tracking-widest uppercase text-primary bg-primary/10 border border-primary/30 px-2 py-0.5 rounded-sm">
                      {v.useCase.replace(/_/g, " ")}
                    </span>
                  )}
                  <p className="text-foreground leading-relaxed text-base whitespace-pre-wrap">{v.text}</p>
                  <button
                    onClick={() => navigator.clipboard.writeText(v.text)}
                    className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-primary transition-all"
                    title="Copy variant text"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Meme Gallery */}
        {memesData && memesData.memes.length > 0 && (
          <div className="mt-12">
            <h3 className="text-2xl font-display uppercase tracking-wide border-b-2 border-border pb-2 mb-6 flex items-center gap-3">
              <ImageIcon className="w-6 h-6 text-primary" />
              Memes ({memesData.memes.length})
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {memesData.memes.map(meme => (
                <Link key={meme.id} href={`/meme/${meme.permalinkSlug}`}>
                  <div className="group border-2 border-border hover:border-primary/60 rounded-sm overflow-hidden transition-all cursor-pointer">
                    <img
                      src={meme.imageUrl}
                      alt="Meme"
                      className="w-full h-auto aspect-video object-cover group-hover:scale-105 transition-transform duration-300"
                      loading="lazy"
                    />
                    <div className="p-2 bg-card text-xs text-muted-foreground font-medium flex items-center justify-between">
                      <span className="uppercase tracking-wide">{meme.templateId}</span>
                      <span>{format(new Date(meme.createdAt), 'MMM dd')}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
