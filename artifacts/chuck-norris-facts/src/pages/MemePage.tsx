import { useRoute, Link } from "wouter";
import { useGetMemeBySlug, useGetFact, getGetMemeBySlugQueryKey, getGetFactQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Share2, AlertCircle, ArrowLeft, Download } from "lucide-react";

export default function MemePage() {
  const [, params] = useRoute("/meme/:slug");
  const slug = params?.slug ?? "";

  const { data: meme, isLoading, error } = useGetMemeBySlug(slug, {
    query: { queryKey: getGetMemeBySlugQueryKey(slug), enabled: !!slug }
  });

  const factId = meme?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId }
  });

  const handleDownload = () => {
    if (!meme?.imageUrl) return;
    fetch(meme.imageUrl)
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `chuck-norris-${slug}.png`;
        a.click();
      })
      .catch(console.error);
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: "Chuck Norris Fact Meme",
        text: meme?.factText ?? "Check out this Chuck Norris fact!",
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => alert("Link copied!"));
    }
  };

  const handleTwitterShare = () => {
    const text = encodeURIComponent(`"${(meme?.factText ?? "").slice(0, 200)}" — Chuck Norris Facts`);
    const url = encodeURIComponent(window.location.href);
    window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
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
            Chuck Norris Meme
          </h1>

          <img
            src={meme.imageUrl}
            alt="Chuck Norris fact meme"
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
