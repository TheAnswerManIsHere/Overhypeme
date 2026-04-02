import { useState, useCallback } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { format } from "date-fns";
import HCaptcha from "@hcaptcha/react-hcaptcha";

import { useGetFact, useListComments, useListFactMemes, getGetFactQueryKey, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { MemeBuilder } from "@/components/MemeBuilder";
import { MerchButtons } from "@/components/MerchButtons";
import { AdSlot } from "@/components/AdSlot";
import { ThumbsUp, ThumbsDown, User, Link as LinkIcon, Youtube, Instagram, AlertCircle, Trash2, ImageIcon, GitBranch, ArrowLeft, RefreshCw, Crown } from "lucide-react";
import { cn } from "@/components/ui/Button";
import { usePersonName } from "@/hooks/use-person-name";
import { renderFact } from "@/lib/render-fact";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

function VariantFactCard({ id, useCase }: { id: number; useCase: string | null }) {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { rateFact } = useAppMutations();
  const { name, pronouns } = usePersonName();
  const [showMemeBuilder, setShowMemeBuilder] = useState(false);

  const { data: fact, isLoading } = useGetFact(id, {
    query: { queryKey: getGetFactQueryKey(id), enabled: true }
  });

  const handleRate = (type: "up" | "down") => {
    if (!isAuthenticated) return setLocation("/login");
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
      {showMemeBuilder && (
        <MemeBuilder factId={id} factText={renderedText} onClose={() => setShowMemeBuilder(false)} />
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
          variant="outline"
          size="sm"
          onClick={() => setShowMemeBuilder(true)}
          className="gap-2 border-dashed hover:border-primary hover:text-primary"
        >
          <ImageIcon className="w-4 h-4" />
          MAKE MEME
        </Button>
        <Link href={`/facts/${id}`} className="ml-auto text-xs text-muted-foreground hover:text-primary transition-colors font-medium underline underline-offset-4">
          View discussion →
        </Link>
      </div>

      <div className="mt-4 pt-4 border-t border-border/50">
        <MerchButtons sourceType="fact" sourceId={id} text={renderedText} />
      </div>
    </div>
  );
}

// ── Pexels image helpers ──────────────────────────────────────────────────────

interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    number[];
  female:  number[];
  neutral: number[];
}

function pexelsVariant(pronouns: string): "male" | "female" | "neutral" {
  const subject = pronouns.split(/[/|]/)[0]?.toLowerCase() ?? "";
  if (subject === "he") return "male";
  if (subject === "she") return "female";
  return "neutral";
}

function pexelsUrl(photoId: number, width = 1260, height = 630): string {
  return `https://images.pexels.com/photos/${photoId}/pexels-photo-${photoId}.jpeg?auto=compress&cs=tinysrgb&w=${width}&h=${height}&fit=crop&dpr=1`;
}

const PREF_KEY = (factId: number) => `pref_img_${factId}`;
function loadStoredIndex(factId: number) {
  try { const n = parseInt(localStorage.getItem(PREF_KEY(factId)) ?? "", 10); return isNaN(n) ? 0 : n; } catch { return 0; }
}
function saveStoredIndex(factId: number, idx: number) {
  try { localStorage.setItem(PREF_KEY(factId), String(idx)); } catch { /* ignore */ }
}

// ── FactDetail ────────────────────────────────────────────────────────────────

export default function FactDetail() {
  const [, params] = useRoute("/facts/:id");
  const factId = parseInt(params?.id || "0", 10);
  const [, setLocation] = useLocation();
  const { isAuthenticated, user } = useAuth();
  const isPremium = user?.membershipTier === "premium";
  const { rateFact, addComment } = useAppMutations();

  const { data: fact, isLoading: factLoading, error: factError } = useGetFact(factId, {
    query: { queryKey: getGetFactQueryKey(factId), enabled: !!factId }
  });

  const { data: commentsData } = useListComments(factId, { limit: 50 }, {
    query: { queryKey: getListCommentsQueryKey(factId, { limit: 50 }), enabled: !!factId }
  });

  const { data: memesData } = useListFactMemes(factId, {
    query: { queryKey: ["listFactMemes", factId], enabled: !!factId }
  });

  const { name, pronouns } = usePersonName();
  const [commentText, setCommentText] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [showMemeBuilder, setShowMemeBuilder] = useState(false);
  const [commentSubmitted, setCommentSubmitted] = useState(false);

  // ── Pexels background image ────────────────────────────────────────────────
  const pexelsImages = ((fact as unknown as { pexelsImages?: FactPexelsImages | null })?.pexelsImages) ?? null;
  const imgVariant = pexelsVariant(pronouns);
  const photoIds = pexelsImages ? (pexelsImages[imgVariant] ?? []) : [];
  const [imgIndex, setImgIndex] = useState(() =>
    photoIds.length > 0 ? loadStoredIndex(factId) % photoIds.length : 0
  );
  const currentPhotoId = photoIds[imgIndex] ?? null;

  const handleRotateImage = useCallback(() => {
    if (!photoIds.length) return;
    const next = (imgIndex + 1) % photoIds.length;
    setImgIndex(next);
    saveStoredIndex(factId, next);
    // Persist to server for logged-in users (fire-and-forget)
    if (isAuthenticated) {
      fetch(`/api/facts/${factId}/image-preference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageIndex: next }),
      }).catch(() => { /* non-critical */ });
    }
  }, [imgIndex, photoIds, factId, isAuthenticated]);

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
      {showMemeBuilder && (
        <MemeBuilder
          factId={factId}
          factText={renderedText}
          onClose={() => setShowMemeBuilder(false)}
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
          {/* Pexels background image */}
          {currentPhotoId && (
            <div className="absolute inset-0 z-0" aria-hidden="true">
              <img
                src={pexelsUrl(currentPhotoId)}
                alt=""
                className="w-full h-full object-cover opacity-10 transition-opacity duration-500"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-card via-card/80 to-card/50" />
            </div>
          )}

          {/* Rotate button */}
          {photoIds.length > 1 && (
            <button
              onClick={handleRotateImage}
              title="Try another background image"
              className="absolute top-4 right-28 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm bg-black/30 text-white/40 hover:text-primary hover:bg-black/50 transition-all text-xs font-bold font-display tracking-wider uppercase"
            >
              <RefreshCw className="w-3 h-3" />
              <span className="hidden sm:inline">Photo</span>
            </button>
          )}

          <div className="absolute top-4 right-4 text-muted-foreground/30 font-display text-8xl font-bold italic select-none pointer-events-none -mt-4 z-10">
            #{fact.rank ?? fact.id}
          </div>

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
              {fact.submittedBy && <div className="text-primary mt-1">BY {fact.submittedBy.substring(0,8).toUpperCase()}</div>}
            </div>
          </div>

          {/* Merch buttons */}
          <div className="mt-6 pt-4 border-t border-border/50">
            <MerchButtons sourceType="fact" sourceId={factId} text={renderedText} />
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
                        <Crown className="w-4 h-4" /> Captcha skipped (Premium)
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
