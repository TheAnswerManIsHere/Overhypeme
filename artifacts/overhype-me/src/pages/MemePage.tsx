import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetFact, getGetFactQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { AlertCircle, Ban, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Link } from "wouter";
import {
  AdminMediaInfoForUrl,
  getFileNameFromUrl,
  getMimeTypeFromUrl,
  useImageDimensions,
} from "@/components/ui/AdminMediaInfo";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { resolveViewerCell } from "@/pages/memePage/useViewerCell";
import {
  CTABarAnonOther,
  CTABarAnonOwnTransient,
  CTABarLegendaryOther,
  CTABarLegendaryOwnPulid,
  CTABarLegendaryOwnStock,
  CTABarRegisteredOther,
  CTABarRegisteredOwn,
} from "@/pages/memePage/cta/CTABar";
import { BuilderOverlay } from "@/pages/memePage/BuilderOverlay";
import { MemeShareModal } from "@/components/share/MemeShareModal";
import type { EntryFlow, Mode } from "@/components/meme-builder/types";

interface StoredImageSource {
  type?: string;
  pexelsPhotoId?: number;
  templateId?: string;
}

interface MemeData {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  permalinkUrl: string;
  isPublic: boolean;
  factText: string;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
  heartCount: number;
  viewerHasHearted: boolean;
  isNsfw: boolean;
  imageTransform: string | null;
  imageSource: StoredImageSource | null;
  artifactType: "image" | "video";
  videoUrl: string | null;
}

type MemeResult =
  | { meme: MemeData; deleted: false }
  | { meme: null; deleted: true };

interface BuilderInvocation {
  mode: Mode;
  entryFlow: EntryFlow;
  initialStockImageId?: string;
  initialName?: string;
  initialPronouns?: string;
}

function DimsFromUrl({ url }: { url: string }) {
  const dims = useImageDimensions(url);
  if (!dims) return <>…</>;
  return <>{dims.width}×{dims.height}</>;
}

export default function MemePage() {
  const [, params] = useRoute("/m/:slug");
  const { user, role } = useAuth();
  const slug = params?.slug ?? "";
  // Task #507: open the builder in self-upload mode whenever the viewer has
  // ANY profile photo on file (first-party upload or external Clerk/OAuth
  // URL). The picker will surface library uploads only, so the first-party
  // case still gets a tappable thumbnail.
  const hasProfileImage = !!user?.profileImageUrl;

  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const justCreated = searchParams.get("just_created") === "1";

  const { data: memeResult, isLoading, error } = useQuery<MemeResult>({
    queryKey: ["meme-page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/memes/${slug}`, { credentials: "include" });
      if (res.status === 410) return { meme: null, deleted: true as const };
      if (!res.ok) throw new Error("Meme not found");
      const data = (await res.json()) as MemeData;
      return { meme: data, deleted: false as const };
    },
    enabled: !!slug,
    retry: false,
  });

  const meme = memeResult?.meme ?? null;
  const isDeleted = memeResult?.deleted === true;
  const factId = meme?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId },
  });

  const [builder, setBuilder] = useState<BuilderInvocation | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

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
        <div className="max-w-xl mx-auto mt-20 p-8 bg-card border border-border rounded-[20px] text-center">
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
        <div className="max-w-xl mx-auto mt-20 p-8 bg-destructive/10 border border-destructive rounded-[20px] text-center">
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

  const cell = resolveViewerCell({
    role,
    userId: user?.id ?? null,
    meme: { createdById: meme.createdById, imageTransform: meme.imageTransform },
    justCreated,
  });

  const wearHref = `/wear/${slug}?source=meme-page`;
  const initialStockImageId =
    meme.imageSource?.type === "stock" && typeof meme.imageSource.pexelsPhotoId === "number"
      ? String(meme.imageSource.pexelsPhotoId)
      : undefined;
  // The fact's tokenized template (e.g. `"{NAME} fought a bear"`) is what
  // the builder needs in order to substitute the new viewer's name. The
  // /api/memes/:slug payload only carries the rendered factText (creator's
  // name baked in), so we wait for the dedicated fact fetch to complete
  // before allowing any remix CTA to open the builder.
  const factTemplate = fact?.text ?? "";
  const factTemplateReady = !!fact?.text;

  // The Legendary upsell mentions the meme's actual creator by name to make
  // the value gap concrete — generic copy is measurably less effective.
  const legendaryUpsellSubject = meme.createdByName ?? "the creator";

  const handleDownload = () => {
    const isVideo = meme.artifactType === "video" && meme.videoUrl;
    const url = isVideo ? meme.videoUrl! : meme.imageUrl;
    const filename = isVideo ? `overhype-${slug}.mp4` : `overhype-${slug}.jpg`;
    if (!url) return;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
      })
      .catch(() => {
        // Browsers handle the download click gracefully; nothing useful to
        // surface to the user on a network blip.
      });
  };

  const handleCustomShare = () => {
    setShareOpen(true);
  };

  const openMakeAboutMe = () => {
    if (!factTemplateReady) return;
    const wantsSelfUpload = hasProfileImage;
    setBuilder({
      mode: wantsSelfUpload ? "self-upload" : "stock",
      entryFlow: "remix",
    });
  };

  const openTurnUp = () => {
    if (!factTemplateReady) return;
    // Legendary-own-stock: preserve the current meme's name + pronouns and
    // open the builder in self-upload mode so the legendary stylize toggle
    // is visible (per Phase-3 behaviorMatrix). The user's preferences carry
    // through automatically via viewerContext; the explicit initial values
    // come from the meme being viewed.
    setBuilder({
      mode: "self-upload",
      entryFlow: "remix",
      initialName: meme.createdByName ?? user?.displayName ?? undefined,
      initialPronouns: user?.pronouns ?? undefined,
    });
  };

  const openAnonSeeWithName = (args: { initialName?: string; initialPronouns?: string }) => {
    if (!factTemplateReady) return;
    setBuilder({
      mode: "stock",
      entryFlow: "cold-permalink",
      initialStockImageId,
      initialName: args.initialName,
      initialPronouns: args.initialPronouns,
    });
  };

  const handleAnonSignup = () => {
    window.location.href = `/api/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  let ctaBar: React.ReactNode = null;
  switch (cell) {
    case "anon-other":
      ctaBar = (
        <CTABarAnonOther
          onOpenBuilder={openAnonSeeWithName}
          factTemplateReady={factTemplateReady}
        />
      );
      break;
    case "anon-own-transient":
      ctaBar = <CTABarAnonOwnTransient onSignup={handleAnonSignup} onDownload={handleDownload} />;
      break;
    case "registered-own":
      ctaBar = (
        <CTABarRegisteredOwn
          onDownload={handleDownload}
          onCustomShare={handleCustomShare}
          wearHref={wearHref}
          legendaryUpsellSubject={legendaryUpsellSubject}
        />
      );
      break;
    case "registered-other":
      ctaBar = (
        <CTABarRegisteredOther
          onMakeAboutMe={openMakeAboutMe}
          legendaryUpsellSubject={legendaryUpsellSubject}
          factTemplateReady={factTemplateReady}
        />
      );
      break;
    case "legendary-own-stock":
      ctaBar = (
        <CTABarLegendaryOwnStock
          onTurnUp={openTurnUp}
          onDownload={handleDownload}
          onCustomShare={handleCustomShare}
          wearHref={wearHref}
          factTemplateReady={factTemplateReady}
        />
      );
      break;
    case "legendary-own-pulid":
      ctaBar = (
        <CTABarLegendaryOwnPulid
          onDownload={handleDownload}
          onCustomShare={handleCustomShare}
          wearHref={wearHref}
        />
      );
      break;
    case "legendary-other":
      ctaBar = (
        <CTABarLegendaryOther
          onMakeAboutMe={openMakeAboutMe}
          factTemplateReady={factTemplateReady}
        />
      );
      break;
  }

  return (
    <Layout>
      {/* ── Mobile layout ─────────────────────────────────── */}
      <div className="md:hidden px-4 pt-4 pb-10">
        <div className="flex items-center gap-3 mb-4">
          <span
            data-testid="saved-chip"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.12em] font-display uppercase border border-green-500/30"
          >
            ✓ Saved
          </span>
          <span className="text-[11px] text-muted-foreground" data-testid="dims-meta">
            {meme.originalWidth && meme.originalHeight
              ? `${meme.originalWidth}×${meme.originalHeight}`
              : <DimsFromUrl url={meme.imageUrl} />}{" "}
            · ready
          </span>
        </div>

        <div className="rounded-[20px] overflow-hidden mb-3 shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
          {meme.artifactType === "video" && meme.videoUrl ? (
            <video
              src={meme.videoUrl}
              autoPlay
              loop
              muted
              playsInline
              controls
              className="w-full object-cover"
            />
          ) : (
            <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" loading="eager" />
          )}
        </div>
        <div className="mb-5 flex items-center">
          <MemeHeartButton
            memeId={meme.id}
            initialHeartCount={meme.heartCount}
            initialViewerHasHearted={meme.viewerHasHearted}
          />
        </div>

        <div className="mb-3">
          <h2 className="font-display font-bold text-[18px] uppercase tracking-tight leading-tight">
            What&apos;s <span className="text-primary">next</span>?
          </h2>
        </div>
        {ctaBar}

        {meme.createdByName && (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Generated by <span className="text-primary font-bold">{meme.createdByName}</span>
          </p>
        )}

        {fact && (
          <div className="mt-4 text-center">
            <Link
              href={`/facts/${factId}`}
              className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              View full fact →
            </Link>
          </div>
        )}
      </div>

      {/* ── Desktop two-pane ──────────────────────────────── */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: "1fr 1fr", height: "calc(100vh - 64px)" }}
      >
        <div className="bg-secondary border-r border-border flex flex-col items-center justify-center p-12 overflow-auto">
          <div className="flex items-center gap-3 mb-5 self-start">
            <span
              data-testid="saved-chip-desktop"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.16em] font-display uppercase border border-green-500/30"
            >
              ✓ Saved
            </span>
            <span className="text-[12px] text-muted-foreground" data-testid="dims-meta-desktop">
              {meme.originalWidth && meme.originalHeight
                ? `${meme.originalWidth}×${meme.originalHeight}`
                : <DimsFromUrl url={meme.imageUrl} />}{" "}
              · ready to download
            </span>
          </div>

          <div className="w-full max-w-[520px] rounded-[24px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
            {meme.artifactType === "video" && meme.videoUrl ? (
              <video
                src={meme.videoUrl}
                autoPlay
                loop
                muted
                playsInline
                controls
                className="w-full object-cover"
              />
            ) : (
              <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" />
            )}
          </div>
          <div className="w-full max-w-[520px] mt-3 flex items-center">
            <MemeHeartButton
              memeId={meme.id}
              initialHeartCount={meme.heartCount}
              initialViewerHasHearted={meme.viewerHasHearted}
            />
          </div>

          <AdminMediaInfoForUrl
            url={meme.imageUrl}
            fileName={getFileNameFromUrl(meme.imageUrl)}
            fileSizeBytes={meme.uploadFileSizeBytes}
            mimeType={getMimeTypeFromUrl(meme.imageUrl)}
          />
        </div>

        <div className="p-14 overflow-auto flex flex-col">
          <Link
            href={factId ? `/facts/${factId}` : "/"}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm mb-8 transition-colors self-start"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Fact
          </Link>

          <h1 className="font-display font-bold text-[42px] uppercase tracking-tight leading-[0.96] mb-2">
            What&apos;s <span className="text-primary">next</span>?
          </h1>
          <p className="text-[15px] text-muted-foreground mb-8 leading-relaxed">
            {meme.factText}
          </p>

          <div className="max-w-md w-full">{ctaBar}</div>

          {fact && (
            <Link
              href={`/facts/${factId}`}
              className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 self-start"
            >
              View full fact →
            </Link>
          )}
        </div>
      </div>

      <BuilderOverlay
        open={!!builder}
        onClose={() => setBuilder(null)}
        factId={meme.factId}
        factText={factTemplate}
        mode={builder?.mode ?? "stock"}
        entryFlow={builder?.entryFlow ?? "remix"}
        initialStockImageId={builder?.initialStockImageId}
        initialName={builder?.initialName}
        initialPronouns={builder?.initialPronouns}
      />

      <MemeShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        slug={slug}
        fallbackPermalink={`${typeof window !== "undefined" ? window.location.origin : ""}/m/${slug}`}
      />
    </Layout>
  );
}
